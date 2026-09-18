import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { SkillManager } from "../src/skill-manager.js";
import { ManagedSkillCatalog } from "../src/managed-skill-catalog.js";

describe("SkillManager", () => {
	it("discovers and loads the built-in team skill with explicit-request boundaries", async () => {
		const root = await mkdtemp(join(tmpdir(), "wuming-team-skill-"));
		try {
			const catalog = new ManagedSkillCatalog();
			expect(await catalog.list("workspace", root)).toContainEqual(
				expect.objectContaining({ id: "team", name: "team" })
			);
			const skill = await catalog.get("workspace", root, "team");
			expect(skill.content).toContain("TeamCreate");
			expect(skill.content).toContain("explicit user request");
			expect(skill.content).toContain("does not\nauthorize a team");
			expect(skill.content).toContain("current project directory");
			await catalog.manager(root).setEnabled("team", false);
			expect((await catalog.list("workspace", root)).some((value) => value.id === "team")).toBe(false);
			await expect(catalog.get("workspace", root, "team")).rejects.toThrow("disabled");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
	it("gates the managed computer skill live without a second independent toggle", async () => {
		const root = await mkdtemp(join(tmpdir(), "wuming-computer-skill-"));
		try {
			const builtins = join(root, "builtins");
			await mkdir(join(builtins, "computer-use"), { recursive: true });
			await writeFile(
				join(builtins, "computer-use", "SKILL.md"),
				"---\nname: computer-use\ndescription: Operate the desktop\n---\nObserve before acting."
			);
			let enabled = false;
			const manager = new SkillManager(root, builtins, {
				managedEnabled: (id) => (id === "computer-use" ? enabled : undefined),
			});
			expect(await manager.listEnabled("workspace-1")).toEqual([]);
			await expect(manager.get("workspace-1", "computer-use")).rejects.toThrow("disabled");
			await expect(manager.setEnabled("computer-use", true)).rejects.toThrow("Settings");
			enabled = true;
			expect((await manager.listEnabled("workspace-1")).map((skill) => skill.id)).toEqual(["computer-use"]);
			expect((await manager.get("workspace-1", "computer-use")).content).toContain("Observe");
			enabled = false;
			await expect(manager.get("workspace-1", "computer-use")).rejects.toThrow("disabled");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
	it("installs, disables and uninstalls a user skill", async () => {
		const root = await mkdtemp(join(tmpdir(), "wuming-manager-"));
		const source = await mkdtemp(join(tmpdir(), "wuming-package-"));
		try {
			await mkdir(join(source, "references"));
			await writeFile(join(source, "SKILL.md"), "---\nname: Demo\ndescription: Demo skill\n---\nUse it.");
			const manager = new SkillManager(root, join(root, "builtins"));
			const installed = await manager.install(source, { id: "demo", version: "2.0.0" });
			expect(installed.source).toBe("user");
			expect((await manager.setEnabled("demo", false)).enabled).toBe(false);
			await manager.uninstall("demo");
			expect((await manager.list()).find((item) => item.id === "demo")).toBeUndefined();
		} finally {
			await rm(root, { recursive: true, force: true });
			await rm(source, { recursive: true, force: true });
		}
	});

	it("does not expose or mutate user skills when the host is not local", async () => {
		const root = await mkdtemp(join(tmpdir(), "wuming-manager-server-"));
		const source = await mkdtemp(join(tmpdir(), "wuming-package-server-"));
		try {
			await writeFile(
				join(source, "SKILL.md"),
				"---\nname: Private\ndescription: User-owned local skill\n---\nKeep this local."
			);
			const local = new SkillManager(root, join(root, "builtins"));
			await local.install(source, { id: "private" });

			const server = new SkillManager(root, join(root, "builtins"), {
				userSkillsEnabled: false,
			});
			expect((await server.list()).some((skill) => skill.id === "private")).toBe(false);
			await expect(server.install(source, { id: "another" })).rejects.toMatchObject({
				protocolCode: "forbidden",
			});
			await expect(server.setEnabled("private", false)).rejects.toMatchObject({
				protocolCode: "forbidden",
			});
			await expect(server.uninstall("private")).rejects.toMatchObject({
				protocolCode: "forbidden",
			});
		} finally {
			await rm(root, { recursive: true, force: true });
			await rm(source, { recursive: true, force: true });
		}
	});
});
