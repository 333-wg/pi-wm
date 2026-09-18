import { createHash, randomUUID } from "node:crypto";
import { reduceSessionEvent, type SessionEvent } from "@wuming/domain";
import type { SqliteOrchestratorStore } from "@wuming/orchestrator";
import type { ApprovalRequest, ApprovalStatus, CommandResult, SessionSnapshot, ToolCapability } from "@wuming/protocol";
import { SandboxError } from "./errors.js";

export interface ApprovalBrokerOptions {
	store: SqliteOrchestratorStore;
	clock?: () => number;
	idFactory?: () => string;
	defaultTimeoutMs?: number;
	idempotencyTtlMs?: number;
	onRecoveredDecision?: (approval: ApprovalRequest) => void | Promise<void>;
}

export interface ApprovalAuthorization {
	/** Sensitive inspection must never inherit automatic read authorization. */
	requireExplicitApproval?: boolean;
	/** Explicit desktop Settings grant; never applies to other capabilities. */
	preauthorizedComputerUse?: boolean;
	/** Local-owner desktop tools may honor the user's full-access session mode. */
	fullAccessComputerUse?: boolean;
	sessionId: string;
	toolCallId: string;
	risk: ApprovalRequest["risk"];
	summary: string;
	capabilities: ToolCapability[];
	signal?: AbortSignal;
}

interface PendingDecision {
	resolve: (status: ApprovalStatus) => void;
	timer: ReturnType<typeof setTimeout>;
	abort?: () => void;
	signal?: AbortSignal;
	recovered: boolean;
}

export interface ApprovalPermit {
	approvalId: string;
}

function decisionHash(sessionId: string, approvalId: string, decision: "approve" | "deny"): string {
	return createHash("sha256").update(`${sessionId}\0${approvalId}\0${decision}`).digest("hex");
}

function capabilityAllowed(snapshot: SessionSnapshot, capability: ToolCapability): boolean {
	if (snapshot.sandboxMode === "unrestricted") return true;
	if (snapshot.sandboxMode === "read_only") {
		return (
			(capability.type === "computer.use" && capability.action === "screenshot") ||
			capability.type === "filesystem.read" ||
			capability.type === "network.connect" ||
			capability.type === "secret.use" ||
			(capability.type === "mcp.call" && capability.readOnly)
		);
	}
	return (
		capability.type === "computer.use" ||
		capability.type === "filesystem.read" ||
		capability.type === "filesystem.write" ||
		capability.type === "process.exec" ||
		capability.type === "network.connect" ||
		capability.type === "secret.use" ||
		capability.type === "mcp.call" ||
		capability.type === "mcp.manage" ||
		capability.type === "skill.manage"
	);
}

function requiresApproval(snapshot: SessionSnapshot, request: ApprovalAuthorization): boolean {
	if (request.requireExplicitApproval) return true;
	if (
		request.preauthorizedComputerUse &&
		snapshot.approvalPolicy !== "always" &&
		request.capabilities.length > 0 &&
		request.capabilities.every((capability) => capability.type === "computer.use")
	)
		return false;
	// Full access is the user's explicit decision to let the agent operate in the
	// existing environment. Keep the explicit "always ask" policy meaningful,
	// but do not re-prompt for ordinary risky tools in this mode.
	if (snapshot.sandboxMode === "unrestricted" && snapshot.approvalPolicy !== "always") return false;
	switch (snapshot.approvalPolicy) {
		case "always":
			return true;
		case "on_risk":
			return request.risk !== "low" || request.capabilities.some((capability) => capability.type !== "filesystem.read");
		case "on_failure":
		case "never":
			return false;
	}
}

export class ApprovalBroker {
	readonly #store: SqliteOrchestratorStore;
	readonly #clock: () => number;
	readonly #idFactory: () => string;
	readonly #defaultTimeoutMs: number;
	readonly #idempotencyTtlMs: number;
	readonly #onRecoveredDecision: ((approval: ApprovalRequest) => void | Promise<void>) | undefined;
	readonly #pending = new Map<string, PendingDecision>();
	readonly #tails = new Map<string, Promise<void>>();

	constructor(options: ApprovalBrokerOptions) {
		this.#store = options.store;
		this.#clock = options.clock ?? Date.now;
		this.#idFactory = options.idFactory ?? randomUUID;
		this.#defaultTimeoutMs = options.defaultTimeoutMs ?? 5 * 60_000;
		this.#idempotencyTtlMs = options.idempotencyTtlMs ?? 24 * 60 * 60_000;
		this.#onRecoveredDecision = options.onRecoveredDecision;
		this.#store.subscribeEvents(({ event }) => {
			if (event.type !== "approval.settled") return;
			this.#resolvePending(event.approval.id, event.approval.status);
			this.#clearPending(event.approval.id);
		});
	}

	async #serialize<T>(sessionId: string, action: () => T | Promise<T>): Promise<T> {
		const previous = this.#tails.get(sessionId) ?? Promise.resolve();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const tail = previous.then(() => gate);
		this.#tails.set(sessionId, tail);
		await previous;
		try {
			return await action();
		} finally {
			release();
			if (this.#tails.get(sessionId) === tail) this.#tails.delete(sessionId);
		}
	}

	hasFullAccessComputerUse(sessionId: string): boolean {
		const snapshot = this.#store.loadSnapshot(sessionId);
		return snapshot?.sandboxMode === "unrestricted" && snapshot.approvalPolicy !== "always";
	}

	async authorize(request: ApprovalAuthorization): Promise<ApprovalPermit | undefined> {
		const snapshot = this.#store.loadSnapshot(request.sessionId);
		if (!snapshot) throw new SandboxError("approval_denied", `Session ${request.sessionId} does not exist`);
		// Read current permissions from the store. Cached tool definitions must not
		// turn a previous full-access choice into a permanent grant.
		if (
			request.fullAccessComputerUse &&
			snapshot.sandboxMode === "unrestricted" &&
			snapshot.approvalPolicy !== "always" &&
			request.capabilities.length > 0 &&
			request.capabilities.every((capability) => capability.type === "computer.use")
		)
			request = { ...request, requireExplicitApproval: false, preauthorizedComputerUse: true };
		if (
			request.requireExplicitApproval &&
			(snapshot.approvalPolicy === "never" || snapshot.approvalPolicy === "on_failure")
		) {
			throw new SandboxError(
				"approval_denied",
				request.capabilities.some((capability) => capability.type === "computer.use")
					? "Computer Use requires human approval. Select an approval-enabled permission mode before using desktop tools."
					: "Skill source inspection requires human approval. Use an approval-enabled session to review or edit source; use skill_load for invocation. Do not read another copy to bypass this restriction."
			);
		}
		for (const capability of request.capabilities) {
			if (!capabilityAllowed(snapshot, capability)) {
				throw new SandboxError(
					"approval_denied",
					`Capability ${capability.type} exceeds sandbox mode ${snapshot.sandboxMode}`
				);
			}
		}
		const restored = this.#claimApproved(request.sessionId, request.toolCallId);
		if (restored) return restored;
		if (!requiresApproval(snapshot, request)) return undefined;
		const status = await this.#requestDecision(snapshot, request, "preflight");
		if (status !== "approved") throw new SandboxError("approval_denied", `Tool execution was ${status}`);
		const permit = this.#claimApproved(request.sessionId, request.toolCallId);
		if (!permit) throw new SandboxError("approval_denied", "Approved tool execution could not be claimed");
		return permit;
	}

	async authorizeFailure(request: ApprovalAuthorization & { failure: string }): Promise<ApprovalPermit> {
		const snapshot = this.#store.loadSnapshot(request.sessionId);
		if (!snapshot) throw new SandboxError("approval_denied", `Session ${request.sessionId} does not exist`);
		for (const capability of request.capabilities) {
			if (!capabilityAllowed(snapshot, capability)) {
				throw new SandboxError(
					"approval_denied",
					`Capability ${capability.type} exceeds sandbox mode ${snapshot.sandboxMode}`
				);
			}
		}
		if (snapshot.approvalPolicy !== "on_failure") throw new SandboxError("process_failed", request.failure);
		const status = await this.#requestDecision(
			snapshot,
			{
				...request,
				summary: `${request.summary} failed: ${request.failure}. Approve one retry?`.slice(0, 2000),
			},
			"failure_retry"
		);
		if (status !== "approved") throw new SandboxError("approval_denied", `Retry was ${status}`);
		const permit = this.#claimApproved(request.sessionId, request.toolCallId);
		if (!permit) throw new SandboxError("approval_denied", "Approved retry could not be claimed");
		return permit;
	}

	completeAuthorization(permit: ApprovalPermit): void {
		if (!this.#store.completeApprovalExecution(permit.approvalId, this.#clock())) {
			throw new SandboxError("approval_denied", `Approval ${permit.approvalId} is not executing`);
		}
	}

	recoverPendingApprovals(): number {
		let recovered = 0;
		const now = this.#clock();
		for (const operation of this.#store.listOperationsByStatus("running")) {
			const snapshot = this.#store.loadSnapshot(operation.sessionId);
			if (!snapshot) continue;
			for (const approval of snapshot.pendingApprovals) {
				const execution = this.#store.getApprovalExecution(approval.id);
				if (
					!execution ||
					execution.operationId !== operation.id ||
					execution.state !== "waiting" ||
					this.#pending.has(approval.id)
				)
					continue;
				const remaining = approval.expiresAt - now;
				const timer = setTimeout(
					() => void this.#settleSystem(approval.sessionId, approval.id, "expired"),
					Math.max(0, remaining)
				);
				this.#pending.set(approval.id, { resolve: () => {}, timer, recovered: true });
				recovered += 1;
			}
		}
		return recovered;
	}

	#claimApproved(sessionId: string, toolCallId: string): ApprovalPermit | undefined {
		const claimed = this.#store.claimApprovedApprovalExecution(sessionId, toolCallId, this.#clock());
		return claimed ? { approvalId: claimed.approvalId } : undefined;
	}

	async #requestDecision(
		snapshot: SessionSnapshot,
		authorization: ApprovalAuthorization,
		mode: "preflight" | "failure_retry"
	): Promise<ApprovalStatus> {
		const now = this.#clock();
		const approval: ApprovalRequest = {
			id: this.#idFactory(),
			sessionId: snapshot.session.id,
			workspaceId: snapshot.session.workspaceId,
			toolCallId: authorization.toolCallId,
			risk: authorization.risk,
			summary: authorization.summary,
			capabilities: authorization.capabilities,
			status: "pending",
			createdAt: now,
			expiresAt: now + this.#defaultTimeoutMs,
		};
		let resolveDecision!: (status: ApprovalStatus) => void;
		const decision = new Promise<ApprovalStatus>((resolve) => {
			resolveDecision = resolve;
		});
		const timer = setTimeout(
			() => void this.#settleSystem(approval.sessionId, approval.id, "expired"),
			this.#defaultTimeoutMs
		);
		const abort = authorization.signal
			? () => void this.#settleSystem(approval.sessionId, approval.id, "cancelled")
			: undefined;
		if (abort) authorization.signal?.addEventListener("abort", abort, { once: true });
		this.#pending.set(approval.id, {
			resolve: resolveDecision,
			timer,
			recovered: false,
			...(abort ? { abort } : {}),
			...(authorization.signal ? { signal: authorization.signal } : {}),
		});

		try {
			await this.#serialize(approval.sessionId, () => {
				const current = this.#store.loadSnapshot(approval.sessionId);
				if (!current) throw new SandboxError("approval_denied", `Session ${approval.sessionId} does not exist`);
				const event: SessionEvent = {
					type: "approval.requested",
					eventId: this.#idFactory(),
					sessionId: approval.sessionId,
					revision: current.revision + 1,
					timestamp: now,
					approval,
				};
				const phaseEvent: SessionEvent = {
					type: "session.phase.changed",
					eventId: this.#idFactory(),
					sessionId: approval.sessionId,
					revision: current.revision + 2,
					timestamp: now,
					phase: "awaiting_approval",
				};
				const afterApproval = reduceSessionEvent(current, event);
				const next = reduceSessionEvent(afterApproval, phaseEvent);
				const operation = this.#store.getRunningOperation(approval.sessionId);
				this.#store.commitMutation({
					sessionId: approval.sessionId,
					expectedRevision: current.revision,
					events: [event, phaseEvent],
					snapshot: next,
					approvalExecution: {
						approvalId: approval.id,
						sessionId: approval.sessionId,
						...(operation ? { operationId: operation.id } : {}),
						toolCallId: approval.toolCallId,
						mode,
						state: "waiting",
						createdAt: now,
						updatedAt: now,
					},
				});
			});
		} catch (error) {
			this.#clearPending(approval.id);
			throw error;
		}
		return decision.finally(() => this.#clearPending(approval.id));
	}

	async respond(input: {
		principalId: string;
		idempotencyKey: string;
		sessionId: string;
		approvalId: string;
		decision: "approve" | "deny";
	}): Promise<Extract<CommandResult, { type: "approval.accepted" }>> {
		const now = this.#clock();
		const hash = decisionHash(input.sessionId, input.approvalId, input.decision);
		const existing = this.#store.getIdempotencyResult(input.principalId, input.idempotencyKey, hash, now);
		if (existing) return existing as Extract<CommandResult, { type: "approval.accepted" }>;
		return this.#serialize(input.sessionId, async () => {
			const snapshot = this.#store.loadSnapshot(input.sessionId);
			if (!snapshot) throw new SandboxError("approval_denied", `Session ${input.sessionId} does not exist`);
			const pending = snapshot.pendingApprovals.find((approval) => approval.id === input.approvalId);
			if (!pending) throw new SandboxError("approval_denied", `Approval ${input.approvalId} is not pending`);
			if (pending.expiresAt <= now) throw new SandboxError("approval_denied", `Approval ${input.approvalId} expired`);
			const approval: ApprovalRequest = {
				...pending,
				status: input.decision === "approve" ? "approved" : "denied",
				decidedAt: now,
				decidedBy: input.principalId,
			};
			const event: SessionEvent = {
				type: "approval.settled",
				eventId: this.#idFactory(),
				sessionId: input.sessionId,
				revision: snapshot.revision + 1,
				timestamp: now,
				approval,
			};
			const afterApproval = reduceSessionEvent(snapshot, event);
			const phaseEvent: SessionEvent | undefined =
				afterApproval.pendingApprovals.length === 0
					? {
							type: "session.phase.changed",
							eventId: this.#idFactory(),
							sessionId: input.sessionId,
							revision: snapshot.revision + 2,
							timestamp: now,
							phase: "turn",
						}
					: undefined;
			const events = phaseEvent ? [event, phaseEvent] : [event];
			const next = phaseEvent ? reduceSessionEvent(afterApproval, phaseEvent) : afterApproval;
			const result = { type: "approval.accepted", approval } as const;
			const pendingDecision = this.#pending.get(approval.id);
			const committed = this.#store.commitMutation({
				sessionId: input.sessionId,
				expectedRevision: snapshot.revision,
				events,
				snapshot: next,
				settleApprovalExecution: {
					approvalId: approval.id,
					state: input.decision === "approve" ? "approved" : "cancelled",
				},
				idempotency: {
					principalId: input.principalId,
					key: input.idempotencyKey,
					commandHash: hash,
					result,
					expiresAt: now + this.#idempotencyTtlMs,
				},
			});
			this.#resolvePending(approval.id, approval.status);
			if (pendingDecision?.recovered) {
				this.#clearPending(approval.id);
				await this.#onRecoveredDecision?.(approval);
			}
			return committed.result as Extract<CommandResult, { type: "approval.accepted" }>;
		});
	}

	async #settleSystem(sessionId: string, approvalId: string, status: "expired" | "cancelled"): Promise<void> {
		try {
			await this.#serialize(sessionId, async () => {
				const snapshot = this.#store.loadSnapshot(sessionId);
				const pending = snapshot?.pendingApprovals.find((approval) => approval.id === approvalId);
				if (!snapshot || !pending) return;
				const now = this.#clock();
				const approval: ApprovalRequest = {
					...pending,
					status,
					decidedAt: now,
					decidedBy: "system",
				};
				const event: SessionEvent = {
					type: "approval.settled",
					eventId: this.#idFactory(),
					sessionId,
					revision: snapshot.revision + 1,
					timestamp: now,
					approval,
				};
				const afterApproval = reduceSessionEvent(snapshot, event);
				const phaseEvent: SessionEvent | undefined =
					afterApproval.pendingApprovals.length === 0
						? {
								type: "session.phase.changed",
								eventId: this.#idFactory(),
								sessionId,
								revision: snapshot.revision + 2,
								timestamp: now,
								phase: "turn",
							}
						: undefined;
				const next = phaseEvent ? reduceSessionEvent(afterApproval, phaseEvent) : afterApproval;
				const pendingDecision = this.#pending.get(approvalId);
				this.#store.commitMutation({
					sessionId,
					expectedRevision: snapshot.revision,
					events: phaseEvent ? [event, phaseEvent] : [event],
					snapshot: next,
					settleApprovalExecution: { approvalId, state: "cancelled" },
				});
				this.#resolvePending(approvalId, status);
				if (pendingDecision?.recovered) {
					this.#clearPending(approvalId);
					await this.#onRecoveredDecision?.(approval);
				}
			});
		} catch {
			this.#resolvePending(approvalId, status);
		}
	}

	#resolvePending(approvalId: string, status: ApprovalStatus): void {
		this.#pending.get(approvalId)?.resolve(status);
	}

	#clearPending(approvalId: string): void {
		const pending = this.#pending.get(approvalId);
		if (!pending) return;
		clearTimeout(pending.timer);
		if (pending.abort) pending.signal?.removeEventListener("abort", pending.abort);
		this.#pending.delete(approvalId);
	}
}
