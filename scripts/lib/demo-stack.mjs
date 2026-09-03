// Boots a throwaway Wuming stack for the browser-driven scripts.
//
// Gateway plus Vite dev server on dynamic ports, with a seeded git workspace and
// a disposable data directory. The runtime is pinned to `demo`, so nothing here
// can reach a paid provider.
//
// Shared by `scripts/ui-shots.mjs` and `scripts/contrast-crawl.mjs`: both need
// the same app in the same state, and a second copy of this would drift.

import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const readyTimeoutMs = 120_000;

function startService({ name, command, args, cwd, env, ready }) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd,
			env: { ...process.env, ...env },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let buffer = "";
		let settled = false;
		const finish = (error, value) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (error) reject(error);
			else resolve(value);
		};
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish(new Error(`${name} never became ready\n${buffer}`));
		}, readyTimeoutMs);
		const inspect = (chunk) => {
			buffer += String(chunk);
			const match = ready.exec(buffer);
			if (match) finish(null, { name, child, port: Number(match[1]) });
		};
		child.stdout.on("data", inspect);
		child.stderr.on("data", inspect);
		child.on("error", (error) => finish(error));
		child.on("exit", (code, signal) =>
			finish(new Error(`${name} exited early (code=${code} signal=${signal})\n${buffer}`)),
		);
	});
}

function stopService(service) {
	if (!service || service.child.exitCode !== null) return Promise.resolve();
	return new Promise((resolve) => {
		const done = setTimeout(() => {
			service.child.kill("SIGKILL");
			resolve();
		}, 5000);
		service.child.once("exit", () => {
			clearTimeout(done);
			resolve();
		});
		service.child.kill("SIGTERM");
	});
}

/** Seeds a file tree plus one uncommitted edit, so `@` mentions and the diff view have something to show. */
async function seedWorkspace(workspace) {
	await mkdir(join(workspace, "src"), { recursive: true });
	await writeFile(
		join(workspace, "README.md"),
		"# 演示工作区\n\n这是截图夹具使用的临时工作区。\n",
		"utf8",
	);
	await writeFile(
		join(workspace, "src", "index.ts"),
		[
			"export interface Session {",
			"\tid: string;",
			"\ttitle: string;",
			"}",
			"",
			"export function describe(session: Session): string {",
			"\treturn `${session.title} (${session.id})`;",
			"}",
			"",
		].join("\n"),
		"utf8",
	);
	const run = (args) =>
		new Promise((resolve) => {
			const child = spawn("git", args, { cwd: workspace, stdio: "ignore" });
			child.on("error", () => resolve(false));
			child.on("exit", (code) => resolve(code === 0));
		});
	if (!(await run(["init", "--quiet"]))) return;
	await run(["config", "user.email", "shots@example.invalid"]);
	await run(["config", "user.name", "Shots"]);
	await run(["add", "."]);
	await run(["commit", "--quiet", "-m", "seed"]);
	await writeFile(
		join(workspace, "src", "index.ts"),
		[
			"export interface Session {",
			"\tid: string;",
			"\ttitle: string;",
			"\tarchived: boolean;",
			"}",
			"",
			"export function describe(session: Session): string {",
			"\tconst suffix = session.archived ? \" [已归档]\" : \"\";",
			"\treturn `${session.title} (${session.id})${suffix}`;",
			"}",
			"",
		].join("\n"),
		"utf8",
	);
}

/**
 * Seeds the browser storage both browser-driven scripts need before the app's
 * first paint: the bearer token, the theme override, and the onboarding flag.
 *
 * The onboarding flag matters more than it looks. Without it the 首次设置 dialog
 * opens over the app and its backdrop intercepts every click, so a walkthrough
 * cannot reach any surface at all. It lives here rather than in each caller
 * because a walkthrough that works under screenshots but not under the contrast
 * crawl is exactly the drift this module exists to prevent.
 */
export function seedBrowser(context, { token, theme = null } = {}) {
	return context.addInitScript(
		([value, mode]) => {
			localStorage.setItem("wuming.token", value);
			if (mode) localStorage.setItem("wuming.theme", mode);
			localStorage.setItem("wuming.onboarding.complete", "true");
		},
		[token, theme],
	);
}

/**
 * Starts the stack and resolves once the web server is serving.
 *
 * `token` is the value the caller must seed into `localStorage["wuming.token"]`.
 * `stop({ keep })` shuts both services down and removes the temporary trees.
 */
export async function startDemoStack({ token, log = () => {} } = {}) {
	const workspace = await mkdtemp(join(tmpdir(), "wuming-stack-workspace-"));
	const data = await mkdtemp(join(tmpdir(), "wuming-stack-data-"));
	await seedWorkspace(workspace);

	let gateway;
	let web;
	const stop = async ({ keep = false } = {}) => {
		await stopService(web);
		await stopService(gateway);
		if (keep) return;
		await rm(workspace, { recursive: true, force: true }).catch(() => {});
		await rm(data, { recursive: true, force: true }).catch(() => {});
	};

	try {
		gateway = await startService({
			name: "gateway",
			command: process.execPath,
			args: ["--import", "tsx", join(repositoryRoot, "apps/gateway/src/main.ts")],
			cwd: repositoryRoot,
			env: {
				WUMING_HOST: "127.0.0.1",
				WUMING_PORT: "0",
				WUMING_TOKEN: token,
				WUMING_RUNTIME: "demo",
				WUMING_WORKSPACE: workspace,
				WUMING_DATA_DIR: data,
				WUMING_TERMINAL_MODE: process.env.WUMING_TERMINAL_MODE ?? "host",
				WUMING_RETRY_BASE_DELAY_MS: "10",
				// A deliberately small window so the context meter moves visibly
				// within the handful of turns one walkthrough performs.
				WUMING_CONTEXT_WINDOW: process.env.WUMING_CONTEXT_WINDOW ?? "5000",
			},
			ready: /Wuming gateway listening on http:\/\/127\.0\.0\.1:(\d+)/,
		});
		log(`gateway on ${gateway.port}\n`);

		web = await startService({
			name: "web",
			command: process.execPath,
			args: [
				join(repositoryRoot, "node_modules/vite/bin/vite.js"),
				"--host",
				"127.0.0.1",
				"--port",
				"0",
				"--strictPort",
			],
			cwd: join(repositoryRoot, "apps/web"),
			env: { WUMING_GATEWAY_URL: `http://127.0.0.1:${gateway.port}` },
			ready: /Local:\s+http:\/\/127\.0\.0\.1:(\d+)\//,
		});
		log(`web on ${web.port}\n`);
		return { url: `http://127.0.0.1:${web.port}/`, workspace, data, stop };
	} catch (error) {
		await stop();
		throw error;
	}
}
