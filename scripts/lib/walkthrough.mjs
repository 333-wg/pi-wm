// The walkthroughs the browser-driven scripts share.
//
// A walkthrough drives the app into a state and then calls `capture.shot(name)`.
// What a shot *is* belongs to the caller: `scripts/ui-shots.mjs` writes a PNG,
// `scripts/contrast-crawl.mjs` measures every colour pair on screen. Keeping the
// route here means the crawl can never fall behind the screenshots — a surface
// added for one is automatically visited by the other.

// The markdown probe deliberately exercises every syntax token class the
// highlighter can emit — comment, string, number, keyword, builtin, function,
// property, punct, tag, attr, meta, added, removed. A class the probe never
// renders is a colour the contrast crawl never measures, which is how a comment
// shade sat below its floor through a full crawl of the app.
export const markdownProbe = [
	"# 渲染检查",
	"",
	"这是一段**加粗**、*斜体*与 `inline code` 的中文正文，后面跟一个列表：",
	"",
	"1. 第一项",
	"2. 第二项",
	"   - 嵌套要点",
	"",
	"```ts",
	"// 高亮探针：注释、数字、字符串与调用点各一处",
	'const greet = (name: string): string => `你好, ${name}`;',
	"export const retries = 3;",
	"export default greet;",
	"```",
	"",
	"```html",
	'<!-- 标签与属性 -->',
	'<button class="primary" data-id="42">发送</button>',
	"```",
	"",
	"```diff",
	"@@ -1,3 +1,3 @@",
	"-const limit = 10;",
	"+const limit = 20;",
	"```",
	"",
	"| 字段 | 说明 |",
	"| --- | --- |",
	"| id | 会话标识 |",
	"",
	"> 引用块用于提示。",
].join("\n");

async function send(page, text) {
	const composer = page.getByRole("textbox", { name: "消息" });
	await composer.click();
	await composer.fill(text);
	// `exact` matters: a transcript message's 编辑并重新发送 button also contains 发送.
	await page.getByRole("button", { name: "发送", exact: true }).click();
}

async function waitIdle(page, timeout = 30_000) {
	await page
		.getByRole("button", { name: "停止任务" })
		.waitFor({ state: "hidden", timeout })
		.catch(() => {});
}

async function waitComposerReady(page) {
	await page.locator('textarea[aria-label="消息"]:not([disabled])').waitFor({ timeout: 20_000 });
}

async function scrollTranscript(page, top) {
	await page
		.locator(".transcript")
		.evaluate((element, value) => {
			element.scrollTop = value;
		}, top)
		.catch(() => {});
}

async function newSession(page) {
	await page.getByRole("button", { name: "新建会话" }).click();
	await waitComposerReady(page);
}

/**
 * Drives the composer autocomplete with real keystrokes: the trigger is derived
 * from the caret, so `fill` alone would not reproduce what a user sees.
 */
async function composerMenus(capture) {
	const page = capture.page;
	const composer = page.getByRole("textbox", { name: "消息" });
	const firstRow = page.locator(".suggest-menu li").first();
	await composer.click();
	await composer.fill("");
	await composer.pressSequentially("@src", { delay: 40 });
	await firstRow.waitFor({ timeout: 10_000 }).catch(() => {});
	await capture.shot("mention-menu", { settle: 350 });
	// Enter must accept the highlighted row instead of submitting the prompt, and
	// accepting a directory keeps the menu open scoped to it.
	await page.keyboard.press("Enter");
	await capture.shot("mention-drilldown", { settle: 600 });
	await page.keyboard.press("Enter");
	await capture.shot("mention-accepted", { settle: 300 });

	await composer.fill("");
	await composer.pressSequentially("/", { delay: 40 });
	await firstRow.waitFor({ timeout: 10_000 }).catch(() => {});
	await capture.shot("command-menu", { settle: 350 });
	await page.keyboard.press("ArrowDown");
	await page.keyboard.press("ArrowDown");
	await capture.shot("command-menu-active", { settle: 200 });
	await page.keyboard.press("Escape");
	await composer.fill("");
}

/**
 * The shell overlays are keyboard-only surfaces, so they are driven with real
 * chords: anything that reaches them through a click would not prove the
 * bindings work.
 */
async function shellOverlays(capture) {
	const page = capture.page;
	await page.keyboard.press("Control+k");
	await page.locator(".palette-list button").first().waitFor({ timeout: 10_000 }).catch(() => {});
	await capture.shot("palette", { settle: 350 });
	await page.keyboard.type("重命名", { delay: 40 });
	await capture.shot("palette-filter", { settle: 300 });
	// A command with an argument hint must ask for the argument, not run.
	await page.keyboard.press("Enter");
	await capture.shot("palette-argument", { settle: 300 });
	await page.keyboard.press("Escape");
	await page.keyboard.press("Escape");

	await page.keyboard.press("Control+Slash");
	await page.locator(".shortcuts-dialog").waitFor({ timeout: 10_000 }).catch(() => {});
	await capture.shot("shortcuts", { settle: 300 });
	await page.keyboard.press("Escape");
}

/**
 * The per-message actions. The row is faded until its message is hovered or
 * focused and the editor replaces the body in place, so both states have to be
 * driven rather than merely rendered.
 */
async function messageActions(capture) {
	const page = capture.page;
	const row = page.locator(".message-row.user").first();
	await row.hover();
	await capture.shot("message-actions", { settle: 300 });
	await row.getByRole("button", { name: "编辑并重新发送" }).click();
	await page.locator(".message-editor textarea").waitFor({ timeout: 10_000 }).catch(() => {});
	await capture.shot("message-editor", { settle: 350 });
	await page.keyboard.press("Escape");
}

export async function desktopWalkthrough(capture) {
	const page = capture.page;
	await capture.shot("shell-empty");

	await page.getByRole("button", { name: "新建会话" }).click();
	await waitComposerReady(page);
	await capture.shot("session-new");

	await composerMenus(capture);

	await send(page, markdownProbe);
	await waitIdle(page);
	await capture.shot("chat-markdown", { settle: 800 });
	await scrollTranscript(page, 0);
	await capture.shot("chat-markdown-top", { settle: 250 });

	await messageActions(capture);

	await newSession(page);
	await send(page, "/demo-rich");
	await waitIdle(page);
	await capture.shot("tool-cards", { settle: 800 });
	await scrollTranscript(page, 0);
	await capture.shot("tool-cards-top", { settle: 250 });
	const collapsed = page.locator('.tool-card-head[aria-expanded="false"]').first();
	if ((await collapsed.count()) > 0) {
		await collapsed.click();
		await capture.shot("tool-card-expanded", { settle: 250 });
	}

	await newSession(page);
	await send(page, "/retry-once");
	await page.getByRole("status", { name: "正在自动重试" }).waitFor({ timeout: 10_000 });
	await capture.shot("automatic-retry", { settle: 100 });
	await waitIdle(page);
	await send(page, "/demo-fail");
	await waitIdle(page);
	const failureNotice = page.locator(".failure-notice").last();
	await failureNotice.waitFor({ timeout: 10_000 });
	await failureNotice.scrollIntoViewIfNeeded();
	await failureNotice.locator("details").click();
	await capture.shot("final-failure", { settle: 250 });

	await send(page, "/approval");
	const approval = page.getByRole("region", { name: "需要批准工具调用" });
	await approval.waitFor({ timeout: 20_000 }).catch(() => {});
	// The transcript pins itself to the newest message, which here is the prompt
	// that triggered the approval — the card itself lands below the fold, so a
	// shot taken now would show everything except the thing it is named after.
	await approval.scrollIntoViewIfNeeded().catch(() => {});
	await capture.shot("approval");
	await page
		.getByRole("button", { name: /批准|允许/ })
		.first()
		.click()
		.catch(() => {});
	await waitIdle(page);

	await send(page, "/long");
	await page.waitForTimeout(1200);
	await capture.shot("streaming", { settle: 0 });
	// Scrolling up mid-stream has to stick. The transcript stops chasing the tail
	// and offers a way back instead, so this shot doubles as proof that the next
	// delta does not yank the reader down again.
	await page
		.locator(".transcript")
		.evaluate((element) => {
			element.scrollTop = 0;
		})
		.catch(() => {});
	await page.waitForTimeout(900);
	await capture.shot("streaming-detached", { settle: 0 });
	await page
		.getByRole("button", { name: /回到底部/ })
		.click()
		.catch(() => {});
	await page
		.getByRole("button", { name: "停止任务" })
		.click()
		.catch(() => {});
	await waitIdle(page);

	await shellOverlays(capture);

	for (const [name, tab] of [
		["agents", "智能体"],
		["goals", "目标"],
		["files", "文件"],
		["changes", "更改"],
		["tools", "工具"],
		["skills", "技能"],
		["mcp", "MCP"],
		["terminal", "终端"],
	]) {
		const control = page.getByRole("tab", { name: tab });
		if ((await control.count()) === 0) continue;
		await control.first().click();
		await capture.shot(`tab-${name}`, { settle: 900 });
	}

	await page.getByRole("tab", { name: "对话" }).first().click();
	const settings = page.getByRole("button", { name: /设置/ }).first();
	if ((await settings.count()) > 0) {
		await settings.click().catch(() => {});
		await capture.shot("settings");
		await page.keyboard.press("Escape");
	}

	// Onboarding comes last and on purpose. The walkthrough runs with the flag
	// pre-set because the dialog's backdrop intercepts every click, so the only
	// way to see the first-run surface is to put it back and reload — after
	// everything else has been visited.
	await page.evaluate(() => localStorage.removeItem("wuming.onboarding.complete"));
	await page.reload({ waitUntil: "domcontentloaded" });
	await page.locator(".modal-backdrop").waitFor({ timeout: 20_000 }).catch(() => {});
	await capture.shot("onboarding", { settle: 600 });
}

export async function mobileWalkthrough(capture) {
	const page = capture.page;
	await capture.shot("mobile-shell");
	const openNav = page.getByRole("button", { name: "打开导航" });
	if ((await openNav.count()) > 0) {
		await openNav.first().click();
		await capture.shot("mobile-nav");
	}
	await page.getByRole("button", { name: "新建会话" }).click();
	const closeNav = page.getByRole("button", { name: "关闭导航" });
	if ((await closeNav.count()) > 0) await closeNav.first().click().catch(() => {});
	await waitComposerReady(page);
	const mobileComposer = page.getByRole("textbox", { name: "消息" });
	await mobileComposer.click();
	await mobileComposer.pressSequentially("@rea", { delay: 40 });
	await page.locator(".suggest-menu li").first().waitFor({ timeout: 10_000 }).catch(() => {});
	await capture.shot("mobile-mention", { settle: 350 });
	await page.keyboard.press("Escape");
	await mobileComposer.fill("");
	await send(page, '移动端布局检查\n\n```json\n{ "ok": true }\n```');
	await waitIdle(page);
	await capture.shot("mobile-chat", { settle: 800 });
	// Hover stands in for touch here: the action row's own media query cannot be
	// exercised without touch emulation, but its layout at 430px can.
	await page.locator(".message-row.user").first().hover();
	await capture.shot("mobile-message-actions", { settle: 300 });
	// Tool card heads pack a verb, a target, a metric and a status pill into one row,
	// which is the first thing to break at 390px — so they get a mobile shot too.
	await send(page, "/demo-rich");
	await waitIdle(page);
	await capture.shot("mobile-tool-cards", { settle: 800 });
	await scrollTranscript(page, 0);
	await capture.shot("mobile-tool-cards-top", { settle: 250 });
	await send(page, "/retry-once");
	await page.getByRole("status", { name: "正在自动重试" }).waitFor({ timeout: 10_000 });
	await capture.shot("mobile-automatic-retry", { settle: 100 });
	await waitIdle(page);
	await send(page, "/demo-fail");
	await waitIdle(page);
	const mobileFailureNotice = page.locator(".failure-notice").last();
	await mobileFailureNotice.waitFor({ timeout: 10_000 });
	await mobileFailureNotice.scrollIntoViewIfNeeded();
	await capture.shot("mobile-final-failure", { settle: 250 });
	await page.keyboard.press("Control+k");
	await page.locator(".palette-list button").first().waitFor({ timeout: 10_000 }).catch(() => {});
	await capture.shot("mobile-palette", { settle: 350 });
	await page.keyboard.press("Escape");
	const agents = page.getByRole("tab", { name: "智能体" });
	if ((await agents.count()) > 0) {
		await agents.first().click();
		await capture.shot("mobile-agents", { settle: 900 });
	}
}
