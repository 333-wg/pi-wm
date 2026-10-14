import { expect, test } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { openApp, startWebApp, stopWebApp } from "./harness.js";

const source =
	'import { expect, test } from "@playwright/test";\n\n// 文件预览：关键字、字符串、函数、数字\nconst retries: number = 3;\ntest("preview stays readable", async () => {\n\texpect(retries).toBe(3);\n});\n' +
	"// long line " +
	"content ".repeat(90) +
	"\n" +
	"// more lines\n".repeat(70);
let url: string;
test.beforeAll(async () => {
	url = await startWebApp({}, async (workspace) => {
		await writeFile(join(workspace, "preview.ts"), source);
		await writeFile(join(workspace, "notes.txt"), '<script>alert("not executable")</script>\n原样显示');
		await writeFile(join(workspace, "binary.bin"), Buffer.from([0, 1, 2, 3]));
		await writeFile(join(workspace, "empty.txt"), "");
	});
});
test.afterAll(stopWebApp);

test("file preview font size changes, persists and handles unavailable storage", async ({ page }) => {
	await openApp(page, url);
	await page.getByRole("tab", { name: "文件", exact: true }).click();
	const panel = page.getByRole("region", { name: "工作区文件" });
	await panel.getByRole("button", { name: "preview.ts", exact: true }).click();
	const size = panel.getByRole("combobox", { name: "文件预览字号" });
	const code = panel.locator(".code-block-file code");
	await expect(size).toHaveValue("12.5");
	await expect(code).toHaveCSS("font-size", "12.5px");
	await size.selectOption("24");
	await expect(code).toHaveCSS("font-size", "24px");
	await expect(panel.locator(".code-line-number").first()).toHaveCSS("font-size", "24px");
	await size.selectOption("10");
	await expect(code).toHaveCSS("font-size", "10px");
	await size.selectOption("18");
	await panel.getByRole("button", { name: "notes.txt", exact: true }).click();
	await expect(size).toHaveValue("18");
	await expect(code).toHaveCSS("font-size", "18px");
	await page.reload();
	await expect(page.locator(".connection")).toHaveClass(/connected/);
	await page.getByRole("tab", { name: "文件", exact: true }).click();
	await panel.getByRole("button", { name: "preview.ts", exact: true }).click();
	await expect(size).toHaveValue("18");
	await expect(code).toHaveCSS("font-size", "18px");
	await page.evaluate(() => localStorage.setItem("wuming.filePreview.fontSize", "9999"));
	await panel.getByRole("button", { name: "notes.txt", exact: true }).click();
	await expect(size).toHaveValue("12.5");
	await page.evaluate(() => {
		const original = Storage.prototype.setItem;
		Storage.prototype.setItem = function (key, value) {
			if (key === "wuming.filePreview.fontSize") throw new Error("Storage unavailable");
			return original.call(this, key, value);
		};
	});
	await size.selectOption("20");
	await expect(code).toHaveCSS("font-size", "20px");
	await expect(panel.getByRole("status")).toContainText("无法保存");
});

test("file preview highlights code, preserves text and remains readable across themes", async ({
	page,
	context,
}, testInfo) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.setViewportSize({ width: 1440, height: 900 });
	await context.grantPermissions(["clipboard-read", "clipboard-write"]);
	await openApp(page, url);
	await page.getByRole("tab", { name: "文件", exact: true }).click();
	const panel = page.getByRole("region", { name: "工作区文件" });
	await panel.getByRole("button", { name: "preview.ts", exact: true }).click();
	const code = panel.locator(".code-block-file");
	await expect(code).toHaveAttribute("data-language", "ts");
	await expect(code.locator(".tok-keyword").first()).toHaveText("import");
	await expect(code.locator(".tok-string").first()).toHaveText('"@playwright/test"');
	await expect(code.locator(".code-line-number").first()).toHaveAttribute("data-line", "1");
	expect(await code.locator("code").textContent()).toBe(source);
	await code.getByRole("button", { name: "复制代码" }).click();
	await expect(code.getByText("已复制", { exact: true })).toBeVisible();
	// Windows' native clipboard normalizes LF to CRLF; the DOM assertion above
	// separately checks the exact source bytes before that OS conversion.
	expect((await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, "\n")).toBe(source);
	for (const theme of ["light", "dark"]) {
		if ((await page.locator("html").getAttribute("data-theme")) !== theme) {
			await page.getByRole("button", { name: "切换深浅主题" }).click();
		}
		await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
		const colors = await code.evaluate((element) =>
			["code", ".tok-keyword", ".tok-string", ".tok-number", ".tok-comment"].map(
				(selector) => getComputedStyle(element.querySelector(selector)!).color
			)
		);
		expect(new Set(colors).size).toBe(5);
		await page.screenshot({ path: testInfo.outputPath(`file-preview-${theme}.png`) });
	}
	const pre = code.locator("pre");
	expect(
		await pre.evaluate(
			(element) => element.scrollHeight > element.clientHeight && element.scrollWidth > element.clientWidth
		)
	).toBe(true);
	await pre.evaluate((element) => {
		element.scrollLeft = 250;
		element.scrollTop = 100;
	});
	const gutter = await code.locator(".code-line-number").nth(10).boundingBox();
	const viewport = await pre.boundingBox();
	expect(gutter!.x).toBeCloseTo(viewport!.x, 0);
	await panel.getByRole("button", { name: "notes.txt", exact: true }).click();
	await expect(code).toHaveAttribute("data-language", "text");
	await expect(code.locator(".tok")).toHaveCount(0);
	expect(await code.locator("code").textContent()).toBe('<script>alert("not executable")</script>\n原样显示');
	await expect(code.locator("script")).toHaveCount(0);
	await panel.getByRole("button", { name: "empty.txt", exact: true }).click();
	await expect(code.locator(".code-line-number")).toHaveCount(1);
	await panel.getByRole("button", { name: "binary.bin", exact: true }).click();
	await expect(panel.getByText("暂不支持预览二进制文件")).toBeVisible();
	await expect(code).toHaveCount(0);
	await page.route("**/file?**", (route) =>
		route.fulfill({
			json: {
				path: "preview.ts",
				content: "const partial = 1;",
				binary: false,
				truncated: true,
				bytesRead: 18,
				totalBytes: 999,
			},
		})
	);
	await panel.getByRole("button", { name: "preview.ts", exact: true }).click();
	await expect(panel.getByText("预览已限制为 18 字节")).toBeVisible();
	await expect(code.locator(".tok-keyword")).toHaveText("const");
	expect(errors).toEqual([]);
});
