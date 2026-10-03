import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { setTimeout as pause } from "node:timers/promises";
import { SessionOrchestrator, SqliteOrchestratorStore } from "@wuming/orchestrator";
import { createDefaultPiSessionFactory, PiAgentRuntime } from "@wuming/pi-adapter";
import { ApprovalBroker, createSandboxTools, WorkspaceFileExecutor, WorkspaceSearcher } from "@wuming/sandbox";
import { loadSavedModelSource } from "./lib/saved-model-source.js";
import {
	checkTask,
	checkTaskTurn,
	summarizeTasks,
	taskCases,
	type CaseResult,
	type TaskTurnResult,
} from "./lib/task-benchmark.js";

function required(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`${name} is required`);
	return value;
}

function integer(value: string, name: string, min: number, max: number): number {
	const number = Number(value);
	if (!Number.isSafeInteger(number) || number < min || number > max) throw new Error(`Invalid ${name}`);
	return number;
}

async function workspaceFiles(root: string, directory = root): Promise<Record<string, string>> {
	const files: Record<string, string> = {};
	for (const name of await readdir(directory)) {
		const path = join(directory, name);
		const stat = await lstat(path);
		if (stat.isSymbolicLink()) throw new Error("Unexpected benchmark symlink");
		if (stat.isDirectory()) Object.assign(files, await workspaceFiles(root, path));
		else {
			if (!stat.isFile() || stat.size > 64 * 1024) throw new Error("Unexpected benchmark output");
			files[path.slice(root.length + 1).replaceAll("\\", "/")] = await readFile(path, "utf8");
		}
	}
	return files;
}

async function main() {
	const { values } = parseArgs({
		options: {
			run: { type: "boolean", default: false },
			cases: { type: "string" },
			output: { type: "string" },
			"total-token-budget": { type: "string", default: "50000" },
			"case-token-budget": { type: "string", default: "12000" },
			"timeout-ms": { type: "string", default: "120000" },
			"pause-ms": { type: "string", default: "5000" },
		},
	});
	const totalBudget = integer(values["total-token-budget"], "total-token-budget", 1000, 1_000_000);
	const caseBudget = integer(values["case-token-budget"], "case-token-budget", 1000, 100_000);
	const timeoutMs = integer(values["timeout-ms"], "timeout-ms", 1000, 300_000);
	const pauseMs = integer(values["pause-ms"], "pause-ms", 0, 60_000);
	const allCases = taskCases(`BENCHMARK_PROOF_${randomUUID()}`);
	const ids = values.cases?.split(",").map((id) => id.trim());
	if (ids && (new Set(ids).size !== ids.length || ids.some((id) => !allCases.some((scenario) => scenario.id === id))))
		throw new Error("Unknown or duplicate benchmark case");
	const selected = allCases.filter((scenario) => !ids || ids.includes(scenario.id));
	for (const scenario of selected) {
		if (scenario.prompts.length === 0 || (scenario.intermediateFiles?.length ?? 0) !== scenario.prompts.length - 1)
			throw new Error("Every benchmark turn must define its expected files");
	}
	const plan = {
		version: "local-file-tasks-v2",
		cases: selected.map(({ id, category }) => ({ id, category })),
		totalTokenBudget: totalBudget,
		caseTokenBudget: caseBudget,
		timeoutMs,
		pauseMs,
		scope: "Isolated file tasks only; no shell, browser, team, skill-routing or application-quality claims.",
	};
	if (!values.run) {
		console.log(
			JSON.stringify(
				{
					...plan,
					dryRun: true,
					modelRequests: 0,
					notice: "Pass --run explicitly to use a paid provider. Token budgets are not a billing cap.",
				},
				null,
				2
			)
		);
		return;
	}
	const provider = required("WUMING_MODEL_PROVIDER");
	const modelId = required("WUMING_MODEL_ID");
	const source = await loadSavedModelSource(
		required("WUMING_PI_MODEL_SOURCE_DIR"),
		process.env.WUMING_MODEL_CONFIG_KEY
	);
	const registration = source.registrations.find((entry) => entry.provider === provider);
	const model = registration?.config.models?.find((entry) => entry.id === modelId);
	if (!registration || !model) throw new Error("Selected model is not in the saved configuration");
	const registrations = [
		{
			...registration,
			config: { ...registration.config, models: [{ ...model, maxTokens: Math.min(model.maxTokens, 2048) }] },
		},
	];
	const output = resolve(values.output ?? join("test-results", `task-benchmark-${Date.now()}.json`));
	await mkdir(dirname(output), { recursive: true });
	// Reserve an unused report path before the first potentially billable request.
	await writeFile(output, JSON.stringify({ ...plan, status: "started", provider, modelId }), { flag: "wx" });
	const root = await mkdtemp(join(tmpdir(), "wuming-task-benchmark-"));
	const store = new SqliteOrchestratorStore(join(root, "benchmark.db"));
	const approvals = new ApprovalBroker({ store });
	const workspaces = new Map<string, { path: string; files: WorkspaceFileExecutor; search: WorkspaceSearcher }>();
	const runtime = new PiAgentRuntime({
		createSession: createDefaultPiSessionFactory({
			agentDir: join(root, "agent"),
			sessionDataDir: join(root, "sessions"),
			resolveWorkspace: (id) => workspaces.get(id)!.path,
			autoRetry: false,
			autoCompaction: false,
			registerProviders: () => registrations,
			createCustomTools: (snapshot) =>
				createSandboxTools({
					snapshot,
					approvals,
					executor: workspaces.get(snapshot.session.workspaceId)!,
				}).filter((tool) => ["read_file", "write_file", "edit", "ls", "glob", "grep"].includes(tool.name)),
		}),
	});
	const orchestrator = new SessionOrchestrator(store, runtime, { turnTimeoutMs: timeoutMs, maxRetries: 0 });
	const results: CaseResult[] = [];
	let activeCase: { id: string; started: number; sessionId?: string } | undefined;
	let consecutiveProviderFailures = 0;
	let stopReason: string | undefined;
	let sourceCommit: string | undefined;
	let sourceDirty: boolean | undefined;
	try {
		sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		sourceDirty =
			execFileSync("git", ["status", "--porcelain"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()
				.length > 0;
	} catch {
		/* A source archive can run without Git metadata. */
	}
	const completeResults = () =>
		selected.map(
			(scenario) =>
				results.find((result) => result.id === scenario.id) ?? {
					id: scenario.id,
					status: "not_run" as const,
					durationMs: 0,
					manualInterventions: 0,
				}
		);
	const save = async () => {
		const complete = completeResults();
		await writeFile(
			output,
			JSON.stringify(
				{
					...plan,
					provider,
					modelId,
					evaluatedAt: new Date().toISOString(),
					sourceCommit,
					sourceDirty,
					suiteDigest: createHash("sha256")
						.update(JSON.stringify(taskCases("PROOF")))
						.digest("hex"),
					stopReason,
					summary: summarizeTasks(complete),
					cases: complete,
				},
				null,
				2
			) + "\n"
		);
	};
	try {
		for (const scenario of selected) {
			const remaining = totalBudget - summarizeTasks(results).totalTokens;
			if (remaining < 1000) {
				stopReason = "total-token-budget";
				break;
			}
			if (results.length && pauseMs) await pause(pauseMs);
			activeCase = { id: scenario.id, started: performance.now() };
			const path = join(root, scenario.id);
			await mkdir(path);
			for (const [name, content] of Object.entries(scenario.files)) await writeFile(join(path, name), content);
			workspaces.set(scenario.id, {
				path,
				files: await WorkspaceFileExecutor.create(path, { maxReadBytes: 64 * 1024, maxWriteBytes: 64 * 1024 }),
				search: await WorkspaceSearcher.create(path),
			});
			const { snapshot: created } = await orchestrator.createSession({
				principalId: "task-benchmark",
				idempotencyKey: randomUUID(),
				workspaceId: scenario.id,
				model: { provider, id: modelId },
				thinkingLevel: "off",
				sandboxMode: "workspace_write",
				approvalPolicy: "never",
				tokenBudget: Math.min(remaining, caseBudget),
			});
			const sessionId = created.session.id;
			const started = performance.now();
			activeCase = { id: scenario.id, started, sessionId };
			const turns: TaskTurnResult[] = [];
			for (const [index, prompt] of scenario.prompts.entries()) {
				const transcriptLength = store.loadSnapshot(sessionId)!.transcript.length;
				await orchestrator.acceptTurn({
					principalId: "task-benchmark",
					idempotencyKey: randomUUID(),
					sessionId,
					mode: "prompt",
					content: [{ type: "text", text: prompt }],
				});
				await orchestrator.drainSession(sessionId);
				// Grade this turn before a later request can overwrite its result.
				turns.push(
					checkTaskTurn(
						scenario,
						index,
						await workspaceFiles(path),
						store.loadSnapshot(sessionId)!.transcript.slice(transcriptLength)
					)
				);
				if (store.listOperations(sessionId).some((operation) => operation.status !== "completed")) break;
			}
			const snapshot = store.loadSnapshot(sessionId)!;
			const failed = store.listOperations(sessionId).find((operation) => operation.status !== "completed");
			const verdict = checkTask(scenario, await workspaceFiles(path), snapshot.transcript, turns);
			const status: CaseResult["status"] = failed
				? failed.failureKind?.startsWith("provider")
					? "provider_failed"
					: failed.failureKind === "budget"
						? "budget_stopped"
						: "runtime_failed"
				: verdict.passed
					? "passed"
					: "behavior_failed";
			results.push({
				id: scenario.id,
				status,
				durationMs: Math.round(performance.now() - started),
				checks: verdict.checks,
				turns,
				...(snapshot.usage.totalTokens > 0 ? { usage: snapshot.usage } : {}),
				toolCalls: snapshot.transcript.filter((item) => item.type === "tool").length,
				...(failed?.failureKind ? { failureKind: failed.failureKind } : {}),
				manualInterventions: 0,
			});
			activeCase = undefined;
			console.log(JSON.stringify({ id: scenario.id, status }));
			await save();
			consecutiveProviderFailures = status === "provider_failed" ? consecutiveProviderFailures + 1 : 0;
			if (consecutiveProviderFailures >= 2) {
				stopReason = "two-consecutive-provider-failures";
				break;
			}
			if (snapshot.usage.totalTokens <= 0) {
				stopReason = "usage-unavailable-cannot-track-budget";
				break;
			}
		}
	} catch {
		stopReason = "harness-error-details-withheld";
		if (activeCase) {
			const snapshot = activeCase.sessionId ? store.loadSnapshot(activeCase.sessionId) : undefined;
			results.push({
				id: activeCase.id,
				status: "runtime_failed",
				durationMs: Math.round(performance.now() - activeCase.started),
				...(snapshot && snapshot.usage.totalTokens > 0 ? { usage: snapshot.usage } : {}),
				manualInterventions: 0,
			});
		}
		process.exitCode = 1;
	} finally {
		try {
			await save();
		} finally {
			try {
				await runtime[Symbol.asyncDispose]();
			} finally {
				store.close();
				await rm(root, { recursive: true, force: true });
			}
		}
	}
	console.log(JSON.stringify({ report: output, ...summarizeTasks(completeResults()), stopReason }));
	if (stopReason || results.length !== selected.length || results.some((result) => result.status !== "passed"))
		process.exitCode = 1;
}

main().catch(() => {
	console.error(
		"Task benchmark failed. Check arguments and saved model configuration; credentials and provider bodies are withheld."
	);
	process.exitCode = 1;
});
