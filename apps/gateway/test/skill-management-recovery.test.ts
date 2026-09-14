import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SkillManager } from "../src/skill-manager.js";

vi.mock("node:fs/promises", async (original) => {
	const fs = await original<typeof import("node:fs/promises")>();
	return { ...fs, rename: vi.fn(fs.rename) };
});

const roots: string[] = [];
afterEach(async () => {
	vi.mocked(rename).mockRestore();
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "wuming-skill-recovery-"));
	roots.push(root);
	const source = join(root, "package");
	await mkdir(source);
	await writeFile(
		join(source, "SKILL.md"),
		"---\nname: Demo\ndescription: Recovery fixture\n---\nInspect before acting."
	);
	return { root, source, manager: new SkillManager(root, join(root, "builtins")) };
}

describe("skill publication recovery", () => {
	it("removes staging and restores metadata when publication fails", async () => {
		const { root, source, manager } = await fixture();
		await manager.install(source, { id: "existing" });
		const path = join(root, ".wuming", "skills.json");
		const before = await readFile(path, "utf8");
		const original = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
		vi.mocked(rename).mockImplementation(async (from, to) => {
			if (String(to) === join(root, ".wuming", "skills", "broken")) throw new Error("simulated publication failure");
			return original.rename(from, to);
		});
		await expect(manager.install(source, { id: "broken" })).rejects.toThrow("simulated publication failure");
		expect(await readFile(path, "utf8")).toBe(before);
		expect(await readdir(join(root, ".wuming", "skills"))).toEqual(["existing"]);
		expect(
			(await readdir(join(root, ".wuming"))).some((name) => name.startsWith(".skill-") || name === "skills.lock")
		).toBe(false);
	});

	it("restores the package when uninstall state persistence fails", async () => {
		const { root, source, manager } = await fixture();
		await manager.install(source, { id: "existing" });
		const path = join(root, ".wuming", "skills.json");
		const before = await readFile(path, "utf8");
		const original = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
		vi.mocked(rename).mockImplementation(async (from, to) => {
			if (String(to) === path) throw new Error("simulated persistence failure");
			return original.rename(from, to);
		});
		await expect(manager.uninstall("existing")).rejects.toThrow("simulated persistence failure");
		expect(await readFile(path, "utf8")).toBe(before);
		expect((await manager.get("workspace", "existing")).content).toContain("Inspect before acting");
		expect(
			(await readdir(join(root, ".wuming"))).some((name) => name.startsWith(".skill-") || name === "skills.lock")
		).toBe(false);
	});
});
