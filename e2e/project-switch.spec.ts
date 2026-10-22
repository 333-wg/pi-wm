import { expect, test, type Page } from "@playwright/test";
import { openApp, startWebApp, stopWebApp, token } from "./harness.js";

let webUrl: string;
const projects: Array<{ id: string; name: string }> = [];

test.beforeAll(async () => {
	webUrl = await startWebApp();
	for (const name of ["Switch Alpha", "Switch Beta"]) {
		const headers = { Authorization: `Bearer ${token}` };
		const created = await fetch(new URL("/api/projects", webUrl), {
			method: "POST",
			headers: { ...headers, "Content-Type": "application/json" },
			body: JSON.stringify({ name }),
		});
		expect(created.ok).toBe(true);
		const { project } = (await created.json()) as { project: { id: string; name: string } };
		const uploaded = await fetch(new URL(`/api/projects/${project.id}/files`, webUrl), {
			method: "PUT",
			headers: { ...headers, "Content-Type": "text/plain", "X-Wuming-Project-Path": "readme.md" },
			body: "# Project switch test",
		});
		expect(uploaded.ok).toBe(true);
		const completed = await fetch(new URL(`/api/projects/${project.id}/complete`, webUrl), { method: "POST", headers });
		expect(completed.ok).toBe(true);
		projects.push(project);
	}
});
test.afterAll(stopWebApp);

async function showNavigation(page: Page) {
	if (!(await page.locator(".project-row").first().isVisible()))
		await page.getByRole("button", { name: "打开导航", exact: true }).click();
}

async function seedConversations(page: Page) {
	await openApp(page, webUrl);
	for (const project of projects) {
		await showNavigation(page);
		await page.locator(".project-row").filter({ hasText: project.name }).click();
		await page.locator(".sidebar-new-chat").click();
		await page.getByRole("textbox", { name: "消息", exact: true }).fill(`Content for ${project.name}`);
		await page.getByRole("button", { name: "发送", exact: true }).click();
		await expect(page.locator(".transcript")).toContainText(`Demo runtime received: Content for ${project.name}`);
	}
	await showNavigation(page);
}

for (const width of [1440, 390]) {
	test(`shows the project and conversation without waiting for ancillary data at ${width}px`, async ({
		page,
	}, testInfo) => {
		await page.setViewportSize({ width, height: 900 });
		let hold = false;
		const held: Array<() => void> = [];
		const blockedTypes = new Set([
			"session.detached",
			"skill.list",
			"tool.list",
			"mcp.list",
			"evaluation.dataset.list",
			"usage.overview",
		]);
		await page.routeWebSocket("**/api/ws", (socket) => {
			const server = socket.connectToServer();
			server.onMessage((message) => {
				const value = JSON.parse(String(message));
				if (hold && blockedTypes.has(value.result?.type)) held.push(() => socket.send(message));
				else socket.send(message);
			});
		});
		await seedConversations(page);
		hold = true;
		const row = page.locator(".project-row").filter({ hasText: projects[0]!.name });
		await row.click();
		await expect(row).toHaveClass(/selected/);
		await expect(row).toHaveAttribute("aria-expanded", "true");
		await expect(page.locator(".transcript")).toContainText(`Content for ${projects[0]!.name}`);
		await expect(page.locator(".session-entry.selected")).toHaveCount(1);
		await expect.poll(() => held.length).toBeGreaterThan(0);
		await page.screenshot({ path: testInfo.outputPath(`project-switch-${width}.png`) });
		expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
		hold = false;
		for (const release of held) release();
	});
}

for (const delayedType of ["session.list", "session.attached"]) {
	test(`ignores an outdated ${delayedType} after another project is selected`, async ({ page }) => {
		let hold = false;
		const held: Array<() => void> = [];
		await page.routeWebSocket("**/api/ws", (socket) => {
			const server = socket.connectToServer();
			server.onMessage((message) => {
				const value = JSON.parse(String(message));
				if (hold && value.result?.type === delayedType) held.push(() => socket.send(message));
				else socket.send(message);
			});
		});
		await seedConversations(page);
		hold = true;
		await page.locator(".project-row").filter({ hasText: projects[0]!.name }).click();
		await expect.poll(() => held.length).toBeGreaterThan(0);
		hold = false;
		const selected = page.locator(".project-row").filter({ hasText: projects[1]!.name });
		await selected.click();
		await expect(page.locator(".transcript")).toContainText(`Content for ${projects[1]!.name}`);
		for (const release of held) release();
		// Let the released WebSocket response and any resulting React work settle.
		await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 250)));
		await expect(selected).toHaveClass(/selected/);
		await expect(page.locator(".transcript")).toContainText(`Content for ${projects[1]!.name}`);
		await expect(page.locator(".project-conversations")).not.toContainText(`Content for ${projects[0]!.name}`);
		expect(await page.evaluate(() => localStorage.getItem("wuming.workspaceId"))).toBe(projects[1]!.id);
	});
}

test("a failed skill refresh does not block the selected conversation", async ({ page }) => {
	let fail = false;
	await page.routeWebSocket("**/api/ws", (socket) => {
		const server = socket.connectToServer();
		server.onMessage((message) => {
			const value = JSON.parse(String(message));
			if (fail && value.result?.type === "skill.list")
				socket.send(
					JSON.stringify({
						type: "response",
						requestId: value.requestId,
						ok: false,
						error: { code: "INTERNAL", message: "Delayed skill service failed" },
					})
				);
			else socket.send(message);
		});
	});
	await seedConversations(page);
	fail = true;
	await page.locator(".project-row").filter({ hasText: projects[0]!.name }).click();
	await expect(page.locator(".transcript")).toContainText(`Content for ${projects[0]!.name}`);
	await expect(page.locator(".connection")).toHaveClass(/connected/);
});
