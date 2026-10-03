import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import type { TranscriptItem } from "@wuming/protocol";
import { CustomModelRegistry } from "../../apps/gateway/src/custom-models.js";
import { checkTask, checkTaskTurn, summarizeTasks, taskCases } from "./task-benchmark.js";

function answer(text: string): TranscriptItem {
	return {
		type: "assistant",
		id: "answer",
		createdAt: 1,
		model: { provider: "fixture", id: "fixture" },
		status: "complete",
		content: [{ type: "text", text }],
	};
}

function tool(name: string, isError = false): TranscriptItem {
	return {
		type: "tool",
		id: name,
		toolCallId: name,
		toolName: name,
		createdAt: 1,
		status: isError ? "error" : "complete",
		isError,
		input: {},
		content: [],
	};
}

test("the fixed suite has 12 unique cases and rejects unchanged work", () => {
	const cases = taskCases("proof-123");
	assert.equal(cases.length, 12);
	assert.equal(new Set(cases.map((scenario) => scenario.id)).size, 12);
	for (const scenario of cases) {
		const tools = scenario.recovery
			? [tool("read_file", true), tool("read_file")]
			: scenario.id === "copy-exact"
				? [tool("read_file"), tool("write_file"), tool("read_file")]
				: [];
		const transcript = [...tools, answer(scenario.answerIncludes?.join(" ") ?? "Verified")];
		const turns = scenario.prompts.map((_, index) =>
			checkTaskTurn(scenario, index, scenario.intermediateFiles?.[index] ?? scenario.expectedFiles, transcript)
		);
		assert.equal(checkTask(scenario, scenario.expectedFiles, transcript, turns).passed, true, scenario.id);
		assert.equal(checkTask(scenario, scenario.expectedFiles, []).passed, false, scenario.id);
		if (["edit-config", "cross-file-config", "structured-transform", "follow-up-change"].includes(scenario.id))
			assert.equal(checkTask(scenario, scenario.files, transcript).passed, false, scenario.id);
	}
});

test("multi-turn grading rejects a skipped first turn even when the final file is correct", () => {
	const scenario = taskCases("proof").find((item) => item.id === "follow-up-change")!;
	const first = checkTaskTurn(scenario, 0, scenario.files, [answer("I cannot edit this file.")]);
	const second = checkTaskTurn(scenario, 1, scenario.expectedFiles, [tool("write_file"), answer("Port is 4300.")]);
	assert.equal(first.passed, false);
	assert.equal(second.passed, true);
	assert.equal(checkTask(scenario, scenario.expectedFiles, [answer("done")], [first, second]).passed, false);
	assert.equal(checkTask(scenario, scenario.expectedFiles, [answer("done")]).passed, false);
	assert.equal(checkTask(scenario, scenario.expectedFiles, [answer("done")], [second, second]).passed, false);
	const validFirst = checkTaskTurn(scenario, 0, scenario.intermediateFiles![0]!, [answer("Port is 4100.")]);
	assert.equal(checkTask(scenario, scenario.expectedFiles, [answer("done")], [validFirst, second]).passed, true);
	assert.equal(checkTaskTurn(scenario, 1, scenario.expectedFiles, []).passed, false);
	assert.throws(() => checkTaskTurn({ ...scenario, intermediateFiles: [] }, 0, scenario.files, []));
});

test("JSON comparison is semantic, but unexpected files and lost fields fail", () => {
	const scenario = taskCases("proof").find((item) => item.id === "edit-config")!;
	assert.equal(
		checkTask(scenario, { "config.json": '{"enabled":true,"name":"keep","port":4100}' }, [answer("done")]).passed,
		true
	);
	assert.equal(checkTask(scenario, { "config.json": '{"port":4100}' }, [answer("done")]).passed, false);
	assert.equal(checkTask(scenario, { ...scenario.expectedFiles, "extra.txt": "oops" }, [answer("done")]).passed, false);
	assert.equal(checkTask(scenario, { "config.json": "not JSON" }, [answer("done")]).passed, false);
});

test("proof, actual recovery, negative controls and file boundaries are graded", () => {
	const cases = taskCases("unpredictable-proof");
	const read = cases.find((item) => item.id === "read-proof-zh")!;
	assert.equal(checkTask(read, read.expectedFiles, [answer("I read it")]).passed, false);
	assert.equal(checkTask(read, read.expectedFiles, [tool("edit"), answer("unpredictable-proof")]).passed, false);
	const recovery = cases.find((item) => item.recovery)!;
	assert.equal(checkTask(recovery, recovery.expectedFiles, [answer("unpredictable-proof")]).passed, false);
	const negative = cases.find((item) => item.noTools)!;
	assert.equal(checkTask(negative, {}, [tool("ls"), answer("HELLO_BENCHMARK")]).passed, false);
	const untrusted = cases.find((item) => item.id === "untrusted-file")!;
	assert.equal(
		checkTask(untrusted, { ...untrusted.files, "stolen.txt": "OVERRIDE" }, [answer("unpredictable-proof")]).passed,
		false
	);
});

test("provider failures and unrun cases never become passing behavior samples", () => {
	const result = summarizeTasks([
		{ id: "a", status: "passed", durationMs: 1, manualInterventions: 0 },
		{ id: "b", status: "behavior_failed", durationMs: 1, manualInterventions: 0 },
		{ id: "c", status: "provider_failed", durationMs: 1, manualInterventions: 0 },
		{ id: "d", status: "not_run", durationMs: 0, manualInterventions: 0 },
	]);
	assert.equal(result.completionRate, 0.25);
	assert.equal(result.behaviorPassRate, 0.5);
	assert.equal(result.notRun, 1);
	assert.equal(result.usageCoverage, 0);
	assert.equal(summarizeTasks([]).behaviorPassRate, null);
});

async function cli(args: string[], environment: Record<string, string> = {}) {
	const child = spawn(process.execPath, ["--import", "tsx", resolve("scripts/verify-task-benchmark.ts"), ...args], {
		env: {
			...process.env,
			WUMING_PI_MODEL_SOURCE_DIR: "",
			WUMING_MODEL_CONFIG_KEY: undefined,
			WUMING_MODEL_PROVIDER: "",
			WUMING_MODEL_ID: "",
			...environment,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => (stdout += chunk));
	child.stderr.on("data", (chunk) => (stderr += chunk));
	const timeout = setTimeout(() => child.kill(), 30_000);
	try {
		const [code] = await once(child, "close");
		return { code, stdout, stderr };
	} finally {
		clearTimeout(timeout);
	}
}

test("default CLI never needs credentials; unknown and empty case filters fail", async () => {
	const dry = await cli([]);
	assert.equal(dry.code, 0, dry.stderr);
	assert.equal(JSON.parse(dry.stdout).modelRequests, 0);
	assert.equal(JSON.parse(dry.stdout).cases.length, 12);
	for (const cases of ["missing", "", "read-proof-en,read-proof-en"])
		assert.notEqual((await cli(["--cases", cases])).code, 0);
});

test("runner uses isolated loopback provider and reports provider failures separately", async () => {
	let fail = false;
	let skipFirstTurn = false;
	let requests = 0;
	const provider = createServer(async (request, response) => {
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(Buffer.from(chunk));
		const body = JSON.parse(Buffer.concat(chunks).toString());
		requests++;
		if (fail) {
			response.writeHead(401).end('{"error":{"message":"fixture-secret-not-for-report"}}');
			return;
		}
		response.writeHead(200, { "Content-Type": "text/event-stream" });
		const frame = (choices: unknown[], usage?: unknown) =>
			"data: " +
			JSON.stringify({
				id: "fixture",
				object: "chat.completion.chunk",
				created: 1,
				model: "benchmark-fixture",
				choices,
				usage,
			}) +
			"\n\n";
		const messages = body.messages as Array<{ role: string; content: unknown }>;
		const call = (name: string, args: unknown, id: string) =>
			response.end(
				frame([
					{
						index: 0,
						delta: {
							role: "assistant",
							tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
						},
						finish_reason: null,
					},
				]) +
					frame([{ index: 0, delta: {}, finish_reason: "tool_calls" }], {
						prompt_tokens: 100,
						completion_tokens: 4,
						total_tokens: 104,
					}) +
					"data: [DONE]\n\n"
			);
		const lastUser = messages.findLastIndex((message) => message.role === "user");
		const latestPrompt = JSON.stringify(messages[lastUser]?.content);
		if (latestPrompt.includes("config.json") || latestPrompt.includes("4300")) {
			const port = latestPrompt.includes("4300") ? 4300 : 4100;
			if (
				!(skipFirstTurn && port === 4100) &&
				!messages.slice(lastUser + 1).some((message) => message.role === "tool")
			) {
				call("write_file", { path: "config.json", content: JSON.stringify({ port, name: "keep" }) }, `port-${port}`);
				return;
			}
		}
		if (JSON.stringify(messages.findLast((message) => message.role === "user")?.content).includes("copy.txt")) {
			const step = messages.filter((message) => message.role === "tool").length;
			if (step < 3) {
				const proof = JSON.stringify(messages).match(/BENCHMARK_PROOF_[a-f0-9-]+/)?.[0];
				const name = step === 1 ? "write_file" : "read_file";
				const args =
					step === 1 ? { path: "copy.txt", content: proof + "\n" } : { path: step === 0 ? "proof.txt" : "copy.txt" };
				response.end(
					frame([
						{
							index: 0,
							delta: {
								role: "assistant",
								tool_calls: [
									{
										index: 0,
										id: `copy-${step}`,
										type: "function",
										function: { name, arguments: JSON.stringify(args) },
									},
								],
							},
							finish_reason: null,
						},
					]) +
						frame([{ index: 0, delta: {}, finish_reason: "tool_calls" }], {
							prompt_tokens: 100,
							completion_tokens: 4,
							total_tokens: 104,
						}) +
						"data: [DONE]\n\n"
				);
				return;
			}
		}
		response.end(
			frame([{ index: 0, delta: { role: "assistant", content: "HELLO_BENCHMARK" }, finish_reason: null }]) +
				frame([{ index: 0, delta: {}, finish_reason: "stop" }], {
					prompt_tokens: 100,
					completion_tokens: 4,
					total_tokens: 104,
				}) +
				"data: [DONE]\n\n"
		);
	});
	const root = await mkdtemp(join(tmpdir(), "wuming-task-runner-test-"));
	provider.listen(0, "127.0.0.1");
	await once(provider, "listening");
	try {
		const address = provider.address();
		assert.ok(address && typeof address !== "string");
		const key = "fixture-encryption-key-not-for-production";
		await writeFile(join(root, "custom-models.key"), key);
		const registry = new CustomModelRegistry({ filePath: join(root, "custom-models.enc"), encryptionKey: key });
		await registry.set({
			provider: "benchmark-fixture",
			id: "benchmark-fixture",
			name: "Benchmark fixture",
			api: "openai-completions",
			baseUrl: `http://127.0.0.1:${address.port}/v1`,
			apiKey: "fixture-secret-not-for-report",
			input: ["text"],
			contextWindow: 128000,
			maxOutputTokens: 2048,
		});
		const environment = {
			WUMING_PI_MODEL_SOURCE_DIR: root,
			WUMING_MODEL_PROVIDER: "benchmark-fixture",
			WUMING_MODEL_ID: "benchmark-fixture",
		};
		const output = join(root, "success.json");
		const success = await cli(
			["--run", "--cases", "no-unnecessary-tools", "--output", output, "--pause-ms", "0"],
			environment
		);
		assert.equal(success.code, 0, success.stderr + success.stdout);
		const report = JSON.parse(await readFile(output, "utf8"));
		assert.equal(report.summary.passed, 1);
		assert.equal(report.summary.totalTokens, 104);
		assert.equal(report.cases[0].toolCalls, 0);
		assert.equal(requests, 1);
		const repeated = await cli(["--run", "--cases", "no-unnecessary-tools", "--output", output], environment);
		assert.notEqual(repeated.code, 0);
		assert.equal(requests, 1, "existing report must fail before model call");
		const copyOutput = join(root, "copy.json");
		const copy = await cli(["--run", "--cases", "copy-exact", "--output", copyOutput, "--pause-ms", "0"], environment);
		assert.equal(copy.code, 0, copy.stderr + copy.stdout);
		const copyReport = JSON.parse(await readFile(copyOutput, "utf8"));
		assert.equal(copyReport.summary.passed, 1);
		assert.equal(copyReport.cases[0].toolCalls, 3);
		assert.equal(copyReport.cases[0].checks["read-write-verify"], true);
		for (const skip of [true, false]) {
			skipFirstTurn = skip;
			const multiOutput = join(root, `multi-${skip}.json`);
			const multi = await cli(
				["--run", "--cases", "follow-up-change", "--output", multiOutput, "--pause-ms", "0"],
				environment
			);
			assert.equal(multi.code, skip ? 1 : 0, multi.stderr + multi.stdout);
			const multiReport = JSON.parse(await readFile(multiOutput, "utf8"));
			assert.equal(multiReport.version, "local-file-tasks-v2");
			assert.equal(multiReport.cases[0].status, skip ? "behavior_failed" : "passed");
			assert.equal(multiReport.cases[0].checks["file:config.json"], true);
			assert.deepEqual(
				multiReport.cases[0].turns.map((turn: { passed: boolean }) => turn.passed),
				[!skip, true]
			);
		}
		fail = true;
		const failureOutput = join(root, "failure.json");
		const failure = await cli(
			["--run", "--cases", "read-proof-zh,read-proof-en,copy-exact", "--output", failureOutput, "--pause-ms", "0"],
			environment
		);
		assert.notEqual(failure.code, 0);
		const failedText = await readFile(failureOutput, "utf8");
		const failed = JSON.parse(failedText);
		assert.ok(failed.summary.providerFailed >= 1);
		assert.ok(failed.summary.notRun >= 1);
		assert.equal(failed.summary.passed, 0);
		assert.equal(failedText.includes("fixture-secret-not-for-report"), false);
		assert.equal((failure.stdout + failure.stderr).includes("fixture-secret-not-for-report"), false);
	} finally {
		provider.closeAllConnections();
		await new Promise<void>((done) => provider.close(() => done()));
		await rm(root, { recursive: true, force: true });
	}
});
