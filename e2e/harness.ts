import { expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Booting the gateway and the dev server for a spec file, extracted so a new
// spec does not have to carry another copy. `wuming.spec.ts` still has its own
// and can drop it the next time it is touched.

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const services: ChildProcess[] = [];
let temporaryRoot: string | undefined;
let gatewayProcess: ChildProcess | undefined;
let gatewayRestartEnvironment: Record<string, string> | undefined;

/** The password both the gateway and the seeded browser storage use. */
export const token = "wuming-e2e-token";

/** Playwright forces colored child output, so escapes must go before matching a readiness banner. */
function plainText(value: string): string {
	return value.replaceAll(new RegExp("\\u001B\\[[0-9;]*m", "g"), "");
}

async function startService(
	name: string,
	args: string[],
	cwd: string,
	environment: Record<string, string>,
	readyPattern: RegExp
): Promise<RegExpMatchArray> {
	const child = spawn(process.execPath, args, {
		cwd,
		env: { ...process.env, ...environment },
		stdio: ["ignore", "pipe", "pipe"],
	});
	services.push(child);
	let output = "";
	const collect = (chunk: unknown) => {
		output += String(chunk);
	};
	child.stdout?.on("data", collect);
	child.stderr?.on("data", collect);
	return await new Promise<RegExpMatchArray>((resolveMatch, reject) => {
		const timeout = setTimeout(() => reject(new Error(`${name} startup timed out\n${plainText(output)}`)), 20_000);
		const inspect = () => {
			const found = plainText(output).match(readyPattern);
			if (!found) return;
			clearTimeout(timeout);
			resolveMatch(found);
		};
		child.stdout?.on("data", inspect);
		child.stderr?.on("data", inspect);
		child.once("exit", (code) => {
			clearTimeout(timeout);
			reject(new Error(`${name} exited during startup with code ${code}\n${plainText(output)}`));
		});
	});
}

/** Starts a gateway on the demo runtime plus the dev server in front of it. */
export async function startWebApp(
	gatewayEnvironment: Record<string, string> = {},
	prepareWorkspace?: (workspace: string) => Promise<void>
): Promise<string> {
	temporaryRoot = await mkdtemp(join(tmpdir(), "wuming-web-e2e-"));
	const workspace = join(temporaryRoot, "workspace");
	const data = join(temporaryRoot, "data");
	await Promise.all([mkdir(workspace), mkdir(data)]);
	await writeFile(join(workspace, "readme.md"), "# E2E\n", "utf8");
	await prepareWorkspace?.(workspace);
	const environment = {
		WUMING_HOST: "127.0.0.1",
		WUMING_PORT: "0",
		WUMING_TOKEN: token,
		WUMING_RUNTIME: "demo",
		WUMING_WORKSPACE: workspace,
		WUMING_DATA_DIR: data,
		WUMING_TERMINAL_MODE: "disabled",
		...gatewayEnvironment,
	};
	const gateway = await startService(
		"Gateway",
		["--import", "tsx", join(repositoryRoot, "apps/gateway/src/main.ts")],
		repositoryRoot,
		environment,
		/Wuming gateway listening on http:\/\/127\.0\.0\.1:(\d+)/
	);
	gatewayProcess = services[services.length - 1];
	gatewayRestartEnvironment = { ...environment, WUMING_PORT: gateway[1]! };
	const web = await startService(
		"Web",
		[join(repositoryRoot, "node_modules/vite/bin/vite.js"), "--host", "127.0.0.1", "--port", "0", "--strictPort"],
		join(repositoryRoot, "apps/web"),
		{ WUMING_GATEWAY_URL: `http://127.0.0.1:${Number(gateway[1])}` },
		/Local:\s+http:\/\/127\.0\.0\.1:(\d+)\//
	);
	return `http://127.0.0.1:${Number(web[1])}/`;
}

/** Abruptly replaces only this harness-owned gateway, preserving its DB and port. */
export async function restartGateway(): Promise<void> {
	if (!gatewayProcess || !gatewayRestartEnvironment) throw new Error("No test gateway to restart");
	if (gatewayProcess.exitCode === null && gatewayProcess.signalCode === null) {
		const exited = once(gatewayProcess, "exit");
		gatewayProcess.kill("SIGKILL");
		await exited;
	}
	await startService(
		"Gateway restart",
		["--import", "tsx", join(repositoryRoot, "apps/gateway/src/main.ts")],
		repositoryRoot,
		gatewayRestartEnvironment,
		/Wuming gateway listening on http:\/\/127\.0\.0\.1:(\d+)/
	);
	gatewayProcess = services[services.length - 1];
}

export async function stopWebApp(): Promise<void> {
	for (const child of services.splice(0).reverse()) {
		if (child.exitCode !== null || child.signalCode !== null) continue;
		child.kill("SIGTERM");
		await Promise.race([once(child, "exit"), new Promise((done) => setTimeout(done, 5_000))]);
		if (child.exitCode === null && child.signalCode === null) {
			child.kill("SIGKILL");
			await once(child, "exit");
		}
	}
	if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
	temporaryRoot = undefined;
	gatewayProcess = undefined;
	gatewayRestartEnvironment = undefined;
}

/** Opens the app with the password and onboarding already settled. */
export async function openApp(page: Page, url: string): Promise<void> {
	await page.addInitScript((value) => localStorage.setItem("wuming.token", value), token);
	await page.addInitScript(() => localStorage.setItem("wuming.onboarding.complete", "true"));
	await page.goto(url);
	// The closed mobile drawer is intentionally hidden, including its status row.
	await expect(page.locator(".connection")).toHaveClass(/(?:^|\s)connected(?:\s|$)/);
}
