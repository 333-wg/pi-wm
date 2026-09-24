import { expect, test } from "@playwright/test";
import { openApp, startWebApp, stopWebApp, token } from "./harness.js";

let webUrl: string;
const names = ["排序测试甲", "排序测试乙", "视频制作"];
test.beforeAll(async () => {
	webUrl = await startWebApp();
	for (const name of names) {
		const headers = { Authorization: `Bearer ${token}` };
		const created = await fetch(new URL("/api/projects", webUrl), {
			method: "POST",
			headers: { ...headers, "Content-Type": "application/json" },
			body: JSON.stringify({ name }),
		});
		expect(created.ok).toBe(true);
		const { project } = (await created.json()) as { project: { id: string } };
		const uploaded = await fetch(new URL(`/api/projects/${project.id}/files`, webUrl), {
			method: "PUT",
			headers: { ...headers, "Content-Type": "text/plain", "X-Wuming-Project-Path": "readme.md" },
			body: "# Project order test",
		});
		expect(uploaded.ok).toBe(true);
		const completed = await fetch(new URL(`/api/projects/${project.id}/complete`, webUrl), { method: "POST", headers });
		expect(completed.ok).toBe(true);
	}
});
test.afterAll(stopWebApp);

for (const width of [1440, 390]) {
	test.describe(`viewport ${width}`, () => {
		test.use({ hasTouch: width === 390, isMobile: width === 390 });
		test(`reorders projects and retains selection and saved order at ${width}px`, async ({ page }, testInfo) => {
			await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
			await openApp(page, webUrl);
			if (width === 390) await page.getByRole("button", { name: "打开导航", exact: true }).click();
			const rows = page.locator(".project-row");
			const initial = await rows.allTextContents();
			expect(initial).toHaveLength(3);
			const [first, middle, last] = initial as [string, string, string];
			const row = (name: string) => rows.filter({ hasText: name });
			const menu = async (name: string) => {
				if (width === 1440) await row(name).hover();
				await page.getByRole("button", { name: `${name} 项目菜单`, exact: true }).click();
			};
			await row(last).click();
			await expect(row(last)).toHaveClass(/selected/);
			await menu(first);
			await expect(page.getByRole("menuitem", { name: "上移项目", exact: true })).toBeDisabled();
			await page.getByRole("button", { name: `${first} 项目菜单`, exact: true }).click();
			await menu(last);
			await expect(page.getByRole("menuitem", { name: "下移项目", exact: true })).toBeDisabled();
			await page.getByRole("menuitem", { name: "上移项目", exact: true }).click();
			await expect(rows).toHaveText([first, last, middle]);
			await expect(row(last)).toHaveClass(/selected/);
			await menu(last);
			await page.getByRole("menuitem", { name: "下移项目", exact: true }).click();
			await expect(rows).toHaveText(initial);
			if (width === 1440) {
				await row(last).dragTo(row(first));
				await expect(rows).toHaveText([last, first, middle]);
				await row(last).dragTo(row(middle));
				await expect(rows).toHaveText(initial);
				await row(last).dragTo(row(first));
			} else {
				await menu(last);
				await page.getByRole("menuitem", { name: "上移项目", exact: true }).click();
				await menu(last);
				await page.getByRole("menuitem", { name: "上移项目", exact: true }).click();
			}
			await expect(rows).toHaveText([last, first, middle]);
			await expect(row(last)).toHaveClass(/selected/);
			await expect(row(last)).toHaveAttribute("aria-expanded", "true");
			await page.reload();
			await expect(page.locator(".connection")).toHaveClass(/connected/);
			if (width === 390) await page.getByRole("button", { name: "打开导航", exact: true }).click();
			await expect(rows).toHaveText([last, first, middle]);
			await expect(row(last)).toHaveClass(/selected/);
			await menu(last);
			await expect(page.getByRole("menuitem", { name: "上移项目", exact: true })).toBeDisabled();
			await page.screenshot({ path: testInfo.outputPath(`project-order-${width}.png`) });
			expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
		});
	});
}

test("rejects external drag and reports persistence failure without losing the reordered view", async ({ page }) => {
	await openApp(page, webUrl);
	const rows = page.locator(".project-row");
	const initial = await rows.allTextContents();
	const dataTransfer = await page.evaluateHandle(() => {
		const data = new DataTransfer();
		data.setData("application/x-wuming-project", "external-project");
		return data;
	});
	await rows.first().dispatchEvent("drop", { dataTransfer });
	await expect(rows).toHaveText(initial);
	await page.evaluate(() => {
		const original = Storage.prototype.setItem;
		Storage.prototype.setItem = function (key, value) {
			if (key === "wuming.projectOrder") throw new DOMException("Quota exceeded", "QuotaExceededError");
			return original.call(this, key, value);
		};
	});
	await rows.last().hover();
	await page.getByRole("button", { name: `${initial[2]} 项目菜单`, exact: true }).click();
	await page.getByRole("menuitem", { name: "上移项目", exact: true }).click();
	await expect(rows).toHaveText([initial[0]!, initial[2]!, initial[1]!]);
	await expect(page.getByRole("alert")).toContainText("无法保存");
});
