import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ImportedProjectCatalog } from "../src/projects.js";

const cleanup: string[] = [];

afterEach(async () => {
	for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true });
});

describe("ImportedProjectCatalog", () => {
	it("persists an imported directory with its relative paths", async () => {
		const root = await mkdtemp(join(tmpdir(), "wuming-projects-"));
		cleanup.push(root);
		const catalog = await ImportedProjectCatalog.open(root, {
			idFactory: () => "project-one",
			clock: () => 100,
		});
		const draft = await catalog.create("user-1", "Example app");
		expect(draft).toMatchObject({ id: "project-one", name: "Example app", status: "provisioning" });

		await catalog.writeProjectFile("user-1", draft.id, "src/index.ts", Buffer.from("export const answer = 42;\n"));
		await catalog.writeProjectFile("user-1", draft.id, "README.md", Buffer.from("# Example\n"));
		const completed = await catalog.complete("user-1", draft.id);
		expect(completed.workspace.status).toBe("ready");
		expect(await readFile(join(completed.configuration.path, "src", "index.ts"), "utf8")).toContain("answer = 42");

		const reopened = await ImportedProjectCatalog.open(root);
		expect(reopened.configurations()).toEqual([completed.configuration]);
	});

	it("rejects path traversal, foreign owners, and empty projects", async () => {
		const root = await mkdtemp(join(tmpdir(), "wuming-projects-"));
		cleanup.push(root);
		const catalog = await ImportedProjectCatalog.open(root, { idFactory: () => "project-two" });
		const draft = await catalog.create("user-1", "Boundary test");

		await expect(catalog.writeProjectFile("user-1", draft.id, "../secret.txt", Buffer.from("no"))).rejects.toThrow(
			"invalid"
		);
		await expect(catalog.writeProjectFile("user-2", draft.id, "safe.txt", Buffer.from("no"))).rejects.toThrow(
			"access denied"
		);
		await expect(catalog.complete("user-1", draft.id)).rejects.toThrow("at least one file");
	});

	it("binds a local folder without copying its files", async () => {
		const root = await mkdtemp(join(tmpdir(), "wuming-projects-"));
		const source = await mkdtemp(join(tmpdir(), "wuming-source-"));
		cleanup.push(root, source);
		const catalog = await ImportedProjectCatalog.open(root, {
			idFactory: () => "project-local",
			clock: () => 200,
		});
		const project = await catalog.addLocal(source, "directory");

		expect(project).toMatchObject({ id: "project-local", status: "ready" });
		expect(catalog.configurations()[0]?.path).toBe(source);
		expect(catalog.configurations()[0]?.path.startsWith(root)).toBe(false);
	});

	it("renames and hides a project without deleting its files, then restores it by path", async () => {
		const root = await mkdtemp(join(tmpdir(), "wuming-projects-"));
		const source = await mkdtemp(join(tmpdir(), "wuming-source-"));
		cleanup.push(root, source);
		const catalog = await ImportedProjectCatalog.open(root, {
			idFactory: () => "project-restorable",
			clock: () => 300,
		});
		const project = await catalog.addLocal(source, "directory");
		await catalog.renameProject(project.id, "Renamed project");
		await catalog.removeProject(project.id);

		expect(catalog.configurations()).toEqual([]);
		expect((await stat(source)).isDirectory()).toBe(true);

		const reopened = await ImportedProjectCatalog.open(root, { clock: () => 400 });
		expect(reopened.configurations()).toEqual([]);
		const restored = await reopened.addLocal(source, "directory");
		expect(restored).toMatchObject({ id: project.id, name: "Renamed project" });
		expect(reopened.configurations()).toEqual([{ id: project.id, name: "Renamed project", path: source }]);
	});
});
