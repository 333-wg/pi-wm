import { test, expect } from "@playwright/test";
import { startPhonePreview } from "../apps/gateway/test/phone-preview.mjs";

let fixture: Awaited<ReturnType<typeof startPhonePreview>>;
test.beforeAll(async () => {
	fixture = await startPhonePreview();
});
test.afterAll(async () => {
	await fixture.close();
});
test.beforeEach(async () => {
	await fixture.control("disable", {});
});
test.use({ ignoreHTTPSErrors: true, contextOptions: { reducedMotion: "reduce" } });

test("phone setup guide copies a safe prompt and supports manual fallback without enabling access", async ({
	page,
}, testInfo) => {
	const errors: string[] = [];
	const writes: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	page.on("request", (request) => {
		if (request.url().includes("/api/phone-access/") && request.method() === "POST") writes.push(request.url());
	});
	await page.addInitScript((token) => {
		localStorage.setItem("wuming.token", token);
		localStorage.setItem("wuming.onboarding.complete", "true");
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: {
				writeText: async (text: string) => {
					sessionStorage.setItem("guide-copied", text);
				},
			},
		});
	}, fixture.token);
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto(fixture.desktopUrl);
	await page.getByRole("button", { name: "设置", exact: true }).click();
	await page.getByRole("button", { name: "手机访问 配对与远程接续", exact: true }).click();
	const guide = page.getByRole("region", { name: "第一次使用？让 AI 帮你准备" });
	await expect(guide).toBeVisible();
	await expect(guide.locator("li")).toHaveCount(3);
	await expect(page.getByRole("button", { name: "同意并开启手机访问" })).toBeDisabled();
	await guide.getByRole("button", { name: "复制安装提示词", exact: true }).click();
	await expect(guide.getByRole("button", { name: "已复制安装提示词" })).toBeVisible();
	const prompt = await page.evaluate(() => sessionStorage.getItem("guide-copied"));
	expect(prompt).toContain("Cloudflare 官方");
	expect(prompt).toContain("--version");
	expect(prompt).toContain("不要启动隧道、开启公网访问");
	await guide.getByText("查看 / 手动复制提示词", { exact: true }).click();
	await expect(guide.getByRole("textbox", { name: "安装提示词" })).toHaveValue(prompt!);
	await guide.getByText("查看 / 手动复制提示词", { exact: true }).click();
	await page.screenshot({ path: testInfo.outputPath("phone-guide-desktop.png") });
	await page.evaluate(() => {
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: {
				writeText: async () => {
					throw new Error("clipboard denied");
				},
			},
		});
	});
	await guide.getByRole("button", { name: "已复制安装提示词" }).click();
	await expect(guide.getByRole("status")).toHaveText("复制失败，请在下方文本框全选并手动复制。");
	await expect(guide.getByRole("textbox", { name: "安装提示词" })).toBeVisible();
	await guide.getByRole("textbox", { name: "安装提示词" }).focus();
	expect(
		await guide
			.getByRole("textbox", { name: "安装提示词" })
			.evaluate((node: HTMLTextAreaElement) => node.selectionEnd - node.selectionStart)
	).toBe(prompt!.length);
	await page.setViewportSize({ width: 390, height: 844 });
	await guide.scrollIntoViewIfNeeded();
	await page.screenshot({ path: testInfo.outputPath("phone-guide-mobile.png") });
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
	await expect(page.getByRole("checkbox", { name: /我理解/ })).not.toBeChecked();
	expect(writes).toEqual([]);
	expect(errors).toEqual([]);
});

test("pairing effects reflect connection, generation, failure and reduced motion", async ({ page }, testInfo) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.addInitScript((token) => {
		localStorage.setItem("wuming.token", token);
		localStorage.setItem("wuming.onboarding.complete", "true");
	}, fixture.token);
	let tunnelState = "connecting";
	let ready = false;
	let fail = false;
	let release: (() => void) | undefined;
	let requests = 0;
	await page.route("**/api/phone-access/status", (route) =>
		route.fulfill({
			json: {
				enabled: true,
				port: 5188,
				url: ready ? `${fixture.origin}/phone` : null,
				tunnel: { state: tunnelState, stage: ready ? "已连接" : "等待边缘连接" },
				pending: [],
				devices: [],
			},
		})
	);
	await page.route("**/api/phone-access/pairing", async (route) => {
		requests++;
		await new Promise<void>((resolve) => {
			release = resolve;
		});
		await route.fulfill(
			fail
				? { status: 503, json: { error: "测试：配对服务暂时不可用" } }
				: { json: { url: `${fixture.origin}/phone#pair=isolated-effect-test`, expiresAt: Date.now() + 300000 } }
		);
	});
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto(fixture.desktopUrl);
	await page.getByRole("button", { name: "设置", exact: true }).click();
	await page.getByRole("button", { name: "手机访问 配对与远程接续", exact: true }).click();
	await expect(page.getByRole("button", { name: "等待隧道连接…" })).toBeDisabled();
	expect(requests).toBe(0);
	tunnelState = "error";
	await expect(page.getByRole("button", { name: "隧道未连接", exact: true })).toBeDisabled();
	await expect(page.locator(".phone-pair-spinner")).toHaveCount(0);
	ready = true;
	tunnelState = "ready";
	const trigger = page.getByRole("button", { name: "生成配对二维码", exact: true });
	await expect(trigger).toBeEnabled();
	await expect(trigger).toHaveCSS("animation-name", "none");
	await page.emulateMedia({ reducedMotion: "no-preference" });
	await expect(trigger).toHaveCSS("animation-name", "phone-pair-glow");
	await trigger.click();
	const loading = page.getByRole("button", { name: "正在生成二维码…" });
	await expect(loading).toBeDisabled();
	await expect(loading).toHaveAttribute("aria-busy", "true");
	await expect(page.locator(".phone-pair-spinner")).toHaveCSS("animation-name", "phone-pair-spin");
	await loading.scrollIntoViewIfNeeded();
	await page.screenshot({ path: testInfo.outputPath("pair-generating-desktop.png") });
	await expect.poll(() => Boolean(release)).toBe(true);
	release!();
	await expect(page.getByAltText("手机访问一次性配对二维码")).toBeVisible();
	await page.locator(".phone-pair").scrollIntoViewIfNeeded();
	await page.screenshot({ path: testInfo.outputPath("pair-ready-desktop.png") });
	expect(requests).toBe(1);
	await page.setViewportSize({ width: 390, height: 844 });
	await page.emulateMedia({ reducedMotion: "reduce" });
	await expect(page.locator(".phone-pair")).toHaveCSS("animation-name", "none");
	await page.locator(".phone-pair").scrollIntoViewIfNeeded();
	await page.screenshot({ path: testInfo.outputPath("pair-ready-mobile.png") });
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
	fail = true;
	release = undefined;
	await trigger.click();
	await expect(loading).toBeDisabled();
	await expect(page.getByAltText("手机访问一次性配对二维码")).toHaveCount(0);
	await expect.poll(() => Boolean(release)).toBe(true);
	release!();
	await expect(page.getByRole("alert")).toHaveText("测试：配对服务暂时不可用");
	await expect(trigger).toBeEnabled();
	await expect(page.locator(".phone-pair-spinner")).toHaveCount(0);
	expect(requests).toBe(2);
	expect(errors).toEqual([]);
});

test("welcome retries authorization, explains browser scope, and avoids desktop assets", async ({ page }, testInfo) => {
	await fixture.control("disable", {});
	await fixture.control("enable", { mode: "proxy", origin: fixture.origin, port: fixture.remotePort });
	const assets: string[] = [];
	const errors: string[] = [];
	page.on("request", (r) => {
		if (r.url().includes("/assets/")) assets.push(r.url());
	});
	page.on("pageerror", (e) => errors.push(e.message));
	await page.route("**/api/phone/session", (route) => route.abort());
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto(fixture.phoneUrl);
	await expect(page.getByRole("alert")).toContainText("无需立即重新配对");
	await page.unroute("**/api/phone/session");
	await page.getByRole("button", { name: "重新检查授权" }).click();
	await expect(page.getByRole("status")).toHaveText("此浏览器尚未配对");
	await expect(page.getByRole("alert")).toHaveCount(0);
	await expect(page.getByRole("button", { name: "请求配对这部手机" })).toHaveCount(0);
	await page.screenshot({ path: testInfo.outputPath("welcome-return-mobile.png") });
	await page.getByText("之前配对过，为什么还停在这里？", { exact: true }).click();
	await expect(page.getByText(/扫码工具、聊天软件和系统浏览器可能不共享授权/)).toBeVisible();
	await page.getByRole("button", { name: "复制入口地址" }).click();
	await expect(page.getByRole("button", { name: /已复制入口|复制失败/ })).toBeVisible();
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.screenshot({ path: testInfo.outputPath("welcome-return-desktop.png") });
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
	expect(assets.some((url) => url.includes("phone-main"))).toBe(true);
	expect(assets.some((url) => url.includes("desktop-main"))).toBe(false);
	expect(errors).toEqual([]);
});

test("desktop pairing, mobile continuation, reload, revocation and narrow/wide layout", async ({
	page,
	browser,
}, testInfo) => {
	// This scenario now includes pairing plus several independent workbench workflows.
	test.setTimeout(60_000);
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(e.message));
	page.on("console", (m) => {
		if (m.type() === "error") errors.push(m.text());
	});
	await page.addInitScript((token) => {
		localStorage.setItem("wuming.token", token);
		localStorage.setItem("wuming.onboarding.complete", "true");
	}, fixture.token);
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto(fixture.desktopUrl);
	await page.getByRole("button", { name: "设置", exact: true }).click();
	await page.getByRole("button", { name: "手机访问 配对与远程接续", exact: true }).click();
	await expect(page.getByRole("heading", { name: "手机访问", exact: true })).toBeVisible();
	await page.getByLabel("连接方式").selectOption("proxy");
	await page.getByLabel("公网 HTTPS 域名").fill(fixture.origin);
	await page.getByLabel("本机回环端口").fill(String(fixture.remotePort));
	await page.getByRole("checkbox", { name: /我理解/ }).check();
	await page.getByRole("button", { name: "同意并开启手机访问" }).click();
	await expect(page.getByRole("button", { name: "生成配对二维码" })).toBeEnabled();
	await page.getByRole("button", { name: "生成配对二维码" }).click();
	await expect(page.getByAltText("手机访问一次性配对二维码")).toBeVisible();
	await page.screenshot({ path: testInfo.outputPath("desktop-phone-settings.png"), fullPage: true });
	// Use a freshly issued link so the test doesn't need clipboard permissions or QR decoding.
	const pair = await fixture.control("pairing", {});
	const mobile = await browser.newContext({
		ignoreHTTPSErrors: true,
		reducedMotion: "reduce",
		viewport: { width: 390, height: 844 },
	});
	const phone = await mobile.newPage();
	phone.on("pageerror", (e) => errors.push(e.message));
	phone.on("console", (m) => {
		if (m.type() === "error") errors.push(m.text());
	});
	await phone.goto(pair.url);
	await expect(phone.getByRole("heading", { name: "把工作台带在身边" })).toBeVisible();
	await phone.screenshot({ path: testInfo.outputPath("phone-pairing.png"), fullPage: true });
	await expect(phone).not.toHaveURL(/#pair/);
	await phone.getByLabel("设备名称").fill("验收手机");
	await phone.getByRole("button", { name: "请求配对这部手机" }).click();
	await expect(page.getByRole("button", { name: "确认配对" })).toBeVisible();
	await page.getByRole("checkbox", { name: /允许完整对话能力/ }).check();
	await page.getByRole("button", { name: "确认配对" }).click();
	await expect(phone.getByRole("status")).toHaveText("已连接");
	// A saved clean URL in a new tab keeps the same browser's device authorization.
	const reopened = await mobile.newPage();
	await reopened.goto(fixture.phoneUrl);
	await expect(reopened.getByRole("status")).toHaveText("已连接");
	await reopened.close();
	// Entering through an external site must serve the public shell, then recover via same-origin cookie fetch.
	await phone.goto(fixture.desktopUrl);
	await phone.evaluate((url) => {
		const a = document.createElement("a");
		a.href = url;
		a.textContent = "返回手机工作台";
		document.body.append(a);
	}, fixture.phoneUrl);
	await phone.getByRole("link", { name: "返回手机工作台" }).click();
	await expect(phone.getByRole("status")).toHaveText("已连接");
	const cookies = await mobile.cookies();
	const cookie = cookies.find((c) => c.name === "__Host-wuming-phone");
	expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: "Strict" });
	await phone.getByRole("button", { name: "打开会话列表" }).click();
	await expect(phone.getByRole("dialog", { name: "项目与会话" })).toBeVisible();
	const projectRow = phone.getByRole("button", { name: "手机访问验收项目", exact: true });
	await expect(projectRow).toHaveAttribute("aria-expanded", "true");
	await expect(phone.getByRole("dialog", { name: "项目与会话" }).getByRole("heading", { name: "Pi-Wm" })).toBeVisible();
	await expect(phone.getByLabel("选择项目")).toHaveCount(0);
	await projectRow.click();
	await expect(phone.getByLabel("搜索会话")).toBeHidden();
	await projectRow.click();
	await phone.getByLabel("搜索会话").fill("筛选应随项目切换重置");
	await phone.getByRole("button", { name: "ai-image", exact: true }).click();
	await expect(projectRow).toHaveAttribute("aria-expanded", "false");
	await expect(phone.getByText("此项目暂无会话", { exact: true })).toBeVisible();
	await expect(phone.getByLabel("搜索会话")).toHaveValue("");
	await projectRow.click();
	await phone.getByRole("button", { name: "刷新会话", exact: true }).click();
	const sessionRow = phone
		.getByRole("navigation", { name: "会话列表" })
		.getByRole("button", { name: /电脑与手机接续测试/ });
	await expect(sessionRow).toBeVisible();
	const rowBox = await sessionRow.boundingBox();
	expect(rowBox!.y).toBeLessThan(320);
	expect(rowBox!.height).toBeGreaterThanOrEqual(44);
	expect(rowBox!.height).toBeLessThan(60);
	await phone.screenshot({ path: testInfo.outputPath("phone-drawer-mobile.png") });
	await sessionRow.click();
	await phone.getByRole("button", { name: "打开会话列表" }).click();
	await expect(sessionRow).toHaveAttribute("aria-current", "page");
	await phone.getByRole("button", { name: "关闭项目与会话" }).click();
	await phone.getByLabel("继续这段对话").fill("跨项目切换保留草稿");
	await phone.getByRole("button", { name: "打开会话列表" }).click();
	await phone.getByRole("button", { name: "ai-image", exact: true }).click();
	await projectRow.click();
	await sessionRow.click();
	await expect(phone.getByLabel("继续这段对话")).toHaveValue("跨项目切换保留草稿");
	await phone.getByRole("button", { name: "打开会话列表" }).click();
	await phone.setViewportSize({ width: 1440, height: 900 });
	await phone.screenshot({ path: testInfo.outputPath("phone-drawer-desktop.png") });
	await phone.keyboard.press("Escape");
	await expect(phone.getByRole("dialog", { name: "项目与会话" })).toBeHidden();
	await phone.setViewportSize({ width: 390, height: 844 });
	await phone.getByLabel("继续这段对话").fill("请确认手机已接续电脑会话");
	await phone.getByRole("button", { name: "发送", exact: true }).click();
	await expect(
		phone.getByText("手机与电脑共享同一会话。此回复来自本地演示运行时，没有调用真实模型或执行命令。", { exact: true })
	).toBeVisible();
	expect(fixture.snapshot().transcript.filter((i) => i.type === "user")).toHaveLength(1);
	await phone.screenshot({ path: testInfo.outputPath("phone-chat-mobile.png"), fullPage: true });
	expect(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
	await phone.getByLabel("继续这段对话").fill("断开页面后任务继续");
	await phone.getByRole("button", { name: "发送", exact: true }).click();
	await expect.poll(() => fixture.snapshot().session.phase).toBe("turn");
	await phone.reload();
	await expect.poll(() => fixture.snapshot().session.phase).toBe("idle");
	await expect(phone.getByRole("status")).toHaveText("已连接");
	await expect(phone.getByRole("heading", { name: "电脑与手机接续测试", exact: true })).toBeVisible();
	await expect(phone.locator(".phone-message-text").getByText("断开页面后任务继续", { exact: true })).toBeVisible();
	expect(fixture.snapshot().transcript.filter((i) => i.type === "user")).toHaveLength(2);
	await phone.setViewportSize({ width: 1440, height: 900 });
	await phone.screenshot({ path: testInfo.outputPath("phone-chat-desktop.png"), fullPage: true });
	await phone.getByLabel("继续这段对话").fill("验证审批按钮");
	await phone.getByRole("button", { name: "发送", exact: true }).click();
	await expect(phone.getByRole("button", { name: "批准此操作" })).toBeVisible();
	await phone.getByRole("button", { name: "批准此操作" }).click();
	await expect(phone.getByRole("button", { name: "批准此操作" })).toHaveCount(0);
	await expect.poll(() => fixture.snapshot().session.phase).toBe("idle");
	await expect(phone.getByRole("button", { name: "停止任务" })).toBeHidden();
	await phone.getByLabel("继续这段对话").fill("验证停止按钮");
	await phone.getByRole("button", { name: "发送", exact: true }).click();
	await expect(phone.getByRole("button", { name: "停止任务" })).toBeEnabled();
	await phone.getByRole("button", { name: "停止任务" }).click();
	await expect.poll(() => fixture.snapshot().session.phase).toBe("idle");
	// Expanded workbench operates only after explicit desktop grant.
	await phone.getByRole("button", { name: "会话设置", exact: true }).click();
	await phone.getByLabel("重命名会话").fill("手机重命名验收");
	await phone.getByRole("button", { name: "保存名称" }).click();
	await expect(phone.getByRole("heading", { name: "手机重命名验收" })).toBeVisible();
	await phone.getByRole("button", { name: "关闭会话设置" }).click();
	await phone.getByRole("button", { name: "选择模型与思考" }).click();
	await phone.getByLabel("当前模型").selectOption(JSON.stringify(["demo", "demo-alternate"]));
	await expect.poll(() => fixture.snapshot().model.id).toBe("demo-alternate");
	await phone.getByLabel("当前模型").selectOption(JSON.stringify(["demo", "demo-model"]));
	await phone.getByLabel("思考强度").selectOption("high");
	await expect.poll(() => fixture.snapshot().thinkingLevel).toBe("high");
	await phone.getByRole("button", { name: "关闭模型与思考" }).click();
	await phone.getByRole("button", { name: "会话设置", exact: true }).click();
	await phone.getByRole("button", { name: "归档会话", exact: true }).click();
	await phone.getByRole("button", { name: "关闭会话设置" }).click();
	await expect(phone.getByRole("button", { name: "发送", exact: true })).toBeDisabled();
	await phone.getByRole("button", { name: "打开会话列表" }).click();
	await phone.getByRole("button", { name: "查看归档聊天", exact: true }).click();
	await expect(phone.getByRole("navigation", { name: "会话列表" }).getByText("手机重命名验收")).toBeVisible();
	await phone.getByRole("button", { name: "关闭项目与会话" }).click();
	await phone.getByRole("button", { name: "会话设置", exact: true }).click();
	await phone.getByRole("button", { name: "恢复会话", exact: true }).click();
	await phone.getByRole("button", { name: "关闭会话设置" }).click();
	await phone.getByRole("button", { name: "打开会话列表" }).click();
	await phone.getByRole("button", { name: "返回当前聊天", exact: true }).click();
	await phone.getByLabel("搜索会话").fill("不存在");
	await expect(phone.getByRole("navigation", { name: "会话列表" }).getByRole("button")).toHaveCount(0);
	await expect(phone.getByText("没有找到匹配的会话", { exact: true })).toBeVisible();
	await phone.getByLabel("搜索会话").fill("重命名");
	await expect(phone.getByRole("navigation", { name: "会话列表" }).getByRole("button")).toHaveCount(1);
	await expect(phone.getByLabel("会话名称", { exact: true })).toHaveCount(0);
	await expect(phone.getByLabel("新会话模型")).toHaveCount(0);
	await phone.setViewportSize({ width: 390, height: 844 });
	await phone.getByRole("button", { name: "新对话", exact: true }).click();
	await expect(phone.getByRole("heading", { name: "新对话", exact: true })).toBeVisible();
	await expect(phone.getByRole("dialog", { name: "项目与会话" })).toBeHidden();
	await phone.screenshot({ path: testInfo.outputPath("phone-one-click-created.png") });
	await phone.getByRole("button", { name: "选择模型与思考" }).click();
	await expect(phone.getByLabel("当前模型")).toHaveValue(JSON.stringify(["demo", "demo-model"]));
	await phone.getByRole("button", { name: "关闭模型与思考" }).click();
	await phone.getByRole("button", { name: "打开会话列表" }).click();
	await expect(phone.getByLabel("搜索会话")).toHaveValue("");
	await expect(
		phone.getByRole("navigation", { name: "会话列表" }).getByRole("button", { name: "新对话", exact: true })
	).toHaveCount(1);
	await phone.getByRole("button", { name: "关闭项目与会话" }).click();
	// Renaming is optional and remains available after one-click creation.
	await phone.getByRole("button", { name: "会话设置", exact: true }).click();
	await phone.getByLabel("重命名会话").fill("手机独立任务");
	await phone.getByRole("button", { name: "保存名称" }).click();
	await phone.getByRole("button", { name: "关闭会话设置" }).click();
	await expect(phone.getByRole("heading", { name: "手机独立任务" })).toBeVisible();
	const messageInput = phone.getByLabel("继续这段对话");
	await expect(phone.getByRole("button", { name: "Skill", exact: true })).toHaveCount(0);
	await messageInput.fill("https://example.com/path");
	await expect(phone.getByRole("listbox", { name: "选择技能" })).toHaveCount(0);
	await messageInput.fill("/");
	await expect(phone.getByRole("option", { name: /手机验收技能/ })).toBeVisible();
	await phone.screenshot({ path: testInfo.outputPath("phone-slash-skills-mobile.png") });
	await phone.setViewportSize({ width: 1440, height: 900 });
	await phone.screenshot({ path: testInfo.outputPath("phone-slash-skills-desktop.png") });
	await phone.setViewportSize({ width: 390, height: 540 });
	await expect(phone.getByRole("option", { name: /手机验收技能/ })).toBeInViewport();
	await phone.screenshot({ path: testInfo.outputPath("phone-slash-skills-keyboard.png") });
	await phone.setViewportSize({ width: 390, height: 844 });
	await messageInput.fill("/不存在的技能");
	await expect(phone.getByText("没有匹配的技能", { exact: true })).toBeVisible();
	await messageInput.press("Enter");
	await expect(messageInput).toHaveValue("/不存在的技能");
	await expect(phone.locator(".phone-message.user")).toHaveCount(0);
	await messageInput.fill("/验收");
	await messageInput.press("Escape");
	await expect(phone.getByRole("listbox", { name: "选择技能" })).toHaveCount(0);
	await messageInput.fill("/phone");
	await phone.getByRole("option", { name: /手机验收技能/ }).click();
	await expect(messageInput).toHaveValue("");
	await expect(messageInput).toBeFocused();
	await phone.getByRole("button", { name: "移除技能 手机验收技能" }).click();
	await expect(phone.getByRole("button", { name: "移除技能 手机验收技能" })).toHaveCount(0);
	await messageInput.fill("/验收");
	await messageInput.press("ArrowDown");
	await messageInput.press("Enter");
	await expect(phone.getByRole("button", { name: "移除技能 手机验收技能" })).toBeVisible();
	await expect(messageInput).toHaveValue("");
	await expect(phone.locator(".phone-message.user")).toHaveCount(0);
	await phone.getByLabel("上传附件（最多 8 个，每个 10 MB）").setInputFiles([
		{ name: "phone.txt", mimeType: "text/plain", buffer: Buffer.from("phone fixture upload") },
		{
			name: "pixel.png",
			mimeType: "image/png",
			buffer: Buffer.from(
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
				"base64"
			),
		},
	]);
	await expect(phone.getByRole("button", { name: "移除附件" })).toHaveCount(2);
	await phone.getByLabel("继续这段对话").fill("验证 Markdown 与附件");
	await phone.reload();
	await expect(phone.getByRole("heading", { name: "手机独立任务" })).toBeVisible();
	await expect(phone.getByLabel("继续这段对话")).toHaveValue("验证 Markdown 与附件");
	await expect(phone.getByRole("button", { name: "移除技能 手机验收技能" })).toBeVisible();
	await expect(phone.getByRole("button", { name: "移除附件" })).toHaveCount(2);
	await phone.getByRole("button", { name: "发送", exact: true }).click();
	await expect(phone.getByRole("heading", { name: "验收结果" })).toBeVisible();
	await expect(phone.getByRole("button", { name: "复制代码" })).toBeVisible();
	const createdId = await phone.evaluate(() => sessionStorage.getItem("phone-recent:phone-project"));
	expect(fixture.operations(createdId!)[0]?.payload.skills).toEqual(["phone-check"]);
	const download = phone.getByRole("link", { name: "phone.txt · 下载" });
	await expect(download).toBeVisible();
	const artifact = await mobile.request.get(
		(await download.getAttribute("href"))!.replace(/^\//, `${fixture.origin}/`)
	);
	expect(artifact.status()).toBe(200);
	expect(await artifact.text()).toBe("phone fixture upload");
	expect(artifact.headers()["cache-control"]).toBe("no-store");
	await expect.poll(() => phone.getByAltText("pixel.png").evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(1);
	await phone.getByRole("button", { name: "会话设置", exact: true }).click();
	await phone.getByLabel("主题", { exact: true }).selectOption("dark");
	await phone.getByLabel("字号", { exact: true }).selectOption("large");
	await phone.getByRole("button", { name: "关闭会话设置" }).click();
	await expect(phone.locator(".phone-message-text").last()).toHaveCSS("color", "rgb(236, 238, 237)");
	await phone.screenshot({ path: testInfo.outputPath("phone-workbench-desktop.png"), fullPage: true });
	await phone.setViewportSize({ width: 390, height: 844 });
	await expect
		.poll(() => phone.locator(".phone-app").evaluate((el) => Math.round(el.getBoundingClientRect().height)))
		.toBe(844);
	await phone.screenshot({ path: testInfo.outputPath("phone-workbench-mobile.png"), fullPage: true });
	await phone.getByRole("button", { name: "打开会话列表" }).click();
	await expect(
		phone.getByRole("navigation", { name: "会话列表" }).getByRole("button", { name: /手机独立任务/ })
	).toHaveAttribute("aria-current", "page");
	await phone.screenshot({ path: testInfo.outputPath("phone-drawer-dark-mobile.png") });
	await phone.getByRole("button", { name: "关闭项目与会话" }).click();
	expect(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
	// Mobile panels preserve draft, focus and browser Back without leaving the conversation.
	await phone.getByLabel("继续这段对话").fill("面板关闭后草稿仍在");
	await phone.getByRole("button", { name: "选择模型与思考" }).click();
	await expect(phone.getByRole("dialog", { name: "模型与思考" })).toBeInViewport();
	await phone.screenshot({ path: testInfo.outputPath("phone-model-sheet.png") });
	await phone.goBack();
	await expect(phone.getByRole("dialog", { name: "模型与思考" })).toBeHidden();
	await expect(phone.getByRole("button", { name: "选择模型与思考" })).toBeFocused();
	await phone.getByRole("button", { name: "收起输入区" }).click();
	await expect(phone.getByLabel("继续这段对话")).toBeHidden();
	await phone.getByRole("button", { name: "展开输入区" }).click();
	await expect(phone.getByLabel("继续这段对话")).toHaveValue("面板关闭后草稿仍在");
	await phone.getByRole("button", { name: "会话设置", exact: true }).click();
	await phone.keyboard.press("Escape");
	await expect(phone.getByRole("dialog", { name: "会话设置" })).toBeHidden();
	await phone.getByLabel("继续这段对话").fill(Array.from({ length: 20 }, (_, i) => `长草稿 ${i}`).join("\n"));
	expect(
		await phone.getByLabel("继续这段对话").evaluate((el) => el.getBoundingClientRect().height)
	).toBeLessThanOrEqual(144);
	await expect(phone.getByRole("button", { name: "发送", exact: true })).toBeInViewport();
	await phone.getByLabel("继续这段对话").fill("");
	expect(await phone.locator(".phone-transcript").evaluate((el) => el.clientHeight)).toBeGreaterThan(500);
	// Emulate reduced visual space; physical mobile keyboard still needs device acceptance.
	await phone.setViewportSize({ width: 390, height: 540 });
	await expect(phone.getByRole("button", { name: "发送", exact: true })).toBeInViewport();
	await phone.screenshot({ path: testInfo.outputPath("phone-workbench-keyboard.png"), fullPage: true });
	await phone.setViewportSize({ width: 390, height: 844 });
	await mobile.setOffline(true);
	await phone.getByLabel("继续这段对话").fill("断线时保留的草稿");
	await mobile.setOffline(false);
	await phone.reload();
	await expect(phone.getByRole("status")).toHaveText("已连接");
	await expect(phone.getByLabel("继续这段对话")).toHaveValue("断线时保留的草稿");
	await expect(phone.locator(".phone-message.user")).toHaveCount(1);
	await phone.getByLabel("继续这段对话").fill("验证长对话阅读");
	await phone.getByRole("button", { name: "发送", exact: true }).click();
	await expect(phone.getByRole("heading", { name: "阅读段落 30", exact: true })).toBeVisible();
	await phone.locator(".phone-transcript").evaluate((el) => {
		el.scrollTop = 350;
	});
	await expect(phone.getByRole("button", { name: "回到底部" })).toBeVisible();
	const readingTop = await phone.locator(".phone-transcript").evaluate((el) => el.scrollTop);
	await phone.getByRole("button", { name: "选择模型与思考" }).click();
	await phone.getByRole("button", { name: "关闭模型与思考" }).click();
	expect(Math.abs((await phone.locator(".phone-transcript").evaluate((el) => el.scrollTop)) - readingTop)).toBeLessThan(
		3
	);
	await phone.getByRole("button", { name: "回到底部" }).click();
	await expect
		.poll(() => phone.locator(".phone-transcript").evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight))
		.toBeLessThan(80);
	await phone.screenshot({ path: testInfo.outputPath("phone-long-conversation.png") });
	// Authenticated phone cannot access local controls even through a valid HTTPS proxy.
	const blocked = await mobile.request.get(`${fixture.origin}/api/computer-use`);
	expect(blocked.status()).toBe(403);
	await page.getByRole("button", { name: "撤销设备" }).click();
	await expect(phone.getByRole("status")).toHaveText("授权已撤销，请重新配对");
	await page.getByRole("button", { name: "关闭手机访问" }).click();
	await expect(page.getByRole("button", { name: "同意并开启手机访问" })).toBeVisible();
	expect(errors).toEqual([]);
	await mobile.close();
});
