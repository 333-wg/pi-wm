import { normalizeCapabilityManifest, verifyCapabilityPlan } from "./registry.js";
import type {
	CapabilityManifest,
	HookAuditRecord,
	HookDispatchInput,
	HookDispatchResult,
	HookHandler,
	HookHandlerResult,
	HookInvocation,
	HookRegistration,
} from "./types.js";

interface RegisteredHook {
	manifest: CapabilityManifest & { kind: "hook"; hook: NonNullable<CapabilityManifest["hook"]> };
	handler: HookHandler;
	disposed: boolean;
}

type HookExecution =
	| { type: "result"; result: void | HookHandlerResult }
	| { type: "error"; error: unknown }
	| { type: "timeout" }
	| { type: "aborted" };

const MAX_ANNOTATION_BYTES = 16 * 1024;
const MAX_REASON_LENGTH = 1000;

function cloneJson<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function canonicalize(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
		.join(",")}}`;
}

function deepFreeze<T>(value: T): T {
	if (value && typeof value === "object" && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
	}
	return value;
}

function errorMessage(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).slice(0, MAX_REASON_LENGTH);
}

function validateResult(result: void | HookHandlerResult): HookHandlerResult {
	if (result === undefined) return {};
	if (!result || typeof result !== "object" || Array.isArray(result))
		throw new Error("Hook returned an invalid result");
	if (result.decision !== undefined && result.decision !== "continue" && result.decision !== "deny")
		throw new Error("Hook returned an invalid decision");
	if (result.code !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(result.code))
		throw new Error("Hook returned an invalid code");
	if (result.reason !== undefined && (typeof result.reason !== "string" || result.reason.length > MAX_REASON_LENGTH))
		throw new Error("Hook returned an invalid reason");
	if (result.decision === "deny" && !result.reason?.trim()) throw new Error("A denying hook must provide a reason");
	if (result.annotations !== undefined) {
		const serialized = JSON.stringify(result.annotations);
		if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > MAX_ANNOTATION_BYTES)
			throw new Error("Hook annotations exceed 16 KiB");
		cloneJson(result.annotations);
	}
	return result;
}

function hookManifest(input: CapabilityManifest): RegisteredHook["manifest"] {
	const manifest = normalizeCapabilityManifest(input);
	if (manifest.kind !== "hook" || !manifest.hook)
		throw new Error(`Hook registration ${input.id} requires a hook capability manifest`);
	return manifest as RegisteredHook["manifest"];
}

async function executeHook(
	registration: RegisteredHook,
	invocation: Omit<HookInvocation, "signal">,
	signal: AbortSignal
): Promise<HookExecution> {
	if (signal.aborted) return { type: "aborted" };
	const controller = new AbortController();
	const abort = () => controller.abort(signal.reason);
	signal.addEventListener("abort", abort, { once: true });
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const execution = Promise.resolve()
			.then(() =>
				registration.handler(
					Object.freeze({
						...cloneJson(invocation),
						data: deepFreeze(cloneJson(invocation.data)),
						signal: controller.signal,
					})
				)
			)
			.then(
				(result): HookExecution => ({ type: "result", result }),
				(error: unknown): HookExecution => ({ type: "error", error })
			);
		const timeout = new Promise<HookExecution>((resolve) => {
			timer = setTimeout(() => {
				controller.abort(new Error("Hook timed out"));
				resolve({ type: "timeout" });
			}, registration.manifest.hook.timeoutMs ?? 5000);
		});
		const aborted = new Promise<HookExecution>((resolve) => {
			controller.signal.addEventListener(
				"abort",
				() => {
					if (signal.aborted) resolve({ type: "aborted" });
				},
				{ once: true }
			);
		});
		return await Promise.race([execution, timeout, aborted]);
	} finally {
		if (timer) clearTimeout(timer);
		signal.removeEventListener("abort", abort);
	}
}

export class HookPipeline {
	readonly #clock: () => number;
	readonly #registrations = new Map<string, RegisteredHook[]>();

	constructor(options: { clock?: () => number } = {}) {
		this.#clock = options.clock ?? Date.now;
	}

	register(manifestInput: CapabilityManifest, handler: HookHandler): HookRegistration {
		const manifest = hookManifest(manifestInput);
		const entry: RegisteredHook = { manifest, handler, disposed: false };
		const registrations = this.#registrations.get(manifest.id) ?? [];
		registrations.push(entry);
		this.#registrations.set(manifest.id, registrations);
		return {
			id: manifest.id,
			get disposed() {
				return entry.disposed;
			},
			dispose: () => {
				entry.disposed = true;
			},
		};
	}

	async dispatch(input: HookDispatchInput): Promise<HookDispatchResult> {
		if (input.signal.aborted) throw input.signal.reason;
		if (!verifyCapabilityPlan(input.plan)) throw new Error("Hook dispatch requires a verifiable capability plan");
		if (
			input.plan.context.sessionId !== input.sessionId ||
			(input.plan.context.turnId !== undefined && input.plan.context.turnId !== input.operationId)
		) {
			throw new Error("Hook dispatch context does not match the capability plan");
		}
		const records: HookAuditRecord[] = [];
		const selected = input.plan.capabilities.filter(
			(manifest) => manifest.kind === "hook" && manifest.hook?.points.includes(input.point)
		);
		for (const manifest of selected) {
			const startedAt = this.#clock();
			const registration = [...(this.#registrations.get(manifest.id) ?? [])]
				.reverse()
				.find((candidate) => !candidate.disposed);
			if (!registration || canonicalize(registration.manifest) !== canonicalize(manifest)) {
				const reason = registration
					? `Hook ${manifest.id} manifest drifted from its capability plan`
					: `Hook ${manifest.id} is not registered`;
				const record: HookAuditRecord = {
					hookId: manifest.id,
					hookVersion: manifest.version,
					point: input.point,
					mode: manifest.hook!.mode,
					outcome: "failed",
					startedAt,
					finishedAt: this.#clock(),
					durationMs: Math.max(0, this.#clock() - startedAt),
					code: "hook_drift",
					reason,
				};
				records.push(record);
				return {
					allowed: false,
					records,
					denial: { hookId: manifest.id, code: "hook_drift", reason },
				};
			}

			const invocation = {
				hookId: manifest.id,
				hookVersion: manifest.version,
				point: input.point,
				operationId: input.operationId,
				sessionId: input.sessionId,
				timestamp: input.timestamp,
				data: cloneJson(input.data ?? null),
			};
			const execution = await executeHook(registration, invocation, input.signal);
			if (execution.type === "aborted") throw input.signal.reason;
			const finishedAt = this.#clock();
			const base = {
				hookId: manifest.id,
				hookVersion: manifest.version,
				point: input.point,
				mode: manifest.hook!.mode,
				startedAt,
				finishedAt,
				durationMs: Math.max(0, finishedAt - startedAt),
			};
			if (execution.type === "timeout" || execution.type === "error") {
				const code = execution.type === "timeout" ? "hook_timeout" : "hook_error";
				const reason = execution.type === "timeout" ? `Hook ${manifest.id} timed out` : errorMessage(execution.error);
				const record: HookAuditRecord = {
					...base,
					outcome: execution.type === "timeout" ? "timed_out" : "failed",
					code,
					reason,
				};
				records.push(record);
				if (manifest.hook!.mode === "enforce")
					return { allowed: false, records, denial: { hookId: manifest.id, code, reason } };
				continue;
			}

			let result: HookHandlerResult;
			try {
				result = validateResult(execution.result);
			} catch (error) {
				const reason = errorMessage(error);
				const record: HookAuditRecord = {
					...base,
					outcome: "failed",
					code: "hook_invalid_result",
					reason,
				};
				records.push(record);
				if (manifest.hook!.mode === "enforce")
					return {
						allowed: false,
						records,
						denial: { hookId: manifest.id, code: "hook_invalid_result", reason },
					};
				continue;
			}
			const denied = result.decision === "deny";
			const record: HookAuditRecord = {
				...base,
				outcome: denied ? (manifest.hook!.mode === "enforce" ? "denied" : "denial_ignored") : "completed",
				...(result.code ? { code: result.code } : {}),
				...(result.reason ? { reason: result.reason.trim() } : {}),
				...(result.annotations ? { annotations: cloneJson(result.annotations) } : {}),
			};
			records.push(record);
			if (denied && manifest.hook!.mode === "enforce") {
				return {
					allowed: false,
					records,
					denial: {
						hookId: manifest.id,
						code: result.code ?? "hook_denied",
						reason: result.reason!.trim(),
					},
				};
			}
		}
		return { allowed: true, records };
	}
}
