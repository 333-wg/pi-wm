import { _electron as electron, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { DirectoryAttachments } from "../apps/gateway/dist/directory-attachments.js";

const root = process.cwd();
const temporary = await mkdtemp(join(tmpdir(), "wuming-attachments-"));
const output = join(root, "test-results", "desktop-attachments");
await mkdir(output, { recursive: true });
const folder = join(temporary, "wuming-website");
await mkdir(join(folder, "sub"), { recursive: true });
await mkdir(join(folder, "empty"));
await Promise.all(Array.from({ length: 2100 }, (_, i) => writeFile(join(folder, `proof-${i}.txt`), `proof ${i}`)));
await writeFile(join(folder, "sub", "内容.txt"), "folder content 中文");
const file = join(temporary, "附件.txt");
await writeFile(file, "附件上传回归\n");
const binary = join(temporary, "二进制附件.bin");
await writeFile(binary, Buffer.from([0, 1, 2, 127, 128, 255]));
const env = { ...process.env, WUMING_DESKTOP_NODE: process.execPath, WUMING_DESKTOP_TEST_RUNTIME: "demo" };
delete env.ELECTRON_RUN_AS_NODE;
let desktop;
try {
	desktop = await electron.launch({
		executablePath: createRequire(import.meta.url)("electron"),
		args: [join(root, "apps", "desktop"), `--user-data-dir=${join(temporary, "profile")}`],
		env,
		timeout: 60000,
	});
	const page = await desktop.firstWindow();
	page.setDefaultTimeout(15000);
	const errors = [];
	page.on("pageerror", (error) => errors.push(error.message));
	page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
	page.on("response", (response) => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
	await page.getByLabel("访问密码", { exact: true }).fill("wuming");
	await page.getByRole("button", { name: "开启工作空间", exact: true }).click();
	await expect(page.locator(".connection")).toHaveClass(/connected/);
	await page.evaluate(() => localStorage.setItem("wuming.onboarding.complete", "true"));
	await page.reload();
	await expect(page.locator(".connection")).toHaveClass(/connected/);
	await page.setViewportSize({ width: 1440, height: 900 });
	await expect(page.getByRole("button", { name: "引用本机文件夹（只读，不打包）", exact: true })).toHaveCount(0);
	const cdp = await page.context().newCDPSession(page);
	async function drop(paths) {
		const box = await page.locator(".composer textarea").boundingBox();
		assert.ok(box);
		const data = { items: [], files: paths, dragOperationsMask: 1 };
		for (const type of ["dragEnter", "dragOver", "drop"])
			await cdp.send("Input.dispatchDragEvent", { type, x: box.x + 30, y: box.y + 20, data });
	}
	// Custom-protocol response bodies are not reliably retained by Chromium's inspector.
	await page.evaluate(() => {
		window.attachmentProof = [];
		const original = window.fetch.bind(window);
		window.fetch = async (...args) => {
			const response = await original(...args);
			if (/\/(artifacts|directory-attachments)$/.test(String(args[0])) && response.status === 201)
				window.attachmentProof.push((await response.clone().json()).artifact);
			return response;
		};
	});
	async function verifyBytes(artifact, path) {
		const bytes = await page.evaluate(async (id) => {
			const response = await fetch(`/api/artifacts/${id}`);
			if (!response.ok) throw new Error(`Download failed: ${response.status}`);
			return Array.from(new Uint8Array(await response.arrayBuffer()));
		}, artifact.id);
		assert.deepEqual(Buffer.from(bytes), await readFile(path));
	}
	const chooser = page.waitForEvent("filechooser");
	await page.getByRole("button", { name: "添加附件", exact: true }).click();
	await (await chooser).setFiles([file, binary]);
	await expect(page.locator(".attachment-chip")).toHaveCount(2);
	await expect.poll(() => page.evaluate(() => window.attachmentProof.length)).toBe(2);
	const selected = await page.evaluate(() => window.attachmentProof);
	await verifyBytes(selected.find(item => item.name === "附件.txt"), file);
	await verifyBytes(selected.find(item => item.name === "二进制附件.bin"), binary);
	await page.locator(".attachment-remove").first().click();
	await page.locator(".attachment-remove").first().click();
	await expect(page.locator(".attachment-chip")).toHaveCount(0);
	console.log("PASS attachment button opens file chooser; multiple local text/binary files upload byte-for-byte");
	await drop([file, binary]);
	await expect(page.locator(".attachment-chip")).toHaveCount(2);
	await expect.poll(() => page.evaluate(() => window.attachmentProof.length)).toBe(4);
	const dropped = await page.evaluate(() => window.attachmentProof.slice(2));
	await verifyBytes(dropped.find(item => item.name === "附件.txt"), file);
	await verifyBytes(dropped.find(item => item.name === "二进制附件.bin"), binary);
	await page.screenshot({ path: join(output, "file-drop.png") });
	await page.getByRole("button", { name: "发送", exact: true }).click();
	await expect(page.locator(".attachment-chip")).toHaveCount(0);
	await expect(page.locator(".transcript")).toContainText("附件.txt");
	await expect(page.locator(".transcript")).toContainText("二进制附件.bin");
	await expect(page.getByRole("button", { name: "停止任务", exact: true })).toHaveCount(0);
	assert.equal(await readFile(file, "utf8"), "附件上传回归\n");
	console.log("PASS native file drops, exact stored bytes, send to conversation, source files unchanged");
	for (const size of [{ width: 1440, height: 900 }]) {
		await page.setViewportSize(size);
		const before = await page.evaluate(() => window.attachmentProof.length);
		await drop([folder]);
		await expect.poll(() => page.evaluate(() => window.attachmentProof.length)).toBe(before + 1);
		await expect(page.locator(".attachment-error")).toHaveCount(0);
		await expect(page.locator(".attachment-directory").getByText("wuming-website", { exact: true }).first()).toBeVisible();
		const bytes = await page.evaluate(
			async (id) => Array.from(new Uint8Array(await (await fetch(`/api/artifacts/${id}`)).arrayBuffer())),
			await page.evaluate(() => window.attachmentProof.at(-1).id)
		);
		const reference = JSON.parse(Buffer.from(bytes).toString("utf8"));
		assert.equal(reference.type, "local_directory_reference");
		assert.ok(bytes.length < 2048, "Only a small reference, not 2100 files, should be uploaded");
		const grants = new DirectoryAttachments(join(temporary, "profile", "data", "directory-attachments"));
		// The exact model tool reads from the persisted reference created through real drag-and-drop.
		const grantFiles = await (await import("node:fs/promises")).readFile(join(temporary, "profile", "data", "directory-attachments", `${reference.id}.json`), "utf8");
		const result = await grants.tools(JSON.parse(grantFiles).workspaceId)[0].execute("proof", { directoryId: reference.id, action: "read", path: "proof-2099.txt" });
		assert.ok(result.content[0].text.includes("proof 2099"));
		await page.screenshot({ path: join(output, `directory-${size.width}.png`) });
		assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
	}
	await drop([folder, file]);
	await expect(page.locator(".attachment-chip")).toHaveCount(3);
	await expect(page.locator(".attachment-error")).toHaveCount(0);
	await page.locator(".attachment-remove").first().click();
	await expect(page.locator(".attachment-chip")).toHaveCount(2);
	await page.screenshot({ path: join(output, "mixed-drop.png") });
	console.log(
		"PASS 2100-file native directory references, actual model-tool reads, mixed drops and removal in Electron"
	);
	assert.deepEqual(errors, []);
} finally {
	await desktop?.close();
	await rm(temporary, { recursive: true, force: true });
}
