import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { WindowsSemanticDesktop, type SemanticState, type SemanticWindow } from "../src/computer-semantic.js";
import { runComputerProcess } from "../src/computer.js";

it.skipIf(process.platform !== "win32" || process.env.WUMING_TEST_UIA !== "1")(
	"edits and saves through real UIA, reports focus/input observations and excludes passwords",
	async () => {
		const directory = await mkdtemp(join(tmpdir(), "wuming-uia-integration-"));
		const exe = join(directory, "fixture.exe");
		const output = join(directory, "saved.txt");
		const framework = join(process.env.SystemRoot ?? "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319");
		await runComputerProcess(
			join(framework, "csc.exe"),
			[
				"/nologo",
				"/target:exe",
				`/out:${exe}`,
				"/r:System.Windows.Forms.dll",
				"/r:System.Drawing.dll",
				"/r:System.Web.Extensions.dll",
				fileURLToPath(new URL("./fixtures/ComputerUiaFixture.cs", import.meta.url)),
			],
			{ timeoutMs: 20_000 }
		);
		const fixture = spawn(exe, [output], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
		const exited = new Promise<void>((resolve) => fixture.once("close", () => resolve()));
		try {
			const target = await new Promise<SemanticWindow>((resolve, reject) => {
				let text = "";
				const timer = setTimeout(() => reject(new Error("Fixture startup timed out")), 10_000);
				fixture.once("error", (error) => {
					clearTimeout(timer);
					reject(error);
				});
				fixture.stdout.on("data", (chunk) => {
					text += String(chunk);
					if (text.includes("\n")) {
						clearTimeout(timer);
						resolve(JSON.parse(text.trim()).window);
					}
				});
			});
			const desktop = new WindowsSemanticDesktop(directory, runComputerProcess);
			const signal = AbortSignal.timeout(35_000);
			const inspect = () => desktop.call<SemanticState>({ command: "inspect", window: target }, signal);
			const state = await inspect();
			expect(JSON.stringify(state)).not.toContain("fixture-secret-must-not-leak");
			const input = state.elements.find((element) => element.automationId === "TestInput");
			expect(input?.actions).toContain("set_value");
			const changed = await desktop.call<{
				performed: boolean;
				verified: boolean;
				verification: string;
				state: SemanticState;
				foregroundChanged: boolean;
				cursorMoved: boolean;
			}>(
				{ command: "action", window: target, element: input, kind: "set_value", value: "UIA verified \u4e2d\u6587" },
				signal
			);
			expect(changed.performed).toBe(true);
			expect(changed.verified).toBe(true);
			expect(changed.verification).toBe("expected_state_observed");
			expect(changed.state.elements.find((element) => element.automationId === "TestInput")?.value).toBe(
				"UIA verified \u4e2d\u6587"
			);
			const save = changed.state.elements.find((element) => element.automationId === "TestSave");
			expect(save?.actions).toContain("invoke");
			const saved = await desktop.call<{
				performed: boolean;
				verified: null;
				foregroundChanged: boolean;
				cursorMoved: boolean;
			}>({ command: "action", window: target, element: save, kind: "invoke" }, signal);
			expect(saved.performed).toBe(true);
			expect(saved.verified).toBeNull();
			expect(await readFile(output, "utf8")).toBe("UIA verified \u4e2d\u6587");
			const evidence = JSON.parse(await readFile(output + ".evidence.json", "utf8"));
			// Native UIA providers are allowed to activate windows. Require explicit telemetry,
			// rather than falsely claiming that a successful semantic call is always background.
			expect(typeof changed.foregroundChanged).toBe("boolean");
			expect(typeof saved.foregroundChanged).toBe("boolean");
			expect(typeof changed.cursorMoved).toBe("boolean");
			expect(typeof saved.cursorMoved).toBe("boolean");
			// Shared interactive desktops can receive real user input during a test.
			// Enable strict cursor assertions only on an explicitly idle test machine.
			if (process.env.WUMING_UIA_ASSERT_CURSOR_STILL === "1") {
				expect(changed.cursorMoved).toBe(false);
				expect(saved.cursorMoved).toBe(false);
				expect(evidence.cursorAfter).toEqual(evidence.cursorBefore);
			}
			console.info("Native UIA verification", {
				setValue: changed.performed,
				save: saved.performed,
				foregroundChanged: changed.foregroundChanged || saved.foregroundChanged,
				cursorMoved: changed.cursorMoved || saved.cursorMoved,
			});
			await expect(
				desktop.call(
					{ command: "action", window: target, element: input, kind: "set_value", value: "stale must not overwrite" },
					signal
				)
			).rejects.toThrow();
			expect((await inspect()).elements.find((element) => element.automationId === "TestInput")?.value).toBe(
				"UIA verified \u4e2d\u6587"
			);
			const delayed = (await inspect()).elements.find((element) => element.automationId === "DelayedInput");
			const waited = await desktop.call<{
				performed: boolean;
				verified: boolean;
				waitedMs: number;
				state: SemanticState;
			}>(
				{ command: "action", window: target, element: delayed, kind: "set_value", value: "delayed-confirmation" },
				signal
			);
			expect(waited).toMatchObject({ performed: true, verified: true });
			expect(waited.state.elements.find((element) => element.automationId === "DelayedInput")?.value).toBe(
				"delayed-confirmation"
			);
			const refused = await desktop.call<{
				performed: boolean;
				verified: boolean;
				outcome: string;
				verification: string;
				state: SemanticState;
			}>(
				{
					command: "action",
					window: target,
					element: waited.state.elements.find((element) => element.automationId === "DelayedInput"),
					kind: "set_value",
					value: "refused-value",
				},
				signal
			);
			expect(refused).toMatchObject({
				performed: true,
				verified: false,
				outcome: "unknown",
				verification: "expected_state_timeout",
			});
			expect(refused.state.elements.find((element) => element.automationId === "DelayedInput")?.value).toBe("pending");
		} finally {
			fixture.kill();
			await exited;
			await rm(directory, { recursive: true, force: true });
		}
	},
	55_000
);
