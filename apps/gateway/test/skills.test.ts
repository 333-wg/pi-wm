import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { FileSkillCatalog } from "../src/skills.js";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("FileSkillCatalog", () => {
	it("discovers markdown skills and parses bounded frontmatter", async () => {
		const root = await mkdtemp(join(tmpdir(), "wuming-skills-"));
		roots.push(root);
		const skillDir = join(root, ".wuming", "skills", "review-code");
		await mkdir(skillDir, { recursive: true });
		await writeFile(join(skillDir, "SKILL.md"), "---\nname: Code Review\ndescription: Review changes\n---\n# Instructions\n\nInspect the diff.", "utf8");
		const catalog = new FileSkillCatalog();
		expect(await catalog.list("workspace-1", root)).toMatchObject([{ id: "review-code", name: "Code Review", description: "Review changes", path: ".wuming/skills/review-code/SKILL.md" }]);
		expect(await catalog.get("workspace-1", root, "review-code")).toMatchObject({ name: "Code Review", content: "# Instructions\n\nInspect the diff.", truncated: false });
	});

	it("rejects traversal and missing skill files", async () => {
		const root = await mkdtemp(join(tmpdir(), "wuming-skills-"));
		roots.push(root);
		const catalog = new FileSkillCatalog();
		await expect(catalog.get("workspace-1", root, "../secret")).rejects.toMatchObject({ protocolCode: "invalid_request" });
		await expect(catalog.get("workspace-1", root, "missing")).rejects.toMatchObject({ protocolCode: "not_found" });
	});
});
