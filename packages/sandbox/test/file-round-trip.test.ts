import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { SessionOrchestrator, SqliteOrchestratorStore } from "@wuming/orchestrator";
import { expect, it } from "vitest";
import { ApprovalBroker, createSandboxTools, WorkspaceFileExecutor } from "../src/index.js";

it.each(["WUMING_FILE_PROOF_12345678-1234-1234-1234-123456789012\n", "中文🙂\r\n第二行\r\n"])(
	"preserves exact file contents through real read/write tools: %j",
	async (proof) => {
		const workspace = await mkdtemp(join(tmpdir(), "wuming-file-tools-test-"));
		const store = new SqliteOrchestratorStore(":memory:");
		try {
			await writeFile(join(workspace, "input.txt"), proof, "utf8");
			const orchestrator = new SessionOrchestrator(store, {
				async executeTurn() {
					return { items: [] };
				},
			});
			const { snapshot } = await orchestrator.createSession({
				principalId: "test",
				idempotencyKey: "create",
				workspaceId: "test",
				model: { provider: "test", id: "test" },
				thinkingLevel: "off",
				sandboxMode: "workspace_write",
				approvalPolicy: "never",
			});
			const files = await WorkspaceFileExecutor.create(workspace, {
				maxReadBytes: 4096,
				maxWriteBytes: 4096,
			});
			const tools = createSandboxTools({
				snapshot,
				executor: { files },
				approvals: new ApprovalBroker({ store }),
			});
			const context = undefined as unknown as Parameters<ToolDefinition["execute"]>[4];
			const read = tools.find((tool) => tool.name === "read_file")!;
			const write = tools.find((tool) => tool.name === "write_file")!;
			const first = await read.execute("read-input", { path: "input.txt" }, undefined, undefined, context);
			const text = first.content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("");
			expect(text).toBe(proof);
			await write.execute("write-output", { path: "output.txt", content: text }, undefined, undefined, context);
			expect(await readFile(join(workspace, "output.txt"), "utf8")).toBe(proof);
			const last = await read.execute("read-output", { path: "output.txt" }, undefined, undefined, context);
			expect(last.content).toEqual(first.content);
		} finally {
			store.close();
			await rm(workspace, { recursive: true, force: true });
		}
	}
);
