import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { diagnoseMissingExecutable, WorkspaceEnvironmentInspector } from "../src/index.js";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("environment diagnostics", () => {
	it.each([
		["'pnpm' is not recognized as an internal or external command", "pnpm"],
		["'pnpm' 不是内部或外部命令，也不是可运行的程序或批处理文件。", "pnpm"],
		["/bin/sh: 1: pnpm: not found", "pnpm"],
		["bash: pnpm: command not found", "pnpm"],
	])("identifies a missing executable from shell output", (output, expected) => {
		expect(diagnoseMissingExecutable("pnpm install", output, 127)).toMatchObject({
			code: "tool_missing",
			tool: expected,
			requiredBy: "pnpm install",
		});
	});

	it("reports project markers without reading environment values", async () => {
		const root = await mkdtemp(join(tmpdir(), "wuming-environment-"));
		roots.push(root);
		await writeFile(
			join(root, "package.json"),
			JSON.stringify({ packageManager: "pnpm@10.0.0", engines: { node: ">=22" } })
		);
		await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
		await writeFile(join(root, ".env.example"), "SECRET=example\n");
		await writeFile(join(root, ".env"), "SECRET=must-not-leak\n");

		const report = await new WorkspaceEnvironmentInspector({
			workspaceRoot: root,
			cacheTtlMs: 1,
		}).inspect();

		expect(report.project).toMatchObject({
			kinds: ["node"],
			packageManager: "pnpm@10.0.0",
			nodeRequirement: ">=22",
			nodeDependenciesInstalled: false,
			envExamplePresent: true,
			envFilePresent: true,
		});
		expect(JSON.stringify(report)).not.toContain("must-not-leak");
	});
});
