import { createHash } from "node:crypto";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

type FailureKind = "transient" | "configuration" | "deterministic" | "unknown";
interface Failure {
	key: string;
	tool: string;
	count: number;
	kind: FailureKind;
}

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([key, child]) => [key, canonical(child)])
		);
	return value;
}

function classify(message: string): FailureKind {
	if (/\b(ETIMEDOUT|ECONNRESET|EAI_AGAIN|429|502|503|504)\b|timed? out|rate.limit/i.test(message)) return "transient";
	if (/ENOENT|not found|not installed|not configured|missing|unavailable/i.test(message)) return "configuration";
	if (/invalid|syntax|assert|type.?error|validation|mismatch/i.test(message)) return "deterministic";
	return "unknown";
}

const guidance: Record<FailureKind, string> = {
	transient:
		"Inspect current request/process state before a bounded retry; a timeout does not prove no side effect occurred.",
	configuration:
		"Inspect actual paths, dependencies and available tools. Correct the prerequisite or choose an authorized alternative.",
	deterministic: "Inspect the failing contract and test a changed hypothesis/input; do not replay the unchanged call.",
	unknown: "Inspect the actual error and gather evidence before another attempt. Consider a relevant debugging skill.",
};

/** Session-local monitor. It never retries, executes a fallback, or grants permission. */
export class ToolRecoveryMonitor {
	constructor(private readonly skillDiscoveryAvailable = false) {}
	readonly #failures = new Map<string, Failure>();
	readonly #failedMediaSubmissions = new Set<string>();
	#lastFailure: Failure | undefined;
	reset(): void {
		this.#failures.clear();
		this.#failedMediaSubmissions.clear();
		this.#lastFailure = undefined;
	}
	private recordFailure(key: string, tool: string, kind: FailureKind): Failure {
		const failure = { key, tool, kind, count: (this.#failures.get(key)?.count ?? 0) + 1 };
		this.#failures.set(key, failure);
		this.#lastFailure = failure;
		if (this.#failures.size > 128) this.#failures.delete(this.#failures.keys().next().value!);
		return failure;
	}

	wrap(tool: ToolDefinition): ToolDefinition {
		return {
			...tool,
			execute: async (...args: Parameters<ToolDefinition["execute"]>) => {
				const signal = args[2];
				signal?.throwIfAborted();
				if (this.#failedMediaSubmissions.has(tool.name))
					throw Object.assign(
						new Error(
							"A " +
								tool.name +
								" submission already failed in this turn. No new generation was submitted. Changing parameters or checking settings does not make another potentially billable request safe. Report the provider error and wait for user direction."
						),
						{ code: "media_submission_blocked" }
					);
				const key = createHash("sha256")
					.update(tool.name)
					.update("\0")
					.update(JSON.stringify(canonical(args[1])))
					.digest("hex");
				const prior = this.#failures.get(key);
				if (prior && prior.count >= 2) {
					throw Object.assign(
						new Error(
							`Repeated identical ${tool.name} failure: execution was not repeated. This input already failed twice in this turn. Inspect evidence, change the input or use an authorized alternative; otherwise report the blocker. Do not bypass a permission boundary.`
						),
						{
							code: "repeated_tool_failure",
							details: {
								wumingRecovery: {
									status: "blocked_repeat",
									tool: tool.name,
									inputDigest: key,
									attempts: prior.count,
								},
							},
						}
					);
				}
				const previous = this.#lastFailure;
				try {
					const result = await tool.execute(...args);
					const processDetails = result.details as
						{ exitCode?: unknown; timedOut?: unknown; environmentIssue?: unknown } | undefined;
					if (
						/^(exec|run_python)$/.test(tool.name) &&
						processDetails &&
						(processDetails.timedOut === true ||
							processDetails.exitCode === null ||
							(typeof processDetails.exitCode === "number" && processDetails.exitCode !== 0))
					) {
						const failure = this.recordFailure(
							key,
							tool.name,
							processDetails.timedOut === true
								? "transient"
								: processDetails.environmentIssue
									? "configuration"
									: "deterministic"
						);
						return {
							...result,
							details: {
								...(result.details && typeof result.details === "object" ? result.details : {}),
								wumingRecovery: {
									status: "failed",
									tool: tool.name,
									inputDigest: key,
									attempts: failure.count,
									kind: failure.kind,
								},
							},
							content: [
								...result.content,
								{
									type: "text" as const,
									text: `Wuming recovery: command did not succeed (attempt ${failure.count}). ${guidance[failure.kind]} Do not equate command completion with task success.`,
								},
							],
						};
					}
					this.#failures.delete(key);
					const changed = previous !== undefined && previous.key !== key;
					// A successful state-changing operation is new evidence that can repair
					// an earlier prerequisite. Pure discovery must not reset repeat guards.
					if (/^(write_file|edit|exec|run_python|browser_action|preview_start|preview_stop)$/.test(tool.name))
						this.#failures.clear();
					if (previous?.tool === tool.name) this.#lastFailure = undefined;
					if (!changed) return result;
					const observation = {
						status: tool.name === "media_model_status" ? "diagnostic_succeeded" : "changed_attempt_succeeded",
						previousTool: previous.tool,
						tool: tool.name,
						inputDigest: key,
					};
					return {
						...result,
						details: {
							...(result.details && typeof result.details === "object" ? result.details : {}),
							wumingRecovery: observation,
						},
						content: [
							...result.content,
							{
								type: "text" as const,
								text: `Recovery observation: ${JSON.stringify(observation)}. A changed tool/input succeeded; this alone does not prove the original task is complete.`,
							},
						],
					};
				} catch (error) {
					const code =
						error && typeof error === "object"
							? String("protocolCode" in error ? error.protocolCode : "code" in error ? error.code : "")
							: "";
					const message = error instanceof Error ? error.message : String(error);
					if (code === "media_submission_failed" && /^(generate_image|generate_video)$/.test(tool.name)) {
						this.#failedMediaSubmissions.add(tool.name);
						this.recordFailure(key, tool.name, "deterministic");
						throw error;
					}
					// Preserve approval/abort errors exactly: they carry workflow state and
					// must never be reframed as an invitation to bypass authorization.
					if (
						signal?.aborted ||
						/approval|permission|forbidden|denied|abort|cancel|path_escape|unauthorized/i.test(`${code} ${message}`)
					)
						throw error;
					const failure = this.recordFailure(key, tool.name, classify(`${code} ${message}`));
					const details =
						error &&
						typeof error === "object" &&
						"details" in error &&
						error.details &&
						typeof error.details === "object"
							? error.details
							: {};
					const skillReminder =
						this.skillDiscoveryAvailable && !tool.name.startsWith("skill_")
							? " Before the next attempt, reassess the available skill summaries and use skill_load for an applicable skill not already loaded. Then change the approach and verify the original requested result."
							: "";
					throw Object.assign(
						new Error(
							`${message}\n\nWuming recovery (${failure.kind}, attempt ${failure.count}): ${guidance[failure.kind]}${skillReminder}${failure.count >= 2 ? " Further identical execution is blocked this turn until new state-changing evidence; change the approach." : ""}`,
							{ cause: error }
						),
						{
							...(error && typeof error === "object" ? error : {}),
							details: {
								...details,
								wumingRecovery: {
									status: "failed",
									tool: tool.name,
									inputDigest: key,
									attempts: failure.count,
									kind: failure.kind,
								},
							},
						}
					);
				}
			},
		};
	}
}
