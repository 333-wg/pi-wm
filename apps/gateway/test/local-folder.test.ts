import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openLocalFolder } from "../src/local-folder.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
vi.mock("node:fs/promises", () => ({ realpath: vi.fn(), stat: vi.fn() }));
afterEach(() => vi.resetAllMocks());

describe("openLocalFolder", () => {
	it("launches a visible file manager with the canonical directory as one argument without a shell", async () => {
		const directory = "D:\\project files\\中文 & notes";
		vi.mocked(realpath).mockResolvedValue(directory);
		vi.mocked(stat).mockResolvedValue({ isDirectory: () => true } as Awaited<ReturnType<typeof stat>>);
		const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
		vi.mocked(spawn).mockImplementation(() => {
			queueMicrotask(() => child.emit("spawn"));
			return child as unknown as ReturnType<typeof spawn>;
		});
		await openLocalFolder("registered-path");
		expect(realpath).toHaveBeenCalledWith("registered-path");
		expect(spawn).toHaveBeenCalledWith(
			process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open",
			[directory],
			{ detached: true, stdio: "ignore", windowsHide: false }
		);
		expect(child.unref).toHaveBeenCalledOnce();
	});

	it("rejects missing directories without launching anything", async () => {
		vi.mocked(realpath).mockRejectedValue(new Error("ENOENT"));
		await expect(openLocalFolder("missing")).rejects.toMatchObject({ httpStatus: 404 });
		expect(spawn).not.toHaveBeenCalled();
	});

	it("rejects files rather than opening them", async () => {
		vi.mocked(realpath).mockResolvedValue("file.txt");
		vi.mocked(stat).mockResolvedValue({ isDirectory: () => false } as Awaited<ReturnType<typeof stat>>);
		await expect(openLocalFolder("file.txt")).rejects.toMatchObject({ httpStatus: 404 });
		expect(spawn).not.toHaveBeenCalled();
	});

	it("reports file manager launch failures", async () => {
		vi.mocked(realpath).mockResolvedValue("directory");
		vi.mocked(stat).mockResolvedValue({ isDirectory: () => true } as Awaited<ReturnType<typeof stat>>);
		vi.mocked(spawn).mockImplementation(() => {
			const child = new EventEmitter();
			queueMicrotask(() => child.emit("error", new Error("ENOENT")));
			return child as ReturnType<typeof spawn>;
		});
		await expect(openLocalFolder("directory")).rejects.toMatchObject({ httpStatus: 503 });
	});
});
