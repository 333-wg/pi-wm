import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { getMakeNsisPath, getNsisPluginsPath } from "app-builder-lib/out/toolsets/windows.js";
import { NsisScriptGenerator } from "app-builder-lib/out/targets/nsis/nsisScriptGenerator.js";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../../..", import.meta.url));
const fixtures = fileURLToPath(new URL("./fixtures", import.meta.url));

test(
	"native update progress and restart use isolated files without installing the product",
	{
		skip: process.platform !== "win32",
		timeout: 120_000,
	},
	async (t) => {
		const parent = await realpath(tmpdir());
		const directory = await mkdtemp(join(parent, "pi-ui-"));
		try {
			const compiler = await getMakeNsisPath();
			const plugins = await getNsisPluginsPath();
			const header = new NsisScriptGenerator();
			header.addPluginDir("x86-unicode", join(plugins, "x86-unicode"));
			header.include(join(root, "node_modules/app-builder-lib/templates/nsis/include/StdUtils.nsh"));
			header.flags(["updated", "force-run"]);
			const include = join(directory, "header.nsh");
			await writeFile(include, header.build());
			const app = join(directory, "app.exe");
			const installer = join(directory, "progress.exe");
			const compile = (args) =>
				exec(compiler.path, ["/V2", "-INPUTCHARSET", "UTF8", ...args], {
					env: { ...process.env, ...compiler.env },
					windowsHide: true,
				});
			await compile([`/DPROBE_OUTPUT=${app}`, join(fixtures, "update-ui-app.nsi")]);
			await compile([
				`/DBUILDER_HEADER=${include}`,
				`/DPROBE_OUTPUT=${installer}`,
				`/DPROBE_APP=${app}`,
				`/DUPDATE_PATHS=${join(root, "apps/desktop/installer/update-paths.nsh")}`,
				`/DUPDATE_UI=${join(root, "apps/desktop/installer/update-ui.nsh")}`,
				"/DPRODUCT_FILENAME=UpdateFixture",
				"/DVERSION=0.0.0-test",
				join(fixtures, "update-ui.nsi"),
			]);
			let count = 0;
			async function run(args, { mode = "success", language = "2052", scope = "current" } = {}) {
				const scenario = join(directory, String(count++));
				await mkdir(scenario);
				await writeFile(join(scenario, "fixture.marker"), "isolated-test");
				await exec(installer, args, {
					cwd: scenario,
					timeout: 20_000,
					windowsHide: true,
					env: {
						...process.env,
						PI_WM_TEST_ROOT: scenario,
						PI_WM_TEST_MODE: mode,
						PI_WM_TEST_LANGUAGE: language,
						PI_WM_TEST_SCOPE: scope,
						PI_WM_TEST_HOLD_MS: "250",
					},
				});
				return { scenario, log: await readFile(join(scenario, "installer.log"), "utf16le") };
			}
			for (const [name, args, options] of [
				["new updater", ["--updated", "--force-run"], {}],
				["legacy silent updater", ["--updated", "/S", "--force-run"], {}],
				[
					"English update with existing all-user scope",
					["--updated", "--force-run"],
					{ language: "1033", scope: "all" },
				],
			])
				await t.test(name, async () => {
					const { scenario, log } = await run(args, options);
					assert.match(log, /visual=1/);
					assert.match(log, /silent=0/);
					assert.match(log, /visible=1/);
					assert.match(log, options.scope === "all" ? /machine=1; user=/ : /machine=; user=1/);
					assert.match(log, options.language === "1033" ? /title=Updating Pi-Wm/ : /title=正在更新 Pi-Wm/);
					assert.match(log, options.language === "1033" ? /stage=Verifying installed files/ : /stage=正在校验安装文件/);
					assert.match(log, /updated-app-launch=(ok|fallback)/);
					let launched;
					for (let attempt = 0; attempt < 50; attempt++) {
						launched = await readFile(join(scenario, "launch.log"), "utf16le").catch((error) => {
							if (error.code !== "ENOENT") throw error;
						});
						if (launched) break;
						await delay(100);
					}
					assert.equal(launched, "launched=--updated\r\n");
				});
			for (const args of [["/S"], ["/S", "--updated"], ["/S", "--force-run"]])
				await t.test("ordinary silent invocation: " + args.join(" "), async () => {
					const { scenario, log } = await run(args);
					assert.match(log, /visual=; machine=; user=/);
					assert.match(log, /silent=1/);
					assert.doesNotMatch(log, /updated-app-launch/);
					await assert.rejects(access(join(scenario, "launch.log")), { code: "ENOENT" });
				});
			await t.test("unverified files never trigger an automatic restart", async () => {
				const { scenario, log } = await run(["--updated", "--force-run"], { mode: "unverified" });
				assert.match(log, /unverified-returned/);
				assert.doesNotMatch(log, /updated-app-launch/);
				await assert.rejects(access(join(scenario, "launch.log")), { code: "ENOENT" });
			});
		} finally {
			assert.equal(dirname(directory), parent);
			assert.ok(basename(directory).startsWith("pi-ui-"));
			assert.equal(await realpath(directory), directory);
			await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
		}
	}
);
