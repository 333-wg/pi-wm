import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SkillManager } from "../src/skill-manager.js";
import { ManagedSkillCatalog } from "../src/managed-skill-catalog.js";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const body = "---\nname: Shared\ndescription: Shared workflow\n---\nGlobal instructions.";
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "wuming-global-skills-"));
	roots.push(root);
	const home = join(root, "home"),
		a = join(root, "a"),
		b = join(root, "b"),
		builtins = join(root, "builtins");
	await mkdir(join(a, "package", "references"), { recursive: true });
	await writeFile(join(a, "package", "SKILL.md"), body);
	await writeFile(join(a, "package", "references", "guide.md"), "Shared reference");
	const catalog = new ManagedSkillCatalog(builtins, true, undefined, home);
	return { root, home, a, b, builtins, catalog, first: catalog.manager(a), second: catalog.manager(b) };
}

describe("user-global skills", () => {
	it("defaults installation to global, loads from another project, and persists live enable state across restart", async () => {
		const { first, second, home, a, b, builtins } = await fixture();
		expect(await first.installFromWorkspace("package", { id: "shared" })).toMatchObject({ scope: "global" });
		await expect(readFile(join(a, ".wuming", "skills", "shared", "SKILL.md"))).rejects.toMatchObject({
			code: "ENOENT",
		});
		expect(await second.listEnabled("b")).toMatchObject([{ id: "shared", scope: "global", workspaceId: "b" }]);
		expect(await second.get("b", "shared")).toMatchObject({ content: "Global instructions.", scope: "global" });
		expect(await second.readResource("b", "shared", "references/guide.md")).toBe("Shared reference");
		await second.setEnabled("shared", false, "global");
		expect(await first.listEnabled("a")).toEqual([]);
		await expect(first.get("a", "shared")).rejects.toMatchObject({ protocolCode: "forbidden" });
		const restarted = new ManagedSkillCatalog(builtins, true, undefined, home).manager(b);
		expect(await restarted.list()).toMatchObject([{ enabled: false, scope: "global" }]);
		expect((await restarted.get("b", "shared", true)).content).toBe("Global instructions.");
		await restarted.setEnabled("shared", true, "global");
		await expect(first.installFromWorkspace("package", { id: "shared", scope: "global" })).rejects.toMatchObject({
			protocolCode: "conflict",
		});
		expect(await readFile(join(home, ".wuming", "skills", "shared", "SKILL.md"), "utf8")).toBe(body);
		await restarted.uninstall("shared", "global");
		expect(await first.list()).toEqual([]);
	});
	it("keeps an explicitly requested project installation out of global storage and other projects", async () => {
		const { first, second, a, home } = await fixture();
		await first.installFromWorkspace("package", { id: "project-only", scope: "workspace" });
		expect(await first.get("a", "project-only")).toMatchObject({ scope: "workspace" });
		expect(await readFile(join(a, ".wuming", "skills", "project-only", "SKILL.md"), "utf8")).toBe(body);
		expect(await second.listEnabled("b")).toEqual([]);
		await expect(readFile(join(home, ".wuming", "skills", "project-only", "SKILL.md"))).rejects.toMatchObject({
			code: "ENOENT",
		});
	});
	it("preserves project precedence and does not fall back when the project copy is disabled", async () => {
		const { first, second, a } = await fixture();
		await first.installFromWorkspace("package", { id: "shared", scope: "global" });
		await writeFile(join(a, "package", "SKILL.md"), body.replace("Global instructions.", "Project instructions."));
		await first.installFromWorkspace("package", { id: "shared", scope: "workspace" });
		expect(await first.get("a", "shared")).toMatchObject({ content: "Project instructions.", scope: "workspace" });
		await first.setEnabled("shared", false);
		expect(await first.listEnabled("a")).toEqual([]);
		expect((await second.get("b", "shared")).content).toBe("Global instructions.");
		await first.uninstall("shared");
		expect(await first.get("a", "shared")).toMatchObject({ content: "Global instructions.", scope: "global" });
	});
	it("never silently changes global state when scope is omitted", async () => {
		const { first, second } = await fixture();
		await first.installFromWorkspace("package", { id: "shared", scope: "global" });
		await expect(second.uninstall("shared")).rejects.toMatchObject({ protocolCode: "forbidden" });
		await expect(second.setEnabled("shared", false)).rejects.toMatchObject({ protocolCode: "not_found" });
		expect(await first.list()).toMatchObject([{ enabled: true, scope: "global" }]);
	});
	it("handles the home directory itself as a project without recursive resolution", async () => {
		const { first, catalog, home } = await fixture();
		await first.installFromWorkspace("package", { id: "shared", scope: "global" });
		const manager = catalog.manager(home);
		expect(await manager.get("home", "shared")).toMatchObject({ scope: "global" });
		await manager.setEnabled("shared", false, "global");
		expect(await first.listEnabled("a")).toEqual([]);
	});
	it("supports manually placed global skills and preserves builtin fallback", async () => {
		const { first, home, builtins } = await fixture();
		await mkdir(join(builtins, "shared"), { recursive: true });
		await writeFile(join(builtins, "shared", "SKILL.md"), body + " builtin");
		await mkdir(join(home, ".wuming", "skills", "shared"), { recursive: true });
		await writeFile(join(home, ".wuming", "skills", "shared", "SKILL.md"), body);
		expect(await first.get("a", "shared")).toMatchObject({ content: "Global instructions.", scope: "global" });
		await first.setEnabled("shared", false, "global");
		expect(await first.listEnabled("a")).toEqual([]);
		await first.uninstall("shared", "global");
		expect(await first.get("a", "shared")).toMatchObject({
			source: "builtin",
			content: "Global instructions. builtin",
		});
		await expect(first.setEnabled("shared", false, "global")).rejects.toMatchObject({ protocolCode: "forbidden" });
	});
	it("retains source/resource traversal protection and rejects global access in server mode", async () => {
		const { first, a, home, builtins } = await fixture();
		await expect(first.installFromWorkspace("../outside", { scope: "global" })).rejects.toMatchObject({
			protocolCode: "forbidden",
		});
		await first.installFromWorkspace("package", { id: "shared", scope: "global" });
		await expect(first.readResource("a", "shared", "../SKILL.md")).rejects.toMatchObject({ protocolCode: "forbidden" });
		const server = new SkillManager(a, builtins, { globalRoot: home, userSkillsEnabled: false });
		expect(await server.list()).toEqual([]);
		await expect(server.installFromWorkspace("package", { scope: "global" })).rejects.toMatchObject({
			protocolCode: "forbidden",
		});
		await expect(server.setEnabled("shared", false, "global")).rejects.toMatchObject({ protocolCode: "forbidden" });
		await expect(server.uninstall("shared", "global")).rejects.toMatchObject({ protocolCode: "forbidden" });
	});
	it("serializes global mutations across projects and fails closed on corrupt shared metadata", async () => {
		const { first, second, home } = await fixture();
		await first.installFromWorkspace("package", { id: "shared", scope: "global" });
		await mkdir(join(home, ".wuming", "skills.lock"));
		await expect(second.setEnabled("shared", false, "global")).rejects.toMatchObject({ protocolCode: "conflict" });
		await rm(join(home, ".wuming", "skills.lock"), { recursive: true });
		await writeFile(join(home, ".wuming", "skills.json"), "{");
		await expect(first.list()).rejects.toMatchObject({ protocolCode: "conflict" });
		await expect(second.uninstall("shared", "global")).rejects.toMatchObject({ protocolCode: "conflict" });
		expect(await readFile(join(home, ".wuming", "skills.json"), "utf8")).toBe("{");
	});
	it("rejects junctions in global storage without writing into their target", async () => {
		const { first, home, root } = await fixture();
		const target = join(root, "outside");
		await mkdir(target);
		await mkdir(home);
		await symlink(target, join(home, ".wuming"), "junction");
		await expect(first.installFromWorkspace("package", { id: "shared", scope: "global" })).rejects.toMatchObject({
			protocolCode: "forbidden",
		});
	});
});
