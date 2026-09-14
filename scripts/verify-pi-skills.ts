import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { SessionOrchestrator, SqliteOrchestratorStore } from "@wuming/orchestrator";
import { createDefaultPiSessionFactory, PiAgentRuntime } from "@wuming/pi-adapter";
import { ApprovalBroker, createSandboxTools, WorkspaceFileExecutor, WorkspaceSearcher } from "@wuming/sandbox";
import { ManagedSkillCatalog } from "../apps/gateway/src/managed-skill-catalog.js";
import { createSkillTools, markSkillSourceReads, skillDiscoveryFragment } from "../apps/gateway/src/skill-tools.js";
import { loadSavedModelSource } from "./lib/saved-model-source.js";
import { createModelRequestPacer } from "./lib/model-request-pacer.js";

function required(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`${name} is required`);
	return value;
}

async function main(): Promise<void> {
	const provider = required("WUMING_MODEL_PROVIDER");
	const modelId = required("WUMING_MODEL_ID");
	const casePauseMs = Number(process.env.WUMING_SKILL_EVAL_PAUSE_MS ?? 0);
	if (!Number.isInteger(casePauseMs) || casePauseMs < 0 || casePauseMs > 60_000)
		throw new Error("Invalid evaluation pause");
	const requestIntervalMs = Number(process.env.WUMING_SKILL_EVAL_REQUEST_INTERVAL_MS ?? 0);
	const requestPacer = createModelRequestPacer(requestIntervalMs);
	const turnTimeoutMs = 60_000 + requestIntervalMs * 12;
	const source = await loadSavedModelSource(
		required("WUMING_PI_MODEL_SOURCE_DIR"),
		process.env.WUMING_MODEL_CONFIG_KEY
	);
	const registration = source.registrations.find((item) => item.provider === provider);
	const model = registration?.config.models?.find((item) => item.id === modelId);
	if (!registration || !model) throw new Error("Selected model is not in the saved configuration");
	const maxTokens = Math.min(model.maxTokens, 4096);
	const registrations = [{ ...registration, config: { ...registration.config, models: [{ ...model, maxTokens }] } }];
	const root = await mkdtemp(join(tmpdir(), "wuming-real-skills-"));
	const workspace = join(root, "workspace");
	await mkdir(workspace);
	const proof = `SKILL_PROOF_${randomUUID()}`;
	await writeFile(join(workspace, "config.local.txt"), `proof=${proof}\n`);
	await writeFile(join(workspace, "math.js"), "export function add(a, b) { return a - b; }\n");
	const manual = join(workspace, ".wuming", "skills", "manual-check");
	await mkdir(manual, { recursive: true });
	await writeFile(
		join(manual, "SKILL.md"),
		"---\nname: manual-check\ndescription: A manually selected diagnostic reply\ndisable-model-invocation: true\n---\nFor this diagnostic request reply exactly MANUAL_SKILL_OK. No tools are needed."
	);
	const store = new SqliteOrchestratorStore(join(root, "test.db"));
	const approvals = new ApprovalBroker({ store });
	const files = await WorkspaceFileExecutor.create(workspace, {
		maxReadBytes: 4096,
		maxWriteBytes: 4096,
	});
	const search = await WorkspaceSearcher.create(workspace);
	const catalog = new ManagedSkillCatalog();
	const packageSource = join(workspace, "packages", "fixture-audit");
	await mkdir(packageSource, { recursive: true });
	await writeFile(
		join(packageSource, "SKILL.md"),
		"---\nname: fixture-audit\ndescription: Perform a fixture audit of the test configuration and report its proof. 测试配置夹具核验。Not debugging a failure or general code review.\n---\nRead config.local.txt from the workspace and report exactly FIXTURE_AUDIT_OK followed by a space and the actual proof value. Never invent a proof."
	);
	await catalog.manager(workspace).installFromWorkspace("packages/fixture-audit");
	const skillVersions = await Promise.all(
		(await catalog.list("eval", workspace)).map(async ({ id }) => {
			const skill = await catalog.get("eval", workspace, id);
			return {
				id,
				digest: createHash("sha256")
					.update(
						JSON.stringify({
							content: skill.content,
							description: skill.description,
							allowImplicitInvocation: skill.allowImplicitInvocation,
						})
					)
					.digest("hex"),
			};
		})
	);
	console.log(
		JSON.stringify({
			catalog: (await catalog.list("eval", workspace)).map(({ id, allowImplicitInvocation }) => ({
				id,
				allowImplicitInvocation,
			})),
		})
	);
	const finishReasons = new Map<string, string>();
	const createSession = createDefaultPiSessionFactory({
		agentDir: join(root, "agent"),
		sessionDataDir: join(root, "sessions"),
		resolveWorkspace: () => workspace,
		autoRetry: false,
		autoCompaction: false,
		registerProviders: () => registrations,
		createCustomTools: async (snapshot) => [
			...createSandboxTools({
				snapshot,
				executor: { files, search },
				approvals,
				protectSkillSources: true,
			})
				.filter((tool) => ["read_file", "ls"].includes(tool.name))
				.map(markSkillSourceReads),
			...createSkillTools(catalog.manager(workspace), "eval", await catalog.list("eval", workspace)),
		],
	});
	const runtime = new PiAgentRuntime({
		resolveContextFragments: async () => [skillDiscoveryFragment(await catalog.list("eval", workspace))],
		resolveSkills: async (_snapshot, ids) =>
			Promise.all(
				ids.map(async (id) => {
					const skill = await catalog.get("eval", workspace, id);
					return { id, name: skill.name, content: skill.content, truncated: skill.truncated };
				})
			),
		createSession: async (snapshot) => {
			const session = await createSession(snapshot);
			// This factory returns Pi's actual AgentSession. Pace its supported
			// context-preparation hook without changing model messages or tools.
			requestPacer.attach((session as AgentSession).agent);
			session.subscribe((event) => {
				if (event.type === "message_end" && event.message.role === "assistant")
					finishReasons.set(snapshot.session.id, event.message.stopReason);
			});
			return session;
		},
	});
	const orchestrator = new SessionOrchestrator(store, runtime, { turnTimeoutMs, maxRetries: 0 });
	const cases: Array<{
		id: string;
		prompt: string;
		expectedSkill?: string;
		forbiddenSkill?: string;
		noSkills?: boolean;
		proof?: boolean;
		recovery?: boolean;
		selected?: string[];
		disableInstalled?: boolean;
	}> = [
		{ id: "greeting-zh", prompt: "你好，简短打个招呼即可。", noSkills: true },
		{
			id: "translation-zh",
			prompt: "把这句话翻译成英文：明天我们讨论这个方案。只给译文。",
			noSkills: true,
		},
		{
			id: "debug-zh",
			prompt: "工作区的 config.txt 读取失败了，请排查原因并检查可用配置文件，报告 proof 字段原值和依据。",
			expectedSkill: "debug",
			forbiddenSkill: "fixture-audit",
			proof: true,
		},
		{
			id: "debug-en",
			prompt:
				"Investigate why reading config.txt fails in this workspace. Find the actual configuration and report its proof value with evidence.",
			expectedSkill: "debug",
			forbiddenSkill: "fixture-audit",
			proof: true,
		},
		{
			id: "review-zh",
			prompt: "请审查 math.js 的 add 函数，指出确定存在的问题，只审查不要修改。",
			expectedSkill: "code-review",
			forbiddenSkill: "fixture-audit",
		},
		{
			id: "recovery-zh",
			prompt: "先读取 config.txt 并告诉我 proof 字段的值。不要猜测内容。",
			forbiddenSkill: "fixture-audit",
			proof: true,
			recovery: true,
		},
		{
			id: "manual-explicit",
			prompt: "按照我选择的技能进行这次诊断回复。",
			expectedSkill: "manual-check",
			selected: ["manual-check"],
		},
		{
			id: "installed-auto-zh",
			prompt: "请对测试配置做一次夹具核验，报告真实的 proof 值。",
			expectedSkill: "fixture-audit",
			proof: true,
		},
		{
			id: "installed-disabled-zh",
			prompt: "请对测试配置做一次夹具核验，报告真实的 proof 值。",
			forbiddenSkill: "fixture-audit",
			proof: true,
			disableInstalled: true,
		},
	];
	const outcomes: Array<Record<string, unknown>> = [];
	try {
		const selectedCases = process.env.WUMING_SKILL_EVAL_CASES?.split(",").map((id) => id.trim());
		if (selectedCases?.some((id) => !cases.some((scenario) => scenario.id === id)))
			throw new Error("Unknown skill evaluation case");
		const plannedCases = cases.filter((item) => !selectedCases || selectedCases.includes(item.id));
		let consecutiveProviderFailures = 0;
		for (const scenario of plannedCases) {
			if (outcomes.length > 0 && casePauseMs > 0) await pause(casePauseMs);
			await catalog.manager(workspace).setEnabled("fixture-audit", scenario.disableInstalled !== true);
			const created = await orchestrator.createSession({
				principalId: "skill-evaluator",
				idempotencyKey: randomUUID(),
				workspaceId: "eval",
				model: { provider, id: modelId },
				thinkingLevel: "off",
				sandboxMode: "read_only",
				approvalPolicy: "never",
				tokenBudget: 50_000,
			});
			const sessionId = created.snapshot.session.id;
			await orchestrator.acceptTurn({
				principalId: "skill-evaluator",
				idempotencyKey: randomUUID(),
				sessionId,
				mode: "prompt",
				content: [{ type: "text", text: scenario.prompt }],
				...(scenario.selected ? { skills: scenario.selected } : {}),
			});
			await orchestrator.drainSession(sessionId);
			const snapshot = store.loadSnapshot(sessionId)!;
			const tools = snapshot.transcript.filter((item) => item.type === "tool");
			const last = [...snapshot.transcript].reverse().find((item) => item.type === "assistant");
			const text =
				last?.content
					.filter((part) => part.type === "text")
					.map((part) => part.text)
					.join("") ?? "";
			const loaded = tools
				.filter(
					(tool) =>
						tool.toolName === "skill_load" &&
						!tool.isError &&
						tool.input &&
						typeof tool.input === "object" &&
						!Array.isArray(tool.input) &&
						!tool.input.resourcePath
				)
				.map((tool) => (tool.input as { skillId: string }).skillId);
			const operation = store.listOperations(sessionId)[0];
			const firstFailure = tools.findIndex((tool) => tool.isError);
			const laterRead =
				firstFailure >= 0 &&
				tools.slice(firstFailure + 1).some((tool) => tool.toolName === "read_file" && !tool.isError);
			const midTurnLoad =
				firstFailure >= 0 &&
				tools.slice(firstFailure + 1).some((tool) => tool.toolName === "skill_load" && !tool.isError);
			const used = snapshot.usageByTurn?.find((turn) => turn.turnId === operation?.id)?.skills ?? [];
			const finishReason = finishReasons.get(sessionId);
			const passed =
				operation?.status === "completed" &&
				last?.status === "complete" &&
				finishReason === "stop" &&
				text.length > 0 &&
				(scenario.id !== "manual-explicit" || text.trim() === "MANUAL_SKILL_OK") &&
				(scenario.id !== "installed-auto-zh" || text.trim() === `FIXTURE_AUDIT_OK ${proof}`) &&
				(!scenario.expectedSkill || used.includes(scenario.expectedSkill)) &&
				(!scenario.noSkills || (used.length === 0 && tools.length === 0)) &&
				(!scenario.forbiddenSkill ||
					(!used.includes(scenario.forbiddenSkill) &&
						!loaded.includes(scenario.forbiddenSkill) &&
						!text.includes("FIXTURE_AUDIT_OK"))) &&
				(!scenario.proof || text.includes(proof)) &&
				(!scenario.recovery || (laterRead && midTurnLoad));
			const redact = (value: string) => {
				let text = value;
				for (const entry of source.registrations) {
					const key = entry.config.apiKey;
					if (typeof key === "string" && key) text = text.replaceAll(key, "[redacted]");
				}
				return text.slice(0, 2000);
			};
			const outcome = {
				id: scenario.id,
				passed,
				operationStatus: operation?.status,
				finishReason,
				error: redact(operation?.error ?? ""),
				failureKind: operation?.failureKind,
				contextFragments: operation?.contextPlan?.fragments.map((item) => item.id),
				contextOmitted: operation?.contextPlan?.omitted.map((item) => item.id),
				finalReply: redact(text),
				used,
				loaded,
				disabledSkills: scenario.disableInstalled ? ["fixture-audit"] : [],
				firstFailure,
				laterRead,
				midTurnLoad,
				proofVerified: scenario.proof ? text.includes(proof) : null,
				tools: tools.map((tool) => ({
					name: tool.toolName,
					status: tool.status,
					input: tool.input,
					output: redact(
						tool.content
							.filter((part) => part.type === "text")
							.map((part) => part.text)
							.join("\n")
					),
				})),
				usage: snapshot.usage,
			};
			outcomes.push(outcome);
			console.log(
				JSON.stringify({
					id: scenario.id,
					passed,
					used,
					requestsComplete: operation?.status === "completed",
				})
			);
			consecutiveProviderFailures = operation?.failureKind?.startsWith("provider")
				? consecutiveProviderFailures + 1
				: 0;
			if (consecutiveProviderFailures >= 2) {
				console.log(JSON.stringify({ stopped: "two consecutive provider failures; remaining cases not run" }));
				break;
			}
		}
		const notRun = plannedCases
			.filter((scenario) => !outcomes.some((outcome) => outcome.id === scenario.id))
			.map((scenario) => scenario.id);
		const report = {
			acceptanceVersion: "skill-routing-v2-no-unrelated-fixture",
			evaluatedAt: new Date().toISOString(),
			provider,
			modelId,
			casePauseMs,
			requestPacing: requestPacer.stats(),
			turnTimeoutMs,
			maxTokens,
			skillVersions,
			plannedCases: plannedCases.map((scenario) => scenario.id),
			notRun,
			scope:
				"isolated read-only real-model skill routing, installation and recovery smoke; not broad benchmark coverage",
			cases: outcomes,
		};
		const output = resolve(process.env.WUMING_SKILL_EVAL_OUTPUT ?? join("docs", "skill-model-evaluation.json"));
		await writeFile(output, JSON.stringify(report, null, 2) + "\n");
		console.log(
			JSON.stringify({
				report: output,
				passed: outcomes.filter((item) => item.passed).length,
				total: outcomes.length,
			})
		);
		if (notRun.length > 0 || outcomes.some((item) => !item.passed)) process.exitCode = 1;
	} finally {
		await runtime[Symbol.asyncDispose]();
		store.close();
		await rm(root, { recursive: true, force: true });
	}
}

main().catch(() => {
	console.error("Skill model evaluation failed; no credentials or raw provider errors were emitted.");
	process.exitCode = 1;
});
