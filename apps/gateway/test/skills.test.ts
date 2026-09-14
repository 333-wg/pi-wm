import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { FileSkillCatalog } from "../src/skills.js";
import { SkillSchema } from "@wuming/protocol";
import { Value } from "typebox/value";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("FileSkillCatalog", () => {
	for (const newline of ["\n", "\r\n", "\r"]) {
		it("parses BOM and multiline YAML with " + JSON.stringify(newline) + " while preserving body", async () => {
			const root = await mkdtemp(join(tmpdir(), "wuming-skills-yaml-"));
			roots.push(root);
			const directory = join(root, ".wuming", "skills", "yaml");
			await mkdir(directory, { recursive: true });
			const body = ["", "# 审查指令", "", "  保留缩进和行尾。", ""].join(newline);
			const raw =
				"\uFEFF" +
				[
					"---",
					'name: "中文：审查 #1"',
					"description: >-",
					"  Review code",
					"  and tests.",
					"allowed-tools:",
					"  - read_file",
					"---",
					"",
				].join(newline) +
				body;
			await writeFile(join(directory, "SKILL.md"), raw, "utf8");
			const catalog = new FileSkillCatalog();
			expect(await catalog.get("workspace-1", root, "yaml")).toMatchObject({
				name: "中文：审查 #1",
				description: "Review code and tests.",
				content: body,
			});
			expect(await catalog.list("workspace-1", root)).toMatchObject([
				{ name: "中文：审查 #1", description: "Review code and tests." },
			]);
		});
	}

	for (const [raw, description, content] of [
		["---\ndescription: |-\n  First line\n  Second line\n---\nBody", "First line\nSecond line", "Body"],
		["---\n---\nBody", "Body", "Body"],
		["---not-metadata\nBody", "---not-metadata\nBody", "---not-metadata\nBody"],
	] as const) {
		it("handles literal metadata and exact delimiters: " + description, async () => {
			const root = await mkdtemp(join(tmpdir(), "wuming-skills-format-"));
			roots.push(root);
			const directory = join(root, ".wuming", "skills", "format");
			await mkdir(directory, { recursive: true });
			await writeFile(join(directory, "SKILL.md"), raw, "utf8");
			expect(await new FileSkillCatalog().get("workspace-1", root, "format")).toMatchObject({
				description,
				content,
			});
		});
	}

	for (const header of [
		'name: "unterminated',
		"name: first\nname: second",
		"- not-a-mapping",
		"description: [not, a, string]",
	]) {
		it("rejects malformed metadata without exposing raw YAML: " + header, async () => {
			const root = await mkdtemp(join(tmpdir(), "wuming-skills-invalid-yaml-"));
			roots.push(root);
			const directory = join(root, ".wuming", "skills", "invalid");
			await mkdir(directory, { recursive: true });
			await writeFile(join(directory, "SKILL.md"), "---\n" + header + "\n---\nBody", "utf8");
			const catalog = new FileSkillCatalog();
			await expect(catalog.get("workspace-1", root, "invalid")).rejects.toMatchObject({
				protocolCode: "invalid_request",
				message: "Skill invalid has invalid YAML metadata",
			});
			expect(await catalog.list("workspace-1", root)).toEqual([]);
		});
	}

	for (const level of [".wuming", "skills", "skill", "file"] as const) {
		it("does not follow an external link at " + level, async () => {
			const root = await mkdtemp(join(tmpdir(), "wuming-skills-link-"));
			const outside = await mkdtemp(join(tmpdir(), "wuming-skills-outside-"));
			roots.push(root, outside);
			await mkdir(join(outside, "skills", "linked"), { recursive: true });
			await writeFile(join(outside, "skills", "linked", "SKILL.md"), "External content must not be loaded", "utf8");
			if (level === ".wuming") await symlink(outside, join(root, ".wuming"), "junction");
			else if (level === "skills") {
				await mkdir(join(root, ".wuming"));
				await symlink(join(outside, "skills"), join(root, ".wuming", "skills"), "junction");
			} else if (level === "skill") {
				await mkdir(join(root, ".wuming", "skills"), { recursive: true });
				await symlink(join(outside, "skills", "linked"), join(root, ".wuming", "skills", "linked"), "junction");
			} else {
				await mkdir(join(root, ".wuming", "skills", "linked"), { recursive: true });
				await symlink(
					join(outside, "skills", "linked", "SKILL.md"),
					join(root, ".wuming", "skills", "linked", "SKILL.md"),
					"file"
				);
			}
			const catalog = new FileSkillCatalog();
			expect(await catalog.list("workspace-1", root)).toEqual([]);
			await expect(catalog.get("workspace-1", root, "linked")).rejects.toMatchObject({
				protocolCode: "not_found",
			});
		});
	}

	for (const text of [
		"x".repeat(200 * 1024),
		"x".repeat(200 * 1024 + 1),
		"中".repeat(100_000),
		"a" + "🧪".repeat(100_000),
	]) {
		it("bounds skill bytes and preserves UTF-8 for " + Buffer.byteLength(text) + " bytes", async () => {
			const root = await mkdtemp(join(tmpdir(), "wuming-skills-bounded-"));
			roots.push(root);
			const directory = join(root, ".wuming", "skills", "bounded");
			await mkdir(directory, { recursive: true });
			await writeFile(join(directory, "SKILL.md"), text, "utf8");
			const catalog = new FileSkillCatalog();
			const result = await catalog.get("workspace-1", root, "bounded");
			expect(Value.Check(SkillSchema, result)).toBe(true);
			expect(Buffer.byteLength(result.content)).toBeLessThanOrEqual(200 * 1024);
			expect(result.truncated).toBe(Buffer.byteLength(text) > 200 * 1024);
			expect(result.content).not.toContain("\uFFFD");
			expect(text.startsWith(result.content)).toBe(true);
			expect(Buffer.byteLength(result.content)).toBeGreaterThanOrEqual(200 * 1024 - 3);
			expect(await catalog.list("workspace-1", root)).toMatchObject([
				{ id: "bounded", description: result.description },
			]);
		});
	}

	it("discovers markdown skills and parses bounded frontmatter", async () => {
		const root = await mkdtemp(join(tmpdir(), "wuming-skills-"));
		roots.push(root);
		const skillDir = join(root, ".wuming", "skills", "review-code");
		await mkdir(skillDir, { recursive: true });
		await writeFile(
			join(skillDir, "SKILL.md"),
			"---\nname: Code Review\ndescription: Review changes\n---\n# Instructions\n\nInspect the diff.",
			"utf8"
		);
		const catalog = new FileSkillCatalog();
		expect(await catalog.list("workspace-1", root)).toMatchObject([
			{
				id: "review-code",
				name: "Code Review",
				description: "Review changes",
				path: ".wuming/skills/review-code/SKILL.md",
			},
		]);
		expect(await catalog.get("workspace-1", root, "review-code")).toMatchObject({
			name: "Code Review",
			content: "# Instructions\n\nInspect the diff.",
			truncated: false,
		});
	});

	it("rejects traversal and missing skill files", async () => {
		const root = await mkdtemp(join(tmpdir(), "wuming-skills-"));
		roots.push(root);
		const catalog = new FileSkillCatalog();
		await expect(catalog.get("workspace-1", root, "../secret")).rejects.toMatchObject({
			protocolCode: "invalid_request",
		});
		await expect(catalog.get("workspace-1", root, "missing")).rejects.toMatchObject({
			protocolCode: "not_found",
		});
	});
});
