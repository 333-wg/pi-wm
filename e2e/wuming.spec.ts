import { expect, test, type Page } from "@playwright/test";
import { createTestSubagent } from "./subagent-fixture.js";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import WebSocket from "ws";
import type { ServerMessage } from "@wuming/protocol";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const token = "wuming-e2e-token";
const firstConnectionTitle = "validates and remembers the password on first use";
const services: ChildProcess[] = [];
let temporaryRoot: string;
let webUrl: string;

/** Playwright forces colored child output, so escape codes must be removed before matching readiness banners. */
function plainText(value: string): string {
	return value.replaceAll(new RegExp("\\u001B\\[[0-9;]*m", "g"), "");
}

async function startService(
	name: string,
	args: string[],
	cwd: string,
	environment: Record<string, string>,
	readyPattern: RegExp
): Promise<{ process: ChildProcess; match: RegExpMatchArray }> {
	const child = spawn(process.execPath, args, {
		cwd,
		env: { ...process.env, ...environment },
		stdio: ["ignore", "pipe", "pipe"],
	});
	services.push(child);
	let output = "";
	child.stdout?.on("data", (chunk) => {
		output += String(chunk);
	});
	child.stderr?.on("data", (chunk) => {
		output += String(chunk);
	});
	const match = await new Promise<RegExpMatchArray>((resolveMatch, reject) => {
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
	return { process: child, match };
}

async function stopService(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	child.kill("SIGTERM");
	await Promise.race([once(child, "exit"), new Promise((resolveTimeout) => setTimeout(resolveTimeout, 5_000))]);
	if (child.exitCode === null && child.signalCode === null) {
		child.kill("SIGKILL");
		await once(child, "exit");
	}
}

async function createSession(page: Page): Promise<void> {
	// New Chat intentionally stays a draft until the first prompt. Seed an empty
	// persisted session for tests that exercise rename, archive or settings first.
	const name = `E2E ${crypto.randomUUID()}`;
	const url = new URL("/api/ws", webUrl);
	url.protocol = "ws:";
	const socket = new WebSocket(url, ["wuming.v1", `wuming.bearer.${Buffer.from(token).toString("base64url")}`]);
	try {
		await once(socket, "open", { signal: AbortSignal.timeout(10_000) });
		const hello = once(socket, "message", { signal: AbortSignal.timeout(10_000) });
		socket.send(JSON.stringify({ type: "hello", protocolVersion: 1, clientId: crypto.randomUUID(), capabilities: [] }));
		await hello;
		await new Promise<void>((resolve, reject) => {
			const requestId = crypto.randomUUID();
			const timer = setTimeout(() => reject(new Error("Session fixture timed out")), 10_000);
			socket.on("message", (raw) => {
				const message = JSON.parse(raw.toString()) as ServerMessage;
				if (message.type !== "response" || message.requestId !== requestId) return;
				clearTimeout(timer);
				if (message.ok && message.result.type === "session.created") resolve();
				else reject(new Error(message.ok ? "Unexpected fixture response" : message.error.message));
			});
			socket.send(
				JSON.stringify({
					type: "request",
					requestId,
					idempotencyKey: requestId,
					command: {
						type: "session.create",
						workspaceId: "local-workspace",
						name,
						model: { provider: "demo", id: "wuming-demo" },
						thinkingLevel: "medium",
						sandboxMode: "workspace_write",
						approvalPolicy: "on_risk",
					},
				})
			);
		});
	} finally {
		socket.close();
	}
	await page.reload();
	await page.getByRole("navigation", { name: "会话" }).locator(".session-open").filter({ hasText: name }).click();
	if (!(await page.locator(".right-rail").isVisible()))
		await page.getByRole("button", { name: "显示或隐藏运行面板" }).click();
	await expect(page.getByRole("textbox", { name: "消息" })).toBeEnabled();
}

async function sendMessage(page: Page, message: string): Promise<void> {
	await page.getByRole("textbox", { name: "消息" }).fill(message);
	// `exact` matters: a transcript message's 编辑并重新发送 button also contains 发送.
	await page.getByRole("button", { name: "发送", exact: true }).click();
}

async function waitForIdle(page: Page): Promise<void> {
	await expect(page.locator(".session-entry.selected")).toHaveAttribute("data-phase", "idle");
}

test.beforeAll(async () => {
	temporaryRoot = await mkdtemp(join(tmpdir(), "wuming-web-e2e-"));
	const workspace = join(temporaryRoot, "workspace");
	const data = join(temporaryRoot, "data");
	await Promise.all([mkdir(workspace), mkdir(data)]);
	// The composer's `@` mentions search the live workspace, so it needs content.
	await mkdir(join(workspace, "src"));
	await writeFile(join(workspace, "readme.md"), "# E2E\n", "utf8");
	await writeFile(join(workspace, "src", "index.ts"), "export const value = 1;\n", "utf8");
	const gateway = await startService(
		"Gateway",
		["--import", "tsx", join(repositoryRoot, "apps/gateway/src/main.ts")],
		repositoryRoot,
		{
			WUMING_HOST: "127.0.0.1",
			WUMING_PORT: "0",
			WUMING_TOKEN: token,
			WUMING_RUNTIME: "demo",
			WUMING_WORKSPACE: workspace,
			WUMING_DATA_DIR: data,
			WUMING_TERMINAL_MODE: "disabled",
			WUMING_RETRY_BASE_DELAY_MS: "750",
			// Small enough that the context meter reports a meaningful share
			// after a single demo turn.
			WUMING_CONTEXT_WINDOW: "5000",
		},
		/Wuming gateway listening on http:\/\/127\.0\.0\.1:(\d+)/
	);
	const gatewayPort = Number(gateway.match[1]);
	const web = await startService(
		"Web",
		[join(repositoryRoot, "node_modules/vite/bin/vite.js"), "--host", "127.0.0.1", "--port", "0", "--strictPort"],
		join(repositoryRoot, "apps/web"),
		{ WUMING_GATEWAY_URL: `http://127.0.0.1:${gatewayPort}` },
		/Local:\s+http:\/\/127\.0\.0\.1:(\d+)\//
	);
	webUrl = `http://127.0.0.1:${Number(web.match[1])}/`;
});

test.afterAll(async () => {
	for (const child of services.splice(0).reverse()) await stopService(child);
	if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
});

test.beforeEach(async ({ page }, testInfo) => {
	if (testInfo.title === firstConnectionTitle) {
		await page.goto(webUrl);
		return;
	}
	await page.addInitScript((value) => localStorage.setItem("wuming.token", value), token);
	await page.addInitScript(() => localStorage.setItem("wuming.onboarding.complete", "true"));
	await page.goto(webUrl);
	await expect(page.getByText("已连接", { exact: true })).toBeVisible();
});

test(firstConnectionTitle, async ({ page }) => {
	const welcome = page.locator(".welcome-screen");
	await expect(welcome).toBeVisible();
	const password = welcome.getByLabel("访问密码");
	await password.fill("wrong-password");
	await welcome.getByRole("button", { name: "开启工作空间", exact: true }).click();
	await expect(welcome.getByRole("alert")).toContainText("密码不正确");

	await password.fill(token);
	await welcome.getByRole("button", { name: "开启工作空间", exact: true }).click();
	await expect(page.getByText("已连接", { exact: true })).toBeVisible();
	await expect(welcome).toBeHidden();
	await expect(page.getByRole("textbox", { name: "消息" })).toBeEnabled();
	await expect.poll(() => page.evaluate(() => localStorage.getItem("wuming.token"))).toBe(token);

	await page.reload();
	await expect(page.getByText("已连接", { exact: true })).toBeVisible();
	await expect(page.getByRole("dialog", { name: "首次设置" })).toBeHidden();
});

test("subtasks use the heading network icon instead of the changes branch icon", async ({ page }) => {
	await createSession(page);
	for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
		await page.setViewportSize(viewport);
		const subtasks = page.getByRole("tab", { name: "子任务", exact: true });
		const changes = page.getByRole("tab", { name: "更改", exact: true });
		await expect(subtasks.locator("svg.lucide-network")).toHaveCount(1);
		await expect(subtasks.locator("svg.lucide-git-branch")).toHaveCount(0);
		await expect(changes.locator("svg.lucide-git-branch")).toHaveCount(1);
		await subtasks.click();
		await expect(subtasks).toHaveAttribute("aria-selected", "true");
		await expect(page.locator(".teams-heading > div > svg.lucide-network")).toBeVisible();
		await page.screenshot({ path: `test-results/subtasks-icon-${viewport.width}.png` });
		await changes.click();
		await expect(changes).toHaveAttribute("aria-selected", "true");
	}
});

test("starts projectless and groups imported projects", async ({ page }) => {
	const projectTree = page.getByRole("navigation", { name: "项目" });
	await expect(projectTree.getByText("本地工作区", { exact: true })).toHaveCount(0);
	await expect(page.getByRole("textbox", { name: "消息" })).toBeEnabled();
	await expect(page.getByRole("heading", { name: "开始一个新任务" })).toBeVisible();

	await sendMessage(page, "Projectless E2E task");
	await expect(page.getByText(/Demo runtime received: Projectless E2E task/)).toBeVisible();
	await expect(projectTree.getByRole("navigation", { name: "会话" }).locator(".session-entry")).toHaveCount(1);

	await page.getByRole("button", { name: "打开项目" }).click();
	const dialog = page.getByRole("dialog", { name: "打开项目" });
	const combinedPicker = dialog.getByRole("button", {
		name: /^文件或文件夹\s*选择这台电脑上的项目内容$/,
	});
	await expect(combinedPicker).toBeVisible();
	await expect(dialog.getByRole("group", { name: "选择项目内容类型" })).toHaveCount(0);
	await page.route("**/api/projects/pick", (route) =>
		route.fulfill({
			status: 400,
			contentType: "application/json",
			body: JSON.stringify({ error: "Project selection was cancelled" }),
		})
	);
	const pickRequest = page.waitForRequest("**/api/projects/pick");
	await combinedPicker.click();
	expect((await pickRequest).postDataJSON()).toEqual({});
	await expect(combinedPicker).toBeEnabled();
	await expect(dialog.getByRole("alert")).toHaveCount(0);
});

test("uploads uncommon text files and accepts dragged images", async ({ page }) => {
	await createSession(page);
	await page.getByLabel("选择附件").setInputFiles({
		name: "Component.vue",
		mimeType: "application/octet-stream",
		buffer: Buffer.from("<template><main>Uploaded</main></template>\n"),
	});
	await expect(page.locator(".attachment-chip").getByText("Component.vue", { exact: true })).toBeVisible();
	await page.getByLabel("选择附件").setInputFiles({
		name: "report.docx",
		mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		buffer: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff]),
	});
	await expect(page.locator(".attachment-chip").getByText("report.docx", { exact: true })).toBeVisible();

	const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
	await dataTransfer.evaluate((transfer) => {
		const encoded = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
		const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
		transfer.items.add(new File([bytes], "dragged-pixel.png", { type: "image/png" }));
	});
	const composer = page.locator(".composer");
	await composer.dispatchEvent("dragenter", { dataTransfer });
	await expect(composer.getByText("松开即可添加文件", { exact: true })).toBeVisible();
	await composer.dispatchEvent("dragover", { dataTransfer });
	await composer.dispatchEvent("drop", { dataTransfer });
	await expect(page.locator(".attachment-chip").getByText("dragged-pixel.png", { exact: true })).toBeVisible();
	await expect(page.locator(".attachment-error")).toHaveCount(0);
});

test("persists a completed turn across a browser reload", async ({ page }) => {
	await createSession(page);
	await sendMessage(page, "Persist this E2E result");
	await expect(page.getByText(/Demo runtime received: Persist this E2E result/)).toBeVisible();
	const sessionName = await page.locator(".session-entry.selected .session-open span").innerText();
	await page.reload();
	await expect(page.getByText("已连接", { exact: true })).toBeVisible();
	await expect(page.getByRole("heading", { name: "开始一个新任务" })).toBeVisible();
	await page.getByRole("navigation", { name: "会话" }).getByRole("button", { name: sessionName }).click();
	await expect(page.getByText(/Demo runtime received: Persist this E2E result/)).toBeVisible();
});

test("archives, browses, and restores a chat", async ({ page }) => {
	await createSession(page);
	const session = page.locator(".session-entry.selected");
	await session.hover();
	await session.getByRole("button", { name: "重命名会话" }).click();
	await session.getByRole("textbox", { name: "会话名称" }).fill("归档交互 E2E");
	await session.getByRole("button", { name: "保存名称" }).click();

	const archive = session.getByRole("button", { name: "归档聊天" });
	await expect(archive).toHaveAttribute("title", "归档聊天");
	await archive.click();
	await expect(page.getByRole("heading", { name: "开始一个新任务" })).toBeVisible();
	await expect(
		page
			.getByRole("navigation", { name: "会话" })
			.locator(".session-open")
			.filter({ hasText: /^归档交互 E2E$/ })
	).toHaveCount(0);

	await page.getByRole("button", { name: "查看归档聊天" }).click();
	const archivedSession = page
		.getByRole("navigation", { name: "会话" })
		.locator(".session-entry", { hasText: "归档交互 E2E" });
	await expect(archivedSession).toBeVisible();
	await archivedSession.locator(".session-open").click();
	await expect(page.getByText("已归档", { exact: true })).toBeVisible();
	await archivedSession.hover();
	await archivedSession.getByRole("button", { name: "恢复聊天" }).click();
	await expect(archivedSession).toHaveCount(0);

	await page.getByRole("button", { name: "返回聊天" }).click();
	await expect(
		page
			.getByRole("navigation", { name: "会话" })
			.locator(".session-open")
			.filter({ hasText: /^归档交互 E2E$/ })
	).toBeVisible();
});

test("approves a tool and stops a long-running turn", async ({ page }) => {
	await createSession(page);
	await sendMessage(page, "/approval");
	const approval = page.getByRole("region", { name: "需要批准工具调用" });
	await expect(approval).toBeVisible();
	await approval.getByRole("button", { name: "允许" }).click();
	await expect(
		page.getByText("Demo approval was granted. No filesystem or process action was executed.")
	).toBeVisible();
	await sendMessage(page, "/long");
	const stop = page.getByRole("button", { name: "停止任务" });
	await expect(stop).toBeVisible();
	await stop.click();
	await expect(stop).toBeHidden();
	await expect(page.getByRole("textbox", { name: "消息" })).toHaveAttribute(
		"placeholder",
		"给 Pi-Wm 发送任务或问题（@ 引用文件，/ 快捷命令）"
	);
});

test("leaves the transcript where the reader scrolled while a turn streams", async ({ page }) => {
	await sendMessage(page, "scroll streaming setup");
	await expect(page.getByText("Demo runtime received: scroll streaming setup", { exact: false })).toBeVisible();
	await waitForIdle(page);
	await sendMessage(page, "/long");
	const transcript = page.locator(".transcript");
	// Nothing to detach from until the streamed reply overflows the viewport.
	await page.waitForFunction(() => {
		const element = document.querySelector(".transcript");
		return element !== null && element.scrollHeight - element.clientHeight > 400;
	});
	await transcript.evaluate((element) => {
		element.scrollTop = 0;
	});

	// The pill is the way back, and it only claims new content once a delta has
	// actually landed since the reader left the tail.
	const pill = page.getByRole("button", { name: /回到底部/ });
	await expect(pill).toBeVisible();
	await expect(page.getByRole("button", { name: "回到底部，有新内容" })).toBeVisible();
	// Deltas keep arriving for seconds after this; the view has to stay put.
	await page.waitForTimeout(1500);
	expect(await transcript.evaluate((element) => element.scrollTop)).toBe(0);

	await pill.click();
	await expect
		.poll(() => transcript.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop))
		.toBeLessThan(72);
	await expect(pill).toHaveCount(0);
	await page.getByRole("button", { name: "停止任务" }).click();
});

for (const viewport of [
	{ width: 1440, height: 900 },
	{ width: 390, height: 844 },
]) {
	test(`follows transcript layout growth at ${viewport.width}px without pulling readers down`, async ({ page }) => {
		await page.setViewportSize(viewport);
		await page.reload();
		await expect(page.locator(".connection.connected")).toHaveCount(1);
		await expect(page.locator(".session-entry.selected")).toHaveCount(1);
		await sendMessage(page, `scroll layout regression ${viewport.width}`);
		await expect(page.getByText(`Demo runtime received: scroll layout regression ${viewport.width}`)).toBeVisible();
		await expect(page.getByRole("button", { name: "停止任务" })).toBeHidden();
		const transcript = page.locator(".transcript");
		const gap = () => transcript.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop);
		// Simulate a tool/media row arriving, then expanding without a React delta.
		await transcript.evaluate((element) => {
			const row = document.createElement("div");
			row.dataset.scrollRegression = "true";
			row.style.height = "1200px";
			row.textContent = "Tool output";
			element.append(row);
		});
		await expect.poll(gap).toBeLessThan(2);
		await transcript.locator("[data-scroll-regression]").evaluate((element) => {
			(element as HTMLElement).style.height = "1800px";
		});
		await expect.poll(gap).toBeLessThan(2);
		await page.setViewportSize({ width: viewport.width, height: viewport.height - 160 });
		await expect.poll(gap).toBeLessThan(2);
		await transcript.evaluate((element) => {
			element.scrollTop = 0;
		});
		await expect(page.getByRole("button", { name: /回到底部/ })).toBeVisible();
		await transcript.locator("[data-scroll-regression]").evaluate((element) => {
			(element as HTMLElement).style.height = "2200px";
		});
		await page.waitForTimeout(250);
		expect(await transcript.evaluate((element) => element.scrollTop)).toBe(0);
		await page.getByRole("button", { name: /回到底部/ }).click();
		await expect.poll(gap).toBeLessThan(2);
		await transcript.locator("[data-scroll-regression]").evaluate((element) => element.remove());
		await expect.poll(gap).toBeLessThan(2);
		await page.screenshot({ path: `test-results/scroll-follow-${viewport.width}.png` });
	});
}

test("keeps forks out of message actions while retaining editing and conversation-level forking", async ({ page }) => {
	await createSession(page);
	const originalName = await page.locator(".session-entry.selected .session-open span").innerText();
	await sendMessage(page, "第一问");
	await expect(page.getByText("Demo runtime received: 第一问")).toBeVisible();
	// Streamed assistant text can become visible just before the durable turn has
	// settled. Wait for idle so the next send is a new turn rather than a steer.
	await waitForIdle(page);
	await sendMessage(page, "第二问");
	await expect(page.getByText("Demo runtime received: 第二问")).toBeVisible();
	await waitForIdle(page);
	const originalCount = await page.locator(".session-entry").count();
	await expect(page.locator(".message-actions").getByRole("button", { name: "从这里分叉出新会话" })).toHaveCount(0);
	await expect(page.locator(".message-row.user").first().locator(".message-actions button")).toHaveCount(2);
	await expect(page.locator(".message-row.assistant").first().locator(".message-actions button")).toHaveCount(1);

	// The action row is faded until its message is hovered *or* focused, so
	// focusing a button has to reveal it: that is what keeps these reachable
	// without a pointer.
	const reply = page.locator(".message-row.assistant").first();
	await reply.getByRole("button", { name: "复制消息" }).focus();
	await expect(reply.locator(".message-actions")).toHaveCSS("opacity", "1");

	// Editing keeps the same conversation and replaces only the selected suffix.
	const secondPrompt = page.locator(".message-row.user").nth(1);
	await secondPrompt.hover();
	await secondPrompt.getByRole("button", { name: "编辑并重新发送" }).click();
	await expect(page.getByRole("textbox", { name: "消息", exact: true })).toHaveValue("第二问");
	await expect(page.getByRole("textbox", { name: "消息", exact: true })).toBeFocused();
	await expect(page.getByRole("textbox", { name: "编辑消息", exact: true })).toHaveCount(0);
	await page.getByRole("textbox", { name: "消息", exact: true }).fill("改写的第二问");
	// `exact` matters: every other message still offers 编辑并重新发送.
	await page.getByRole("button", { name: "发送", exact: true }).click();
	await expect(page.locator(".session-entry.selected .session-open")).toHaveText(originalName);
	await expect(page.getByText("Demo runtime received: 改写的第二问")).toBeVisible();
	await expect(page.getByText("Demo runtime received: 第一问")).toBeVisible();
	await expect(page.getByText("Demo runtime received: 第二问")).toHaveCount(0);
	await expect(page.locator(".session-entry")).toHaveCount(originalCount);
	await waitForIdle(page);
	await page.reload();
	await expect(page.getByText("Demo runtime received: 改写的第二问")).toBeVisible();
	await expect(page.getByText("Demo runtime received: 第一问")).toBeVisible();
	await expect(page.getByText("Demo runtime received: 第二问")).toHaveCount(0);

	// The separate conversation-level action still forks the entire transcript.
	await page.getByRole("button", { name: "派生会话", exact: true }).click();
	await expect(page.locator(".session-entry.selected .session-open")).toHaveText(`${originalName} (fork)`);
	await expect(page.locator(".session-entry")).toHaveCount(originalCount + 1);
	await expect(page.getByText("Demo runtime received: 第一问")).toBeVisible();
	await expect(page.getByText("Demo runtime received: 改写的第二问")).toBeVisible();

	// Editing the first message also retains the current conversation identity.
	const firstPrompt = page.locator(".message-row.user").first();
	await firstPrompt.hover();
	await firstPrompt.getByRole("button", { name: "编辑并重新发送" }).click();
	await page.getByRole("textbox", { name: "消息", exact: true }).fill("重写第一问");
	await page.getByRole("button", { name: "发送", exact: true }).click();
	await expect(page.getByText("Demo runtime received: 重写第一问")).toBeVisible();
	await expect(page.getByText("Demo runtime received: 第一问")).toHaveCount(0);
	await expect(page.locator(".session-entry.selected .session-open")).toHaveText(`${originalName} (fork)`);
	await expect(page.locator(".session-entry")).toHaveCount(originalCount + 1);
	await page.screenshot({ path: "test-results/edit-current-session-desktop.png" });
	await page.setViewportSize({ width: 390, height: 844 });
	await page.locator(".rail-mobile-close").click();
	await expect(page.getByText("Demo runtime received: 重写第一问")).toBeVisible();
	await expect(page.locator(".message-actions").getByRole("button", { name: "从这里分叉出新会话" })).toHaveCount(0);
	await expect(page.locator(".message-row.user").first().getByRole("button", { name: "编辑并重新发送" })).toBeEnabled();
	await page.screenshot({ path: "test-results/edit-current-session-mobile.png" });
});

test("completes file mentions and runs slash commands from the composer", async ({ page }) => {
	await createSession(page);
	const composer = page.getByRole("textbox", { name: "消息" });
	const mentions = page.getByRole("listbox", { name: "引用文件" });
	const commands = page.getByRole("listbox", { name: "快捷命令" });
	await composer.click();
	await composer.pressSequentially("@src");
	await expect(mentions.getByRole("option").first()).toContainText("src");
	await expect(mentions.getByText("目录", { exact: true })).toBeVisible();

	// Enter accepts the highlighted row; a directory keeps the menu open so the
	// next Enter drills into it instead of sending the prompt.
	await composer.press("Enter");
	await expect(composer).toHaveValue("@src/");
	await expect(mentions.getByRole("option").first()).toContainText("index.ts");
	await composer.press("Enter");
	await expect(composer).toHaveValue("@src/index.ts ");
	await expect(mentions).toBeHidden();

	// A command that expects an argument is inserted, then submitting it renames
	// the session locally instead of prompting the runtime.
	await composer.fill("");
	await composer.pressSequentially("/rena");
	await expect(commands.getByRole("option").first()).toContainText("/rename");
	await composer.press("Enter");
	await expect(composer).toHaveValue("/rename ");
	await composer.pressSequentially("E2E 命令重命名");
	await expect(commands).toBeHidden();
	await composer.press("Enter");
	await expect(composer).toHaveValue("");
	await expect(page.getByText("E2E 命令重命名").first()).toBeVisible();

	// A command with no argument runs the moment it is picked.
	await composer.pressSequentially("/files");
	await expect(commands.getByRole("option").first()).toContainText("/files");
	await composer.press("Enter");
	await expect(page.getByRole("tab", { name: "文件" })).toHaveAttribute("aria-selected", "true");
	await expect(page.getByRole("button", { name: "readme.md" })).toBeVisible();
});

test("shows the thinking control as unavailable on a model without reasoning", async ({ page }) => {
	await createSession(page);
	// The demo model spends no thinking budget. The control still has to be there —
	// hiding it is how the feature became invisible in the first place — but pinned
	// to 关闭 and explaining itself. `thinking.spec.ts` covers the live control.
	const trigger = page.locator(".thinking-trigger");
	await expect(trigger.locator(".thinking-trigger-effort")).toHaveText("关闭");
	await expect(trigger).toBeEnabled();
	await expect(trigger).toHaveAttribute("title", "该模型不支持思考强度");
	await trigger.click();
	await expect(page.locator(".thinking-menu-item")).toBeDisabled();
	await expect(page.getByRole("menu", { name: "思考强度" })).toBeHidden();
});

test("drives the shell from the keyboard and reports context occupancy", async ({ page }) => {
	await createSession(page);
	await sendMessage(page, "Report context usage for the meter");
	await expect(page.getByText(/Demo runtime received: Report context usage for the meter/)).toBeVisible();
	// The meter is estimated from reported usage, so it only appears once a turn
	// has been accounted for.
	const meter = page.locator(".composer").getByRole("button", { name: /上下文约占 \d+%/ });
	await expect(meter).toBeVisible();

	// The palette runs the same registry the composer does, so a command with an
	// argument hint must ask for the argument instead of running immediately.
	await page.keyboard.press("Control+k");
	const palette = page.getByRole("dialog", { name: "命令面板" });
	await expect(palette).toBeVisible();
	const search = palette.getByRole("combobox", { name: "命令面板" });
	await search.pressSequentially("重命名");
	await expect(palette.getByRole("option").first()).toContainText("/rename");
	await search.press("Enter");
	await expect(search).toHaveAttribute("placeholder", "<名称>");
	await search.pressSequentially("E2E 面板重命名");
	await search.press("Enter");
	await expect(palette).toBeHidden();
	await expect(page.getByText("E2E 面板重命名").first()).toBeVisible();

	// Escape unwinds the shortcut sheet, and the rail is a chord away.
	await page.keyboard.press("Control+Slash");
	const shortcuts = page.getByRole("dialog", { name: "快捷键" });
	await expect(shortcuts).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(shortcuts).toBeHidden();
	await page.keyboard.press("Control+Shift+b");
	await expect(page.locator(".right-rail")).toBeHidden();
	await expect(meter).toBeVisible();
});

test("shows a trajectory evaluation without mobile overflow", async ({ page }) => {
	await createSession(page);
	await sendMessage(page, "Capture a trajectory for this run");
	await expect(page.getByText(/Demo runtime received: Capture a trajectory for this run/)).toBeVisible();
	await waitForIdle(page);

	const trajectory = page.locator(".run-trajectory").first();
	await expect(trajectory.getByText(/结构评测 \d+\/100/)).toBeVisible();
	await trajectory.locator("summary").click();
	await expect(trajectory.getByText("仅评估执行结构与证据完整性，不判断回答语义正确性。")).toBeVisible();
	await expect(trajectory.locator(".trajectory-entry")).toHaveCount(5);

	await page.setViewportSize({ width: 390, height: 844 });
	await expect(trajectory).toBeVisible();
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test("retains and physically forgets a durable session memory", async ({ page }) => {
	await createSession(page);
	await sendMessage(page, "/demo-memory");
	await expect(page.getByText(/Demo runtime received: \/demo-memory/)).toBeVisible();
	await waitForIdle(page);

	const memory = page.locator(".right-rail .memory-row").first();
	await expect(memory).toHaveCount(1);
	await memory.locator("summary").click();
	await expect(memory).toContainText("Demo durable memory: keep the verified SQLite transaction decision.");
	await memory.getByRole("button", { name: "保留此记忆" }).click();
	await expect(memory.locator("summary")).toContainText("已保留");
	await expect(memory.getByRole("button", { name: "取消保留" })).toHaveAttribute("aria-pressed", "true");

	await memory.getByRole("button", { name: "忘记此记忆" }).click();
	await expect(page.locator(".right-rail .memory-row")).toHaveCount(0);
	await expect(page.locator(".right-rail .memory-history")).toContainText("暂无压缩记忆");
});

test("shows a thinking activity before the first model event", async ({ page }) => {
	await createSession(page);
	await sendMessage(page, "/inject");
	const thinking = page.getByRole("status", { name: "正在处理请求" });
	await expect(thinking).toBeVisible();
	await expect(thinking).toHaveText("正在处理请求");
	await page.getByRole("button", { name: "停止任务" }).click();
	await expect(thinking).toBeHidden();
});

test("immediate input interrupts active work and overtakes queued follow-ups", async ({ page }) => {
	await createSession(page);
	await sendMessage(page, "/inject");
	await expect(page.getByRole("status", { name: "正在处理请求" })).toBeVisible();
	await sendMessage(page, "queued follow-up");
	await expect(page.getByText(/Demo runtime received: queued follow-up/)).toHaveCount(0);
	await sendMessage(page, "immediate correction");
	await page.getByRole("region", { name: "后续任务队列" }).getByRole("button", { name: "立即发送（打断）" }).last().click();
	await expect(page.getByText(/Demo runtime received: immediate correction/)).toBeVisible();
	await expect(page.getByText(/Demo runtime received: queued follow-up/)).toBeVisible();
	await waitForIdle(page);
	const replies = await page.locator(".transcript").innerText();
	expect(replies.indexOf("Demo runtime received: immediate correction")).toBeLessThan(
		replies.indexOf("Demo runtime received: queued follow-up")
	);
	await page.screenshot({ path: "test-results/turn-scheduling-desktop.png", fullPage: true });
	await page.setViewportSize({ width: 390, height: 844 });
	await page.locator(".rail-mobile-close").click();
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
	await page.screenshot({ path: "test-results/turn-scheduling-mobile.png", fullPage: true });
});

test("deleting a queued follow-up synchronizes recent runs in both clients", async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await createSession(page);
	await sendMessage(page, "/inject");
	await expect(page.getByRole("status", { name: "正在处理请求" })).toBeVisible();
	await sendMessage(page, "delete this queued follow-up");
	const queue = page.getByRole("region", { name: "后续任务队列" });
	const run = page.locator(".run-row").filter({ hasText: "后续任务" });
	await expect(queue).toContainText("delete this queued follow-up");
	await expect(run).toContainText("排队中");

	const observer = await page.context().newPage();
	try {
		await observer.goto(page.url());
		await expect(observer.getByRole("region", { name: "后续任务队列" })).toBeVisible();
		const observedRun = observer.locator(".run-row").filter({ hasText: "后续任务" });
		await expect(observedRun).toContainText("排队中");
		await queue.getByRole("button", { name: "删除待发送任务" }).click();
		await expect(queue).toBeHidden();
		await expect(run).toContainText("中断");
		await expect(run).not.toContainText("排队中");
		await expect(observer.getByRole("region", { name: "后续任务队列" })).toBeHidden();
		await expect(observedRun).toContainText("中断");
		await expect(page.getByRole("status", { name: "正在处理请求" })).toBeVisible();
		await page.screenshot({ path: "test-results/follow-up-delete-desktop.png", fullPage: true });
		await page.setViewportSize({ width: 390, height: 844 });
		await expect(run).toBeVisible();
		await page.screenshot({ path: "test-results/follow-up-delete-mobile.png", fullPage: true });
		await page.locator(".rail-mobile-close").click();
		await page.getByRole("button", { name: "停止任务" }).click();
		await waitForIdle(page);
		await expect(page.getByText(/Demo runtime received: delete this queued follow-up/)).toHaveCount(0);
		await page.reload();
		await page.getByRole("button", { name: "显示或隐藏运行面板" }).click();
		await expect(run).toContainText("中断");
	} finally {
		await observer.close();
	}
});

test("follow-up input waits for active work to finish before starting", async ({ page }) => {
	await createSession(page);
	await sendMessage(page, "/demo-live-tool");
	await expect(
		page.locator(".transcript").getByText("我先运行项目测试，确认当前状态。", { exact: true })
	).toBeVisible();
	await sendMessage(page, "after the tests finish");
	await expect(page.getByText(/Demo runtime received: after the tests finish/)).toBeVisible();
	await waitForIdle(page);
	const transcript = await page.locator(".transcript").innerText();
	expect(transcript.indexOf("测试完成：4 项通过。")).toBeGreaterThanOrEqual(0);
	expect(transcript.indexOf("测试完成：4 项通过。")).toBeLessThan(
		transcript.indexOf("Demo runtime received: after the tests finish")
	);
});

test("shows progress and compact live activity with command details on demand", async ({ page }) => {
	await createSession(page);
	await sendMessage(page, "/demo-live-tool");

	const transcript = page.locator(".transcript");
	await expect(transcript.getByText("我先运行项目测试，确认当前状态。", { exact: true })).toBeVisible();
	const activity = transcript.locator(".tool-group-summary");
	await expect(activity).toContainText("正在执行命令");
	await expect(activity).toHaveAttribute("aria-expanded", "false");
	await expect(transcript).not.toContainText("npm test --silent");
	await activity.click();
	await expect(activity).toHaveAttribute("aria-expanded", "true");

	await expect(activity).toContainText("执行命令 1 次");
	await expect(activity).toContainText("1 项操作已结束");
	await expect(transcript.getByText("测试完成：4 项通过。", { exact: true })).toBeVisible();
	// The live tool has now become a saved transcript item; the group must stay open.
	await expect(activity).toHaveAttribute("aria-expanded", "true");
	const detail = transcript.locator(".tool-group-items .tool-trace-summary");
	await expect(detail).toContainText("npm test --silent");
	await detail.click();
	await expect(transcript.locator(".tool-result")).toContainText("4 tests passed");
});

test("shows automatic retry progress and recovery in the conversation", async ({ page }) => {
	await createSession(page);
	await sendMessage(page, "/retry-once");

	const retry = page.getByRole("status", { name: "正在自动重试" });
	await expect(retry).toBeVisible();
	await expect(retry).toContainText("正在恢复连接");
	await expect(retry).toContainText("重试 1/5");
	await expect(retry).toContainText("750ms 后自动重试");

	await waitForIdle(page);
	await expect(retry).toHaveCount(0);
	await expect(page.getByText("Demo provider recovered after retry.", { exact: true })).toBeVisible();
});

test("shows a recoverable final error with details and a rerun action", async ({ page }) => {
	await createSession(page);
	await sendMessage(page, "/demo-fail");
	await waitForIdle(page);

	const failure = page.getByRole("status").filter({ hasText: "模型服务暂时不可用" });
	await expect(failure).toBeVisible();
	await expect(failure).toContainText("任务没有完成");
	await failure.getByText("技术详情", { exact: true }).click();
	await expect(failure).toContainText("Simulated provider request failed after recovery was exhausted");
	await failure.getByRole("button", { name: "重新执行" }).click();
	await expect(page.locator(".message-row.user").filter({ hasText: "/demo-fail" })).toHaveCount(2);
	await waitForIdle(page);
});

test("navigates nested child conversations and cancels background work", async ({ page }) => {
	await page.locator(".sidebar-new-chat").click();
	await sendMessage(page, "E2E child conversation parent");
	await expect(page.getByText(/Demo runtime received: E2E child conversation parent/)).toBeVisible();
	await expect(page.getByRole("tab", { name: "智能体" })).toHaveCount(0);
	for (const name of ["E2E completion", "E2E nested level 2", "E2E nested level 3"]) {
		await createTestSubagent(page, "Return a result for " + name, name);
		await page.getByRole("button", { name: "子对话", exact: true }).click();
		await page.locator(".child-conversation-open").filter({ hasText: name }).click();
		await expect(page.locator(".topbar h1")).toHaveCount(0);
		await expect(page.getByText("Demo runtime received: Return a result for " + name, { exact: true })).toBeVisible();
		await expect(page.locator(".right-rail")).toHaveCount(0);
	}
	await page.reload();
	await expect(
		page.getByText("Demo runtime received: Return a result for E2E nested level 3", { exact: true })
	).toBeVisible();
	await page.getByRole("button", { name: "子对话", exact: true }).click();
	await expect(page.locator('.child-conversation-open[aria-current="page"]')).toContainText("E2E nested level 3");
	await page.keyboard.press("Escape");
	await expect(page.getByRole("dialog", { name: "子对话", exact: true })).toHaveCount(0);
	for (const name of ["E2E nested level 2", "E2E completion"]) {
		await page.getByRole("button", { name: "返回上级对话", exact: true }).click();
		await expect(page.getByText("Demo runtime received: Return a result for " + name, { exact: true })).toBeVisible();
	}
	await page.getByRole("button", { name: "返回上级对话", exact: true }).click();
	await expect(page.getByText("Demo runtime received: E2E child conversation parent", { exact: true })).toBeVisible();
	await createTestSubagent(page, "/approval", "E2E cancellation");
	await page.getByRole("button", { name: "子对话", exact: true }).click();
	const task = page.locator(".child-conversation-row").filter({ hasText: "E2E cancellation" });
	await expect(task).toContainText("等待批准");
	await task.getByRole("button", { name: "停止子对话：E2E cancellation", exact: true }).click();
	await expect(task).toContainText("已取消");
});

test("creates, runs, and restores a durable background goal", async ({ page }) => {
	await createSession(page);
	const selectedSession = page.locator(".session-entry.selected");
	await selectedSession.hover();
	await selectedSession.getByRole("button", { name: "重命名会话" }).click();
	await selectedSession.getByRole("textbox", { name: "会话名称" }).fill("E2E durable goal session");
	await selectedSession.getByRole("button", { name: "保存名称" }).click();
	await page.getByRole("tab", { name: "目标" }).click();
	await page.getByRole("textbox", { name: "目标" }).fill("Return a durable E2E goal result");
	await page.getByRole("textbox", { name: "名称" }).fill("E2E goal");
	await page.getByRole("button", { name: "创建目标" }).click();
	await expect(page.getByText("等待中", { exact: true }).last()).toBeVisible();
	await page.getByRole("button", { name: "启动", exact: true }).click();
	await expect(page.getByText(/Demo runtime received: Return a durable E2E goal result/)).toBeVisible();
	await expect(page.getByText("已完成", { exact: true }).last()).toBeVisible();
	const sessionName = await page.locator(".session-entry.selected .session-open span").innerText();

	await page.reload();
	await expect(page.getByText("已连接", { exact: true })).toBeVisible();
	await expect(page.getByRole("heading", { name: "开始一个新任务" })).toBeVisible();
	await page.getByRole("navigation", { name: "会话" }).getByRole("button", { name: sessionName }).click();
	await page.getByRole("tab", { name: "目标" }).click();
	await expect(page.getByText(/Demo runtime received: Return a durable E2E goal result/)).toBeVisible();
	await page.setViewportSize({ width: 390, height: 844 });
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test("cancels a pending goal that was never started", async ({ page }) => {
	await createSession(page);
	await page.getByRole("tab", { name: "目标" }).click();
	await page.getByRole("textbox", { name: "目标" }).fill("Cancel this pending E2E goal");
	await page.getByRole("textbox", { name: "名称" }).fill("E2E goal cancellation");
	await page.getByRole("button", { name: "创建目标" }).click();
	await expect(page.getByText("等待中", { exact: true }).last()).toBeVisible();
	await expect(page.getByText("目标已创建但尚未启动，点击“启动”开始后台执行。")).toBeVisible();
	await page.getByRole("button", { name: "取消", exact: true }).click();
	await expect(page.getByText("已取消", { exact: true }).last()).toBeVisible();
	await expect(page.getByRole("button", { name: "启动", exact: true })).toBeHidden();
	await expect(page.getByRole("button", { name: "取消", exact: true })).toBeHidden();
});

test("runs a goal through a bounded review loop", async ({ page }) => {
	await createSession(page);
	await page.getByRole("tab", { name: "目标" }).click();
	await page.getByRole("textbox", { name: "目标" }).fill("Return a reviewed E2E goal result");
	await page.getByRole("textbox", { name: "名称" }).fill("E2E review loop");
	await page.getByRole("checkbox", { name: "启用评审循环" }).check();
	await page.getByRole("textbox", { name: "成功标准" }).fill("The result must mention the E2E goal");
	await page.getByRole("combobox", { name: "最大轮次" }).selectOption("2");
	await page.getByRole("button", { name: "创建目标" }).click();
	await expect(page.getByText("等待中", { exact: true }).last()).toBeVisible();
	await expect(page.getByRole("checkbox", { name: "启用评审循环" })).not.toBeChecked();
	await expect(page.getByRole("textbox", { name: "成功标准" })).toBeHidden();
	await expect(page.getByText("尚未开始", { exact: true })).toBeVisible();
	await expect(page.getByText("最多 2 轮", { exact: true })).toBeVisible();
	await expect(page.getByText("The result must mention the E2E goal")).toBeVisible();
	await expect(page.getByText("尚无评审记录。")).toBeVisible();

	await page.getByRole("button", { name: "启动", exact: true }).click();
	await expect(page.getByText("评审通过", { exact: true })).toBeVisible();
	await expect(page.getByText("第 1/2 轮", { exact: true })).toBeVisible();
	const history = page.getByRole("list", { name: "评审记录" });
	await expect(history.getByText("第 1 轮", { exact: true })).toBeVisible();
	await expect(history.getByText("通过", { exact: true })).toBeVisible();
	await expect(history.getByText("Demo reviewer accepted the candidate result.")).toBeVisible();
	const checks = history.getByRole("list", { name: "第 1 轮验收项" });
	await expect(checks.getByText("The configured success criteria", { exact: true })).toBeVisible();
	await expect(
		checks.getByText("The demo candidate contains the requested goal result.", { exact: true })
	).toBeVisible();
	await expect(history.getByText("本轮未记录工具调用", { exact: true })).toBeVisible();
	await expect(page.getByText(/Demo runtime received: Return a reviewed E2E goal result/)).toBeVisible();
	await expect(page.getByText("已完成", { exact: true }).last()).toBeVisible();
});

test("keeps the Goals workbench within a mobile viewport", async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.reload();
	await expect(page.getByText("已连接", { exact: true })).toBeVisible();
	await page.getByRole("button", { name: "打开导航" }).click();
	await createSession(page);
	await page.getByRole("button", { name: "关闭导航" }).first().click();
	await page.getByRole("tab", { name: "目标" }).click();
	const workbench = page.getByRole("region", { name: "目标" });
	await expect(workbench).toBeVisible();
	await page.getByRole("textbox", { name: "目标" }).fill("Fit the goals workbench into a small viewport");
	await page.getByRole("checkbox", { name: "启用评审循环" }).check();
	await page.getByRole("textbox", { name: "成功标准" }).fill("Nothing overflows the 390x844 viewport");
	await page.getByRole("button", { name: "创建目标" }).click();
	await expect(page.getByText("等待中", { exact: true }).last()).toBeVisible();
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
	expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(844);
	expect(await workbench.evaluate((element) => element.scrollWidth)).toBeLessThanOrEqual(390);
});

test("keeps the child conversation menu within a mobile viewport", async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.reload();
	await expect(page.locator(".connection")).toHaveClass(/connected/);
	await page.locator(".topbar-new-chat").click();
	await sendMessage(page, "Mobile child conversation parent");
	await expect(page.getByText(/Demo runtime received: Mobile child conversation parent/)).toBeVisible();
	await page.getByRole("button", { name: "子对话", exact: true }).click();
	await expect(page.getByRole("dialog", { name: "子对话", exact: true })).toBeVisible();
	await expect(page.getByText("暂无子对话", { exact: true })).toBeVisible();
	await page.getByRole("button", { name: "关闭子对话", exact: true }).click();
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
	expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(844);
});

test("shows the server tool catalog without mobile page overflow", async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.reload();
	await expect(page.getByText("已连接", { exact: true })).toBeVisible();
	await page.getByRole("tab", { name: "工具" }).click();
	const catalog = page.getByRole("table", { name: "Agent 工具目录" });
	await expect(catalog).toBeVisible();
	await expect(page.getByText("Demo", { exact: true })).toBeVisible();
	await expect(page.getByText("23 禁用", { exact: true })).toBeVisible();
	await expect(catalog.locator(".tool-status-row")).toHaveCount(23);
	await expect(catalog.getByRole("row").filter({ hasText: "编排" })).toHaveCount(3);
	await expect(catalog.getByRole("row").filter({ hasText: "browser_open" })).toHaveCount(1);
	await expect(catalog.getByRole("row").filter({ hasText: "preview_start" })).toHaveCount(1);
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
	expect(await catalog.evaluate((element) => element.scrollWidth)).toBeLessThanOrEqual(390);
});

test("renders one card per tool renderer inside a mobile viewport", async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.reload();
	await expect(page.getByText("已连接", { exact: true })).toBeVisible();
	await page.getByRole("button", { name: "打开导航" }).click();
	await createSession(page);
	await page.getByRole("button", { name: "关闭导航" }).first().click();
	await sendMessage(page, "/demo-rich");
	await expect(page.locator(".tool-card")).toHaveCount(12);
	// A tool without its own branch in `describeTool` falls back to showing the raw
	// name and arguments, so the verbs are how that regression becomes visible.
	const verbs = await page.locator(".tool-verb").allTextContents();
	expect([...new Set(verbs)].sort()).toEqual(
		["MCP · github", "写入", "列出", "匹配", "执行", "搜索", "检索", "编辑", "计划", "读取", "子代理"].sort()
	);
	// The plan is drawn as a checklist from the arguments; the tool's text result
	// repeats it verbatim and is suppressed, so exactly one copy reaches the reader.
	await expect(page.locator(".tool-plan-step")).toHaveCount(3);
	await expect(page.locator(".tool-plan-step.completed")).toHaveCount(1);
	await expect(page.getByText("Plan updated (1/3 done)")).toHaveCount(0);
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
	const overflowing = await page.evaluate(
		() =>
			[...document.querySelectorAll(".tool-card")].filter((element) => element.scrollWidth > element.clientWidth + 1)
				.length
	);
	expect(overflowing).toBe(0);
});

/** Reads a token straight off the root element, so a missing dark override shows up as an unchanged value. */ function cssToken(
	page: Page,
	name: string
): Promise<string> {
	return page.evaluate(
		(property) => getComputedStyle(document.documentElement).getPropertyValue(property).trim(),
		name
	);
}

test("switches themes from the topbar and remembers the choice", async ({ page }) => {
	const root = page.locator("html");
	// Playwright emulates a light OS preference by default, so "跟随系统" starts light.
	await expect(root).toHaveAttribute("data-theme", "light");
	const lightBackground = await cssToken(page, "--bg");

	await page.getByRole("button", { name: "切换深浅主题" }).click();
	await expect(root).toHaveAttribute("data-theme", "dark");
	expect(await cssToken(page, "--bg")).not.toBe(lightBackground);
	// The whole point of the token layer: one attribute re-points every family.
	expect(await cssToken(page, "--surface")).not.toBe("");
	await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", "#0e120f");

	await page.reload();
	await expect(page.getByText("已连接", { exact: true })).toBeVisible();
	await expect(root).toHaveAttribute("data-theme", "dark");

	await page.getByRole("button", { name: "切换深浅主题" }).click();
	await expect(root).toHaveAttribute("data-theme", "light");
	expect(await cssToken(page, "--bg")).toBe(lightBackground);
	await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", "#f7f8f6");
});

test("paints the stored theme before the app boots", async ({ page }) => {
	await page.getByRole("button", { name: "切换深浅主题" }).click();
	await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

	// With the app entry blocked nothing React can run, so a dark root proves the
	// inline pre-paint script resolved the stored choice on its own — that script
	// is the only thing standing between a dark-mode user and a light flash.
	await page.route("**/src/main.tsx", (route) => route.abort());
	await page.reload();
	await expect(page.locator("#root")).toBeEmpty();
	await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

test("follows the operating system when asked to", async ({ page }) => {
	const root = page.locator("html");
	await page.getByRole("button", { name: "切换深浅主题" }).click();
	await expect(root).toHaveAttribute("data-theme", "dark");

	await page.getByRole("button", { name: "设置" }).click();
	const themes = page.getByRole("group", { name: "主题" });
	await expect(themes.getByRole("button", { name: "深色" })).toHaveAttribute("aria-pressed", "true");
	await themes.getByRole("button", { name: "跟随系统" }).click();
	await expect(themes.getByRole("button", { name: "跟随系统" })).toHaveAttribute("aria-pressed", "true");
	await expect(root).toHaveAttribute("data-theme", "light");

	// A "跟随系统" user must track the OS live, without a reload.
	await page.emulateMedia({ colorScheme: "dark" });
	await expect(root).toHaveAttribute("data-theme", "dark");
	await page.emulateMedia({ colorScheme: "light" });
	await expect(root).toHaveAttribute("data-theme", "light");

	// An explicit choice must stop tracking the OS.
	await themes.getByRole("button", { name: "浅色" }).click();
	await page.emulateMedia({ colorScheme: "dark" });
	await expect(root).toHaveAttribute("data-theme", "light");
});

test("switches interface language from settings and remembers the choice", async ({ page }) => {
	const root = page.locator("html");
	await page.getByRole("button", { name: "设置" }).click();

	const dialog = page.getByRole("dialog", { name: "设置" });
	const languages = dialog.getByRole("group", { name: "语言" });
	await expect(languages.getByRole("button", { name: "中文" })).toHaveAttribute("aria-pressed", "true");

	await languages.getByRole("button", { name: "English" }).click();
	await expect(root).toHaveAttribute("lang", "en");
	await expect(root).toHaveAttribute("data-locale", "en");
	await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
	await expect(page.getByText("Appearance", { exact: true })).toBeVisible();

	await page.reload();
	await expect(page.getByText("Connected", { exact: true })).toBeVisible();
	await expect(root).toHaveAttribute("lang", "en");
	await expect(page.getByRole("button", { name: "Settings" })).toBeVisible();

	await page.getByRole("button", { name: "Settings" }).click();
	await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
	await expect(page.getByRole("dialog", { name: "Settings" }).getByRole("group", { name: "Language" })).toBeVisible();
});

test("organizes settings into focused sections without mobile overflow", async ({ page }) => {
	await page.getByRole("button", { name: "设置" }).click();
	const dialog = page.getByRole("dialog", { name: "设置" });
	const navigation = dialog.getByRole("navigation", { name: "设置分类" });

	await expect(navigation.getByRole("button", { name: /^常规/ })).toHaveAttribute("aria-current", "page");
	await expect(dialog.getByText("外观", { exact: true })).toBeVisible();
	await expect(dialog.getByText("自定义模型", { exact: true })).toBeHidden();

	await navigation.getByRole("button", { name: /^模型/ }).click();
	await expect(dialog.locator("#settings-panel-models")).toBeVisible();
	await expect(dialog.locator("#settings-panel-models").getByRole("heading", { name: "模型" })).toBeVisible();
	await expect(dialog.getByText("外观", { exact: true })).toBeHidden();

	await navigation.getByRole("button", { name: /^用量统计/ }).click();
	const usagePanel = dialog.locator("#settings-panel-usage");
	await expect(usagePanel).toBeVisible();
	await expect(usagePanel.getByText("全部历史累计", { exact: true })).toBeVisible();
	await expect(usagePanel.getByRole("combobox", { name: "统计范围" })).toHaveValue("");
	await expect(usagePanel.getByRole("heading", { name: "每日趋势" })).toBeVisible();
	await expect(usagePanel.locator(".usage-settings-day")).toHaveCount(7);
	await usagePanel.getByRole("button", { name: "近 30 天", exact: true }).click();
	await expect(usagePanel.locator(".usage-settings-day")).toHaveCount(30);

	await page.setViewportSize({ width: 390, height: 844 });
	await expect(dialog).toBeVisible();
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
	expect(await dialog.evaluate((element) => element.scrollWidth)).toBeLessThanOrEqual(390);

	await navigation.getByRole("button", { name: /^连接与执行/ }).click();
	await expect(dialog.getByText("命令执行位置", { exact: true })).toBeVisible();
	await expect(dialog.getByText("网关连接", { exact: true })).toBeVisible();
});
