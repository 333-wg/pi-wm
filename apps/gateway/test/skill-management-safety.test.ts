import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { SkillManager } from "../src/skill-manager.js";
import { ManagedSkillCatalog } from "../src/managed-skill-catalog.js";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const body = "---\nname: Example\ndescription: A bounded test skill\n---\nInspect evidence before acting.";
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "wuming-skill-safe-"));
	roots.push(root);
	const source = join(root, "package");
	const builtins = join(root, "builtins");
	await mkdir(source);
	await mkdir(builtins);
	await writeFile(join(source, "SKILL.md"), body);
	return { root, source, builtins, manager: new SkillManager(root, builtins) };
}

describe("safe skill management", () => {
	it("refuses collisions and preserves the original package and metadata", async () => {
		const { root, source, manager } = await fixture();
		await manager.install(source, { id: "example" });
		const state = await readFile(join(root, ".wuming", "skills.json"), "utf8");
		await writeFile(join(source, "SKILL.md"), body + " changed");
		await expect(manager.install(source, { id: "example" })).rejects.toMatchObject({
			protocolCode: "conflict",
		});
		expect(await readFile(join(root, ".wuming", "skills", "example", "SKILL.md"), "utf8")).toBe(body);
		expect(await readFile(join(root, ".wuming", "skills.json"), "utf8")).toBe(state);
	});

	it("enforces disabled state for runtime loads and preserves it across instances", async () => {
		const { root, source, builtins, manager } = await fixture();
		await manager.install(source, { id: "example" });
		await manager.setEnabled("example", false);
		const catalog = new ManagedSkillCatalog(builtins);
		expect(await catalog.list("workspace", root)).toEqual([]);
		await expect(catalog.get("workspace", root, "example")).rejects.toMatchObject({
			protocolCode: "forbidden",
		});
		expect((await new SkillManager(root, builtins).get("workspace", "example", true)).content).toContain(
			"Inspect evidence"
		);
		await catalog.manager(root).setEnabled("example", true);
		expect((await catalog.get("workspace", root, "example")).workspaceId).toBe("workspace");
	});

	it("discovers, disables and protects builtin skills without prior state", async () => {
		const { builtins, manager, source } = await fixture();
		await mkdir(join(builtins, "example"));
		await writeFile(join(builtins, "example", "SKILL.md"), body);
		expect(await manager.list()).toMatchObject([{ id: "example", source: "builtin", enabled: true }]);
		await manager.setEnabled("example", false);
		expect(await manager.listEnabled("workspace")).toEqual([]);
		await expect(manager.uninstall("example")).rejects.toMatchObject({ protocolCode: "forbidden" });
		await expect(manager.install(source, { id: "example" })).rejects.toMatchObject({
			protocolCode: "conflict",
		});
		expect(await readFile(join(builtins, "example", "SKILL.md"), "utf8")).toBe(body);
	});

	it("discovers manually placed skills and exposes user precedence without altering builtin files", async () => {
		const { root, builtins, manager } = await fixture();
		await mkdir(join(builtins, "example"));
		await writeFile(join(builtins, "example", "SKILL.md"), body);
		await mkdir(join(root, ".wuming", "skills", "example"), { recursive: true });
		await writeFile(join(root, ".wuming", "skills", "example", "SKILL.md"), body + " user");
		expect(await manager.list()).toMatchObject([{ id: "example", source: "user" }]);
		await manager.uninstall("example");
		expect(await manager.list()).toMatchObject([{ id: "example", source: "builtin" }]);
	});

	for (const id of ["../outside", "nested/name", "CON", "NUL.txt", "trailing.", "__proto__"]) {
		it(`rejects unsafe ID ${id} on every mutation`, async () => {
			const { source, manager } = await fixture();
			await expect(manager.install(source, { id })).rejects.toMatchObject({
				protocolCode: "invalid_request",
			});
			await expect(manager.setEnabled(id, false)).rejects.toMatchObject({
				protocolCode: "invalid_request",
			});
			await expect(manager.uninstall(id)).rejects.toMatchObject({
				protocolCode: "invalid_request",
			});
		});
	}

	for (const state of ["{", "null", '{"skills":[]}', '{"skills":{"x":{"id":"../escape"}}}']) {
		it(`fails closed on corrupt state ${state}`, async () => {
			const { root, source, manager } = await fixture();
			await mkdir(join(root, ".wuming"));
			await writeFile(join(root, ".wuming", "skills.json"), state);
			await expect(manager.list()).rejects.toMatchObject({ protocolCode: "conflict" });
			await expect(manager.install(source, { id: "example" })).rejects.toMatchObject({
				protocolCode: "conflict",
			});
			expect(await readFile(join(root, ".wuming", "skills.json"), "utf8")).toBe(state);
		});
	}

	it("rejects links in packages and managed storage", async () => {
		const { root, source, manager } = await fixture();
		const outside = join(root, "outside");
		await mkdir(outside);
		await writeFile(join(outside, "keep.txt"), "keep");
		await symlink(outside, join(source, "references"), "junction");
		await expect(manager.install(source, { id: "example" })).rejects.toMatchObject({
			protocolCode: "forbidden",
		});
		await symlink(outside, join(root, ".wuming"), "junction");
		await expect(manager.setEnabled("example", false)).rejects.toMatchObject({
			protocolCode: "forbidden",
		});
		expect(await readdir(outside)).toEqual(["keep.txt"]);
	});

	for (const raw of [
		"plain body",
		"---\nname: [invalid]\n---\nbody",
		"---\nname: empty\n---\n",
		"---\ndescription: Missing name\n---\nBody",
		"---\nname: Missing description\n---\nBody",
		"x".repeat(200 * 1024 + 1),
	]) {
		it(`rejects invalid package before publishing (${raw.length} bytes)`, async () => {
			const { root, source, manager } = await fixture();
			await writeFile(join(source, "SKILL.md"), raw);
			await expect(manager.install(source, { id: "example" })).rejects.toMatchObject({
				protocolCode: "invalid_request",
			});
			expect(await readdir(root)).not.toContain(".wuming");
		});
	}

	it("fails on a held management lock instead of racing or removing it", async () => {
		const { root, source, manager } = await fixture();
		await mkdir(join(root, ".wuming", "skills.lock"), { recursive: true });
		await expect(manager.install(source, { id: "example" })).rejects.toMatchObject({
			protocolCode: "conflict",
		});
		expect(await readdir(join(root, ".wuming"))).toEqual(["skills.lock"]);
	});

	it("ships loadable skills to an empty workspace", async () => {
		const { root } = await fixture();
		const catalog = new ManagedSkillCatalog();
		const skills = await catalog.list("fresh", root);
		expect(skills.map((skill) => skill.id)).toEqual(
			expect.arrayContaining([
				"debug",
				"research",
				"run-app",
				"verify-app",
				"code-review",
				"code-change",
				"skill-authoring",
			])
		);
		for (const summary of skills) {
			const skill = await catalog.get("fresh", root, summary.id);
			expect(skill.truncated).toBe(false);
			expect(skill.content.length).toBeGreaterThan(500);
		}
	});
});
