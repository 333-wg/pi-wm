import { expect, test } from "@playwright/test";
import { openApp, startWebApp, stopWebApp, token } from "./harness.js";

let webUrl: string;
test.beforeAll(async () => {
	webUrl = await startWebApp();
});
test.afterAll(async () => {
	await stopWebApp();
});

for (const width of [1365, 390, 320]) {
	test(`keeps one unsaved new-chat draft at ${width}px`, async ({ page }, testInfo) => {
		const creates: Array<{ workspaceId: string }> = [];
		page.on("websocket", (socket) =>
			socket.on("framesent", ({ payload }) => {
				const message = JSON.parse(String(payload));
				if (message.command?.type === "session.create") creates.push(message.command);
			})
		);
		await page.setViewportSize({ width, height: 900 });
		await openApp(page, webUrl);
		const button = page.locator(width > 720 ? ".sidebar-new-chat" : ".topbar-new-chat");
		await expect(button).toBeVisible();
		await expect(button).toContainText("新对话");
		await expect(button).toBeInViewport();
		await expect(page.locator(".project-heading-actions").getByRole("button", { name: "新对话" })).toHaveCount(0);
		await button.click();
		const input = page.getByRole("textbox", { name: "消息", exact: true });
		await expect(input).toBeFocused();
		await expect(page.locator(".composer-project-context")).toHaveCount(0);
		expect(creates).toHaveLength(0);
		if (width > 720) await page.getByRole("tab", { name: "文件", exact: true }).click();
		await button.click();
		await expect(page.getByRole("tab", { name: "对话", exact: true })).toHaveAttribute("aria-selected", "true");
		await expect(input).toHaveValue("");
		await expect(input).toBeFocused();
		await button.click();
		await button.click();
		expect(creates).toHaveLength(0);
		await page.screenshot({ path: testInfo.outputPath("new-chat-draft.png") });
		expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
		if (width <= 720) {
			await page.getByRole("button", { name: "打开导航", exact: true }).click();
			await expect(page.locator(".sidebar-new-chat")).toBeVisible();
			await page.screenshot({ path: testInfo.outputPath("new-chat-drawer.png") });
			await page.locator(".sidebar-new-chat").click();
			await expect(page.locator(".sidebar")).not.toHaveClass(/mobile-open/);
			await expect(input).toBeFocused();
			expect(creates).toHaveLength(0);
		}
	});
}

test("retains the entry with a collapsed sidebar and supports keyboard creation", async ({ page }, testInfo) => {
	await page.setViewportSize({ width: 1365, height: 900 });
	await openApp(page, webUrl);
	await page.getByRole("button", { name: "收起侧边栏", exact: true }).click();
	await expect(page.locator(".sidebar-new-chat")).toBeHidden();
	await expect(page.locator(".topbar-new-chat")).toBeVisible();
	await page.locator(".topbar-new-chat").click();
	await expect(page.getByRole("textbox", { name: "消息", exact: true })).toBeFocused();
	await page.getByRole("tab", { name: "文件", exact: true }).click();
	await page.keyboard.press("Control+Alt+n");
	await expect(page.getByRole("tab", { name: "对话", exact: true })).toHaveAttribute("aria-selected", "true");
	await expect(page.getByRole("textbox", { name: "消息", exact: true })).toBeFocused();
	await page.screenshot({ path: testInfo.outputPath("new-chat-collapsed.png") });
});

test("allows a projectless draft before a model is configured", async ({ page }) => {
	const modelListRequests = new Set<string>();
	let creates = 0;
	await page.routeWebSocket(/\/api\/ws/, (socket) => {
		const server = socket.connectToServer();
		socket.onMessage((message) => {
			const parsed = JSON.parse(String(message));
			if (parsed.command?.type === "model.list") modelListRequests.add(parsed.requestId);
			if (parsed.command?.type === "session.create") creates++;
			server.send(message);
		});
		server.onMessage((message) => {
			const parsed = JSON.parse(String(message));
			if (
				parsed.type === "response" &&
				parsed.ok === true &&
				parsed.result?.type === "model.list" &&
				modelListRequests.delete(parsed.requestId)
			) {
				socket.send(JSON.stringify({ ...parsed, result: { ...parsed.result, models: [] } }));
				return;
			}
			socket.send(message);
		});
	});

	await openApp(page, webUrl);
	const newChat = page.locator(".sidebar-new-chat");
	await expect(newChat).toBeEnabled();
	await newChat.click();

	const input = page.getByRole("textbox", { name: "消息", exact: true });
	await expect(input).toBeEnabled();
	await expect(input).toBeFocused();
	await input.fill("draft before configuring a model");
	const send = page.getByRole("button", { name: "发送", exact: true });
	await expect(send).toBeDisabled();
	await expect(send).toHaveAttribute("title", "请先添加并验证模型");
	expect(creates).toBe(0);
});

test("prevents duplicate creation while the first request is pending", async ({ page }) => {
	let release: (() => void) | undefined;
	let creates = 0;
	await page.routeWebSocket(/\/api\/ws/, (socket) => {
		const server = socket.connectToServer();
		socket.onMessage((message) => {
			if (JSON.parse(String(message)).command?.type === "session.create") creates++;
			server.send(message);
		});
		server.onMessage((message) => {
			if (JSON.parse(String(message)).result?.type === "session.created") release = () => socket.send(message);
			else socket.send(message);
		});
	});
	await openApp(page, webUrl);
	await page.locator(".sidebar-new-chat").click();
	await page.getByRole("textbox", { name: "消息", exact: true }).fill("pending session creation");
	await page.getByRole("button", { name: "发送", exact: true }).click();
	await expect.poll(() => Boolean(release)).toBe(true);
	await expect(page.locator(".sidebar-new-chat")).toBeDisabled();
	await page.keyboard.press("Control+Alt+n");
	await page.keyboard.press("Control+Alt+n");
	expect(creates).toBe(1);
	release!();
	await expect(page.locator(".transcript")).toContainText("Demo runtime received: pending session creation");
});

test("inherits the current project and can detach the draft without losing text", async ({ page }, testInfo) => {
	const creates: Array<{ workspaceId: string }> = [];
	page.on("websocket", (socket) =>
		socket.on("framesent", ({ payload }) => {
			const message = JSON.parse(String(payload));
			if (message.command?.type === "session.create") creates.push(message.command);
		})
	);
	await page.setViewportSize({ width: 1365, height: 900 });
	await openApp(page, webUrl);
	const project = await page.evaluate(async (authorization) => {
		const headers = { Authorization: `Bearer ${authorization}` };
		const created = await fetch("/api/projects", {
			method: "POST",
			headers: { ...headers, "Content-Type": "application/json" },
			body: JSON.stringify({ name: "Codex context project" }),
		});
		const draft = (await created.json()).project as { id: string };
		await fetch(`/api/projects/${encodeURIComponent(draft.id)}/files`, {
			method: "PUT",
			headers: {
				...headers,
				"Content-Type": "text/plain",
				"X-Wuming-Project-Path": encodeURIComponent("readme.md"),
			},
			body: "# Codex context project\n",
		});
		const completed = await fetch(`/api/projects/${encodeURIComponent(draft.id)}/complete`, {
			method: "POST",
			headers,
		});
		return (await completed.json()).project as { id: string; name: string };
	}, token);
	await openApp(page, webUrl);

	const projectRow = page.locator(".project-row").filter({ hasText: project.name });
	await projectRow.click();
	await expect(projectRow).toHaveClass(/selected/);
	await page.locator(".sidebar-new-chat").click();
	const context = page.locator(".composer-project-context");
	await expect(context).toContainText(project.name);
	const input = page.getByRole("textbox", { name: "消息", exact: true });
	await input.fill("project-bound task");
	await input.press("Enter");
	await expect(page.locator(".transcript")).toContainText("Demo runtime received: project-bound task");
	await expect.poll(() => creates.length).toBe(1);
	expect(creates[0]?.workspaceId).toBe(project.id);

	await page.locator(".sidebar-new-chat").click();
	await expect(context).toContainText(project.name);
	await input.fill("keep this draft while detaching");
	const detach = page.getByRole("button", { name: "不在项目中工作", exact: true });
	await detach.hover();
	await expect(detach.locator(".composer-project-folder")).toBeHidden();
	await expect(detach.locator(".composer-project-x")).toBeVisible();
	await page.screenshot({ path: testInfo.outputPath("project-context-hover.png") });
	await detach.click();
	await expect(context).toHaveCount(0);
	await expect(input).toHaveValue("keep this draft while detaching");
	await input.press("Enter");
	await expect(page.locator(".transcript")).toContainText("Demo runtime received: keep this draft while detaching");
	await expect.poll(() => creates.length).toBe(2);
	expect(creates[1]?.workspaceId).toBe("local-workspace");
	const recentHeading = page.getByText("最近", { exact: true });
	await expect(recentHeading).toBeVisible();
	const [projectBox, recentBox] = await Promise.all([projectRow.boundingBox(), recentHeading.boundingBox()]);
	expect(projectBox).not.toBeNull();
	expect(recentBox).not.toBeNull();
	expect(projectBox!.y).toBeLessThan(recentBox!.y);
	await page.screenshot({ path: testInfo.outputPath("projects-before-recent.png") });
});
