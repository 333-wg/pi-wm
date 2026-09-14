import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { SkillManager } from "../src/skill-manager.js";

describe("SkillManager", () => {
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
