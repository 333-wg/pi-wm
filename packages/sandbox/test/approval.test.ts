import type { AgentRuntime } from "@wuming/orchestrator";
import { SessionOrchestrator, SqliteOrchestratorStore } from "@wuming/orchestrator";
import { describe, expect, it } from "vitest";
import { ApprovalBroker } from "../src/index.js";

const runtime: AgentRuntime = {
	async executeTurn() {
		return { items: [] };
	},
};

async function session(
	store: SqliteOrchestratorStore,
	options: {
		sandboxMode?: "read_only" | "workspace_write" | "unrestricted";
		approvalPolicy?: "always" | "on_risk" | "on_failure" | "never";
	} = {}
) {
	const orchestrator = new SessionOrchestrator(store, runtime, {
		clock: () => 100,
		idFactory: () => "session-1",
	});
	return orchestrator.createSession({
		principalId: "user-1",
		idempotencyKey: "create-1",
		workspaceId: "workspace-1",
		model: { provider: "test", id: "model" },
		thinkingLevel: "off",
		sandboxMode: options.sandboxMode ?? "workspace_write",
		approvalPolicy: options.approvalPolicy ?? "on_risk",
	});
}

async function pendingApproval(store: SqliteOrchestratorStore, sessionId: string) {
	for (let attempt = 0; attempt < 20; attempt += 1) {
		const approval = store.loadSnapshot(sessionId)?.pendingApprovals[0];
		if (approval) return approval;
		await Promise.resolve();
	}
	throw new Error("Approval was not persisted");
}

describe("ApprovalBroker", () => {
	it.each(["never", "on_risk", "on_failure"] as const)(
		"honors local full-access desktop consent under %s",
		async (approvalPolicy) => {
			const store = new SqliteOrchestratorStore(":memory:");
			try {
				const created = await session(store, { sandboxMode: "unrestricted", approvalPolicy });
				const broker = new ApprovalBroker({ store });
				expect(broker.hasFullAccessComputerUse(created.snapshot.session.id)).toBe(true);
				await expect(
					broker.authorize({
						sessionId: created.snapshot.session.id,
						toolCallId: "desktop-full",
						risk: "high",
						summary: "Desktop",
						requireExplicitApproval: true,
						fullAccessComputerUse: true,
						capabilities: [{ type: "computer.use", action: "input" }],
					})
				).resolves.toBeUndefined();
				expect(store.loadSnapshot(created.snapshot.session.id)?.pendingApprovals).toEqual([]);
			} finally {
				store.close();
			}
		}
	);
	it("does not extend the full-access desktop exception to other explicit permissions", async () => {
		const store = new SqliteOrchestratorStore(":memory:");
		try {
			const created = await session(store, { sandboxMode: "unrestricted", approvalPolicy: "never" });
			const broker = new ApprovalBroker({ store });
			await expect(
				broker.authorize({
					sessionId: created.snapshot.session.id,
					toolCallId: "not-desktop",
					risk: "high",
					summary: "Other",
					requireExplicitApproval: true,
					fullAccessComputerUse: true,
					capabilities: [{ type: "filesystem.read", paths: ["private"] }],
				})
			).rejects.toThrow();
		} finally {
			store.close();
		}
	});
	it("full-access desktop still respects always-ask mode", async () => {
		const store = new SqliteOrchestratorStore(":memory:");
		try {
			const created = await session(store, { sandboxMode: "unrestricted", approvalPolicy: "always" });
			const broker = new ApprovalBroker({ store });
			const abort = new AbortController();
			const pending = broker.authorize({
				sessionId: created.snapshot.session.id,
				toolCallId: "desktop-always",
				risk: "high",
				summary: "Desktop",
				requireExplicitApproval: true,
				fullAccessComputerUse: true,
				signal: abort.signal,
				capabilities: [{ type: "computer.use", action: "input" }],
			});
			const rejected = expect(pending).rejects.toThrow();
			await pendingApproval(store, created.snapshot.session.id);
			abort.abort();
			await rejected;
		} finally {
			store.close();
		}
	});
	it.each(["on_risk", "never", "on_failure"] as const)(
		"honors the explicit desktop Settings grant under %s",
		async (approvalPolicy) => {
			const store = new SqliteOrchestratorStore(":memory:");
			try {
				const created = await session(store, { approvalPolicy });
				const broker = new ApprovalBroker({ store });
				await expect(
					broker.authorize({
						sessionId: created.snapshot.session.id,
						toolCallId: "desktop",
						risk: "high",
						summary: "Desktop",
						preauthorizedComputerUse: true,
						capabilities: [{ type: "computer.use", action: "input" }],
					})
				).resolves.toBeUndefined();
				expect(store.loadSnapshot(created.snapshot.session.id)?.pendingApprovals).toEqual([]);
			} finally {
				store.close();
			}
		}
	);
	it("does not let Settings authorization override read-only restrictions", async () => {
		const store = new SqliteOrchestratorStore(":memory:");
		try {
			const created = await session(store, { sandboxMode: "read_only" });
			const broker = new ApprovalBroker({ store });
			await expect(
				broker.authorize({
					sessionId: created.snapshot.session.id,
					toolCallId: "desktop",
					risk: "high",
					summary: "Desktop",
					preauthorizedComputerUse: true,
					capabilities: [{ type: "computer.use", action: "input" }],
				})
			).rejects.toThrow("exceeds sandbox mode");
		} finally {
			store.close();
		}
	});
	it.each(["always", "mixed"] as const)("retains approval for %s even with a Settings desktop grant", async (mode) => {
		const store = new SqliteOrchestratorStore(":memory:");
		try {
			const created = await session(store, { approvalPolicy: mode === "always" ? "always" : "on_risk" });
			const broker = new ApprovalBroker({ store });
			const abort = new AbortController();
			const request = broker.authorize({
				sessionId: created.snapshot.session.id,
				toolCallId: "desktop",
				risk: "high",
				summary: "Desktop",
				preauthorizedComputerUse: true,
				signal: abort.signal,
				capabilities:
					mode === "always"
						? [{ type: "computer.use", action: "input" }]
						: [
								{ type: "computer.use", action: "input" },
								{ type: "filesystem.write", paths: ["test.txt"] },
							],
			});
			const rejected = expect(request).rejects.toThrow();
			await pendingApproval(store, created.snapshot.session.id);
			abort.abort();
			await rejected;
		} finally {
			store.close();
		}
	});
	it.each(["never", "on_failure"] as const)(
		"does not bypass desktop consent under %s, even in unrestricted mode",
		async (approvalPolicy) => {
			const store = new SqliteOrchestratorStore(":memory:");
			try {
				const created = await session(store, { sandboxMode: "unrestricted", approvalPolicy });
				const broker = new ApprovalBroker({ store });
				await expect(
					broker.authorize({
						sessionId: created.snapshot.session.id,
						toolCallId: "desktop",
						risk: "high",
						summary: "Desktop",
						requireExplicitApproval: true,
						capabilities: [{ type: "computer.use", action: "input" }],
					})
				).rejects.toThrow("Computer Use requires human approval");
			} finally {
				store.close();
			}
		}
	);
	it("rejects desktop input in read-only mode but permits explicitly approved capture", async () => {
		const store = new SqliteOrchestratorStore(":memory:");
		try {
			const created = await session(store, { sandboxMode: "read_only" });
			const broker = new ApprovalBroker({ store });
			const base = {
				sessionId: created.snapshot.session.id,
				toolCallId: "desktop",
				risk: "medium" as const,
				summary: "Desktop",
				requireExplicitApproval: true,
			};
			await expect(
				broker.authorize({ ...base, capabilities: [{ type: "computer.use", action: "input" }] })
			).rejects.toThrow("exceeds sandbox mode");
			const pending = broker.authorize({ ...base, capabilities: [{ type: "computer.use", action: "screenshot" }] });
			const approval = await pendingApproval(store, created.snapshot.session.id);
			await broker.respond({
				principalId: "user-1",
				idempotencyKey: "desktop-approved",
				sessionId: created.snapshot.session.id,
				approvalId: approval.id,
				decision: "approve",
			});
			const permit = await pending;
			expect(permit?.approvalId).toBe(approval.id);
			broker.completeAuthorization(permit!);
		} finally {
			store.close();
		}
	});
	it.each(["never", "on_failure"] as const)("refuses sensitive source inspection under %s", async (approvalPolicy) => {
		const store = new SqliteOrchestratorStore(":memory:");
		try {
			const created = await session(store, { approvalPolicy });
			const broker = new ApprovalBroker({ store });
			await expect(
				broker.authorize({
					sessionId: created.snapshot.session.id,
					toolCallId: "inspect",
					risk: "low",
					summary: "Inspect source",
					capabilities: [{ type: "filesystem.read", paths: ["SKILL.md"] }],
					requireExplicitApproval: true,
				})
			).rejects.toMatchObject({ code: "approval_denied" });
			expect(store.loadSnapshot(created.snapshot.session.id)?.pendingApprovals).toEqual([]);
		} finally {
			store.close();
		}
	});

	it("requires a human decision for sensitive low-risk reads and consumes the permit", async () => {
		const store = new SqliteOrchestratorStore(":memory:");
		try {
			const created = await session(store, { approvalPolicy: "on_risk" });
			const broker = new ApprovalBroker({ store });
			const pending = broker.authorize({
				sessionId: created.snapshot.session.id,
				toolCallId: "inspect",
				risk: "low",
				summary: "Inspect source",
				capabilities: [{ type: "filesystem.read", paths: ["SKILL.md"] }],
				requireExplicitApproval: true,
			});
			const approval = await pendingApproval(store, created.snapshot.session.id);
			await broker.respond({
				principalId: "user-1",
				idempotencyKey: "inspect-decision",
				sessionId: created.snapshot.session.id,
				approvalId: approval.id,
				decision: "approve",
			});
			const permit = await pending;
			expect(permit).toEqual({ approvalId: approval.id });
			broker.completeAuthorization(permit!);
		} finally {
			store.close();
		}
	});

	it("auto-authorizes low-risk reads under on_risk", async () => {
		const store = new SqliteOrchestratorStore(":memory:");
		const created = await session(store);
		const broker = new ApprovalBroker({ store });
		await broker.authorize({
			sessionId: created.snapshot.session.id,
			toolCallId: "read-1",
			risk: "low",
			summary: "Read README.md",
			capabilities: [{ type: "filesystem.read", paths: ["README.md"] }],
		});
		expect(store.loadSnapshot(created.snapshot.session.id)?.pendingApprovals).toEqual([]);
		store.close();
	});

	it("does not re-prompt full access sessions for risky tools", async () => {
		const store = new SqliteOrchestratorStore(":memory:");
		try {
			const created = await session(store, {
				sandboxMode: "unrestricted",
				approvalPolicy: "on_risk",
			});
			const broker = new ApprovalBroker({ store });
			await broker.authorize({
				sessionId: created.snapshot.session.id,
				toolCallId: "exec-1",
				risk: "high",
				summary: "Run local command",
				capabilities: [{ type: "process.exec", executable: "cmd.exe", args: ["/c", "npm test"] }],
			});
			expect(store.loadSnapshot(created.snapshot.session.id)?.pendingApprovals).toEqual([]);
		} finally {
			store.close();
		}
	});

	it("persists, settles, resumes, and deduplicates an approved write", async () => {
		const store = new SqliteOrchestratorStore(":memory:");
		const created = await session(store);
		let nextId = 0;
		const broker = new ApprovalBroker({
			store,
			clock: () => 200,
			idFactory: () => `approval-${++nextId}`,
		});
		const authorization = broker.authorize({
			sessionId: created.snapshot.session.id,
			toolCallId: "write-1",
			risk: "medium",
			summary: "Write src/index.ts",
			capabilities: [{ type: "filesystem.write", paths: ["src/index.ts"] }],
		});
		const approval = await pendingApproval(store, created.snapshot.session.id);
		const response = {
			principalId: "user-1",
			idempotencyKey: "decision-1",
			sessionId: created.snapshot.session.id,
			approvalId: approval.id,
			decision: "approve" as const,
		};
		const first = await broker.respond(response);
		const permit = await authorization;
		expect(permit).toEqual({ approvalId: approval.id });
		broker.completeAuthorization(permit!);
		expect(first.approval.status).toBe("approved");
		expect(store.loadSnapshot(created.snapshot.session.id)?.pendingApprovals).toEqual([]);
		await expect(broker.respond(response)).resolves.toEqual(first);
		store.close();
	});

	it("does not let approval override a read-only sandbox", async () => {
		const store = new SqliteOrchestratorStore(":memory:");
		const created = await session(store, { sandboxMode: "read_only", approvalPolicy: "always" });
		const broker = new ApprovalBroker({ store });
		await expect(
			broker.authorize({
				sessionId: created.snapshot.session.id,
				toolCallId: "write-1",
				risk: "high",
				summary: "Write outside policy",
				capabilities: [{ type: "filesystem.write", paths: ["file.txt"] }],
			})
		).rejects.toMatchObject({ code: "approval_denied" });
		expect(store.loadSnapshot(created.snapshot.session.id)?.pendingApprovals).toEqual([]);
		store.close();
	});

	it("allows only deployment-trusted read-only MCP calls in a read-only sandbox", async () => {
		const store = new SqliteOrchestratorStore(":memory:");
		const created = await session(store, { sandboxMode: "read_only", approvalPolicy: "never" });
		const broker = new ApprovalBroker({ store });
		await expect(
			broker.authorize({
				sessionId: created.snapshot.session.id,
				toolCallId: "mcp-read-1",
				risk: "low",
				summary: "Read documentation",
				capabilities: [{ type: "mcp.call", serverId: "docs", toolName: "search", readOnly: true }],
			})
		).resolves.toBeUndefined();
		await expect(
			broker.authorize({
				sessionId: created.snapshot.session.id,
				toolCallId: "mcp-write-1",
				risk: "high",
				summary: "Mutate external state",
				capabilities: [{ type: "mcp.call", serverId: "database", toolName: "execute", readOnly: false }],
			})
		).rejects.toMatchObject({ code: "approval_denied" });
		store.close();
	});

	it("allows approval-gated read-only web access without permitting processes", async () => {
		const store = new SqliteOrchestratorStore(":memory:");
		const created = await session(store, { sandboxMode: "read_only", approvalPolicy: "never" });
		const broker = new ApprovalBroker({ store });
		await expect(
			broker.authorize({
				sessionId: created.snapshot.session.id,
				toolCallId: "fetch-1",
				risk: "low",
				summary: "Fetch documentation",
				capabilities: [{ type: "network.connect", hosts: ["example.com"] }],
			})
		).resolves.toBeUndefined();
		await expect(
			broker.authorize({
				sessionId: created.snapshot.session.id,
				toolCallId: "process-1",
				risk: "high",
				summary: "Run process",
				capabilities: [{ type: "process.exec", executable: "sh", args: [] }],
			})
		).rejects.toMatchObject({ code: "approval_denied" });
		store.close();
	});

	it("requests a one-shot retry approval after an on_failure operation error", async () => {
		const store = new SqliteOrchestratorStore(":memory:");
		const created = await session(store, { approvalPolicy: "on_failure" });
		const broker = new ApprovalBroker({ store, clock: () => 200 });
		const retry = broker.authorizeFailure({
			sessionId: created.snapshot.session.id,
			toolCallId: "bash-1",
			risk: "high",
			summary: "Run tests",
			capabilities: [{ type: "process.exec", executable: "/bin/sh", args: ["-lc", "npm test"] }],
			failure: "exit code 1",
		});
		const approval = await pendingApproval(store, created.snapshot.session.id);
		await broker.respond({
			principalId: "user-1",
			idempotencyKey: "retry-approval",
			sessionId: created.snapshot.session.id,
			approvalId: approval.id,
			decision: "approve",
		});
		const permit = await retry;
		broker.completeAuthorization(permit);
		store.close();
	});
});
