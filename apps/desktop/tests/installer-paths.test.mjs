import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, realpath, rm, access, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { getMakeNsisPath } from "app-builder-lib/out/toolsets/windows.js";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../../..", import.meta.url));
const fixtures = fileURLToPath(new URL("./fixtures", import.meta.url));
const relative =
	"resources/runtime/node_modules/@earendil-works/pi-coding-agent/node_modules/@aws-sdk/core/dist-types/ts3.4/submodules/client/middleware-recursion-detection/recursionDetectionMiddleware.browser.d.ts";
const parse = (text) =>
	Object.fromEntries(
		text
			.trim()
			.split(/\r?\n/)
			.filter((line) => line.includes("="))
			.map((line) => {
				const i = line.indexOf("=");
				return [line.slice(0, i), line.slice(i + 1)];
			})
	);

test(
	"legacy NSIS rollback inherits extended TEMP without changing application or system settings",
	{ skip: process.platform !== "win32", timeout: 180000 },
	async (t) => {
		const parent = await realpath(tmpdir());
		const directory = await mkdtemp(join(parent, "p-"));
		const compiler = await getMakeNsisPath();
		const env = { ...process.env, ...compiler.env };
		try {
			const template = await readFile(
				join(root, "node_modules/app-builder-lib/templates/nsis/uninstaller.nsh"),
				"utf8"
			);
			const functions = template.slice(
				template.indexOf("Function un.atomicRMDir"),
				template.indexOf("!ifndef UNINSTALL_SECTION_NAME")
			);
			assert.match(functions, /Rename "\$INSTDIR\$R0\\\$R2" "\$PLUGINSDIR\\old-install/);
			const include = join(directory, "legacy-functions.nsh");
			await writeFile(include, functions);
			const generator = join(directory, "generate.exe");
			const executable = join(directory, "parent.exe");
			await exec(
				compiler.path,
				["/V2", `/DLEGACY_FUNCTIONS=${include}`, `/DPROBE_OUTPUT=${generator}`, join(fixtures, "legacy-update.nsi")],
				{ windowsHide: true, env }
			);
			await exec(generator, [], { cwd: directory, windowsHide: true });
			await exec(
				compiler.path,
				[
					"/V2",
					`/DUPDATE_PATHS=${join(root, "apps/desktop/installer/update-paths.nsh")}`,
					`/DPROBE_OUTPUT=${executable}`,
					join(fixtures, "update-path-parent.nsi"),
				],
				{ windowsHide: true, env }
			);
			let counter = 0;
			async function run(mode, { path, link = false } = {}) {
				const scenario = join(directory, String(counter++));
				await mkdir(scenario);
				await writeFile(join(scenario, "fixture.marker"), "isolated-test");
				const app = join(scenario, "app");
				// The original path must still fit the old uninstaller's non-extended source buffer.
				assert.ok(join(app, relative).length < 260);
				await mkdir(dirname(join(app, relative)), { recursive: true });
				await writeFile(join(app, relative), "test data");
				await writeFile(join(app, "locked.txt"), "keep if locked");
				if (link) await symlink(directory, join(app, "link"), "junction");
				const temp = join(directory, "long user temporary directory");
				await mkdir(temp, { recursive: true });
				const originalTmp = join(directory, "different-tmp-\u7528\u6237");
				await mkdir(originalTmp, { recursive: true });
				await exec(executable, [], {
					cwd: directory,
					windowsHide: true,
					timeout: 30000,
					env: {
						...process.env,
						TEMP: temp,
						TMP: originalTmp,
						PI_WM_TEST_ROOT: scenario,
						PI_WM_TEST_MODE: mode,
						PI_WM_TEST_PATH: path ?? "",
					},
				});
				const state = parse(await readFile(join(scenario, "parent.log"), "utf16le"));
				assert.equal(state.restoredTEMP, temp);
				assert.equal(state.restoredTMP, originalTmp);
				const child = await readFile(join(scenario, "child.log"), "utf16le")
					.then(parse)
					.catch((error) => {
						if (error.code === "ENOENT") return undefined;
						throw error;
					});
				return { state, child, app, temp: originalTmp };
			}
			await t.test("unmodified legacy environment reproduces exit 2", async () => {
				const { state, app } = await run("control");
				assert.equal(state.childExit, "2");
				assert.equal(await readFile(join(app, relative), "utf8"), "test data");
			});
			await t.test("real legacy child, native plugins and PowerShell succeed after preparation", async () => {
				const { state, child, app, temp } = await run("fixed");
				assert.equal(state.childExit, "0");
				assert.equal(child.temp, "\\\\?\\" + temp);
				assert.equal(child.powershellExit, "0");
				assert.equal(child.failure, "0");
				await assert.rejects(access(join(app, relative)), { code: "ENOENT" });
			});
			await t.test("genuine locked-file failure still rolls back and restores environment", async () => {
				const { state, app } = await run("locked");
				assert.equal(state.childExit, "2");
				assert.equal(await readFile(join(app, "locked.txt"), "utf8"), "keep if locked");
				assert.equal(await readFile(join(app, relative), "utf8"), "test data");
			});
			for (const mode of ["cancel", "missing-temp"])
				await t.test(mode + " leaves old files untouched", async () => {
					const { child, app } = await run(mode);
					assert.equal(child, undefined);
					assert.equal(await readFile(join(app, relative), "utf8"), "test data");
				});
			await t.test("preflight refuses a junction without traversing or deleting it", async () => {
				const { state, child, app } = await run("fixed", { link: true });
				assert.equal(state.preflight, "installed-reparse-point");
				assert.equal(child, undefined);
				await rm(join(app, "link"));
			});
			for (const [path, normalized, error] of [
				["C:\\Users\\Example\\Temp", "\\\\?\\C:\\Users\\Example\\Temp", ""],
				["\\\\server\\share\\Temp", "\\\\?\\UNC\\server\\share\\Temp", ""],
				["\\\\?\\C:\\Temp", "\\\\?\\C:\\Temp", ""],
				["relative\\Temp", "relative\\Temp", "unsupported-temp-path"],
				["\\\\.\\PhysicalDrive0", "\\\\.\\PhysicalDrive0", "unsupported-temp-path"],
			])
				await t.test("normalize " + path, async () => {
					const { state } = await run("normalize", { path });
					assert.equal(state.normalized, normalized);
					assert.equal(state.error, error);
				});
		} finally {
			assert.equal(dirname(await realpath(directory)), parent);
			await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
		}
	}
);
