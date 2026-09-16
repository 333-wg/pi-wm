import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionOrchestrator, SqliteOrchestratorStore, type AgentRuntime } from "@wuming/orchestrator";
import { StaticTokenMapAuth } from "../src/auth.js";
import { GatewayServer, type GatewayProjectService } from "../src/server.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture(placement: "local_device" | "server" = "local_device", available = true) {
	const workspace = { id: "project-1", name: "Imported", status: "ready" as const, createdAt: 1, updatedAt: 1 };
	const openFolder = vi.fn<NonNullable<GatewayProjectService["openFolder"]>>().mockResolvedValue();
	const store = new SqliteOrchestratorStore(":memory:");
	cleanup.push(() => store.close());
	const runtime: AgentRuntime = { executeTurn: async () => ({ items: [] }) };
	const server = new GatewayServer({
		auth: new StaticTokenMapAuth([
			{ token: "owner", principal: { id: "owner", role: "owner", workspaces: [workspace] } },
			{ token: "viewer", principal: { id: "viewer", role: "viewer", workspaces: [workspace] } },
		]),
		store,
		orchestrator: new SessionOrchestrator(store, runtime),
		executionEnvironment: {
			placement,
			processMode: "disabled",
			terminalMode: "disabled",
			previewEnabled: false,
			platform: process.platform,
			shell: "",
		},
		projects: {
			...(available ? { openFolder } : {}),
			pick: vi.fn(),
			create: vi.fn(),
			writeFile: vi.fn(),
			complete: vi.fn(),
			rename: vi.fn(),
			remove: vi.fn(),
		},
	});
	const address = await server.listen();
	cleanup.push(() => server.close());
	const request = (token = "owner", id = workspace.id, options: RequestInit = {}) =>
		fetch(`http://127.0.0.1:${address.port}/api/projects/${encodeURIComponent(id)}/open-folder`, {
			method: "POST",
			...options,
			headers: { Authorization: `Bearer ${token}`, ...options.headers },
		});
	return { request, openFolder };
}

describe("project folder endpoint", () => {
	it("opens only the authorized project and ignores client-supplied paths", async () => {
		const { request, openFolder } = await fixture();
		expect((await request("owner", "project-1", { body: JSON.stringify({ path: "C:\\other" }) })).status).toBe(204);
		expect(openFolder).toHaveBeenCalledExactlyOnceWith("owner", "project-1");
	});

	it("requires authentication, write permission, project access and a trusted origin", async () => {
		const { request, openFolder } = await fixture();
		expect((await request("bad")).status).toBe(401);
		expect((await request("viewer")).status).toBe(403);
		expect((await request("owner", "unknown")).status).toBe(403);
		expect((await request("owner", "project-1", { headers: { Origin: "https://evil.invalid" } })).status).toBe(403);
		const response = await request("owner", "project-1", { method: "GET" });
		expect(response.status).toBe(405);
		expect(response.headers.get("allow")).toBe("POST");
		expect(openFolder).not.toHaveBeenCalled();
	});

	it.each([
		["server", true],
		["local_device", false],
	] as const)("rejects unavailable opening: %s, %s", async (placement, available) => {
		const { request, openFolder } = await fixture(placement, available);
		expect((await request()).status).toBe(403);
		expect(openFolder).not.toHaveBeenCalled();
	});

	it("returns actionable errors from the file manager", async () => {
		const { request, openFolder } = await fixture();
		openFolder.mockRejectedValueOnce(Object.assign(new Error("项目目录不存在或无法访问。"), { httpStatus: 404 }));
		const response = await request();
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: "项目目录不存在或无法访问。" });
	});
});
