import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionOrchestrator, SqliteOrchestratorStore } from "@wuming/orchestrator";
import { GatewayServer } from "../src/server.js";
import { StaticTokenMapAuth } from "../src/auth.js";
import type { ComputerUseStatus } from "@wuming/protocol";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function start(placement: "local_device" | "server" = "local_device") {
	const store = new SqliteOrchestratorStore(":memory:");
	cleanups.push(() => store.close());
	let state: ComputerUseStatus = {
		supported: true,
		enabled: false,
		ready: true,
		installing: false,
		platform: "win32",
		python: "python",
	};
	const computer = {
		status: () => state,
		refresh: vi.fn(async () => state),
		setEnabled: vi.fn((enabled: boolean) => (state = { ...state, enabled })),
		stop: vi.fn(() => (state = { ...state, enabled: false })),
		install: vi.fn(() => (state = { ...state, enabled: false, installing: true })),
	};
	const server = new GatewayServer({
		store,
		computer,
		orchestrator: new SessionOrchestrator(store, { executeTurn: async () => ({ items: [] }) }),
		auth: new StaticTokenMapAuth([
			{ token: "owner", principal: { id: "o", role: "owner", workspaces: [] } },
			{ token: "member", principal: { id: "m", role: "member", workspaces: [] } },
		]),
		executionEnvironment: {
			placement,
			processMode: "local",
			terminalMode: "disabled",
			previewEnabled: false,
			platform: "win32",
			shell: "powershell",
		},
	});
	const address = await server.listen();
	cleanups.push(() => server.close());
	const request = (path = "", method = "GET", token = "owner", body?: string, origin?: string) =>
		fetch(`http://127.0.0.1:${address.port}/api/computer-use${path}`, {
			method,
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
				...(origin ? { Origin: origin } : {}),
			},
			...(body === undefined ? {} : { body }),
		});
	return { request, computer };
}

describe("Computer Use settings API", () => {
	it("requires local owner authentication and checks origins before changing state", async () => {
		const { request, computer } = await start();
		expect((await request("", "GET", "wrong")).status).toBe(401);
		expect((await request("/enable", "POST", "member", '{"enabled":true}')).status).toBe(403);
		expect((await request("/install", "POST", "owner", undefined, "https://attacker.example")).status).toBe(403);
		expect(computer.setEnabled).not.toHaveBeenCalled();
		expect(computer.install).not.toHaveBeenCalled();
	});
	it("validates enable requests, refreshes readiness, installs and stops", async () => {
		const { request, computer } = await start();
		for (const body of ["{}", '{"enabled":"yes"}', '{"enabled":true,"command":"anything"}', "bad"])
			expect((await request("/enable", "POST", "owner", body)).status).toBe(400);
		expect((await request("/enable", "GET")).status).toBe(405);
		expect(await (await request("/enable", "POST", "owner", '{"enabled":true}')).json()).toMatchObject({
			enabled: true,
		});
		expect(await (await request("?refresh=1")).json()).toMatchObject({ ready: true });
		expect(computer.refresh).toHaveBeenCalledTimes(1);
		expect(await (await request("/stop", "POST")).json()).toMatchObject({ enabled: false });
		const install = await request("/install", "POST");
		expect(install.status).toBe(202);
		expect(await install.json()).toMatchObject({ installing: true });
	});
	it("never exposes desktop execution on server deployments", async () => {
		const { request, computer } = await start("server");
		expect(await (await request()).json()).toMatchObject({ supported: false, enabled: false });
		expect((await request("/enable", "POST", "owner", '{"enabled":true}')).status).toBe(409);
		expect(computer.setEnabled).not.toHaveBeenCalled();
	});
});
