import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { ManagedSkillCatalog } from "../src/managed-skill-catalog.js";
import { createSkillTools } from "../src/skill-tools.js";
import {
	adaptMediaSkillContent,
	mediaSkillRoutingFragment,
	mediaStatusFragment,
	type MediaDefaults,
} from "../src/media-skill-policy.js";

const source =
	"---\nname: Favorite media\ndescription: Create images and videos in my favorite style\n---\nUse FAVORITE_STYLE coral and teal. Create a storyboard. Ask the user for FAVORITE_API_KEY, configure .env, then run scripts/generate.py with vendor-only-model.";
const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("zero-configuration local media skills", () => {
	it("keeps routing, status and selected-skill wrappers within registered media tools", () => {
		const names = [
			"media_model_status",
			"generate_image",
			"get_generated_image",
			"generate_video",
			"get_generated_video",
		];
		for (let mask = 0; mask < 2 ** names.length; mask++) {
			const tools = new Set(names.filter((_, index) => mask & (1 << index)));
			const defaults: MediaDefaults = [
				{ kind: "image", model: "image-test" },
				{ kind: "video", model: "video-test" },
			];
			const rendered = [
				mediaSkillRoutingFragment(tools).content,
				mediaStatusFragment(defaults, tools).content,
				adaptMediaSkillContent(source, defaults, { availableTools: tools }),
			].join("\n");
			for (const name of names.filter((name) => !tools.has(name))) expect(rendered).not.toContain(name);
			expect(rendered).toContain(source);
			expect(rendered).toContain("Do not ask the user for another API key");
			if (tools.has("generate_image")) expect(rendered).toContain("Omit generate_image.model");
			if (tools.has("get_generated_image")) expect(rendered).toContain("saved jobId once");
			if (tools.has("generate_video")) expect(rendered).toContain("videoCapabilities");
			if (tools.has("get_generated_video")) expect(rendered).toContain("returned jobId");
			if (tools.size === 0) expect(rendered).toContain("Media execution is unavailable");
		}
	});

	it("keeps explicitly selected skill instructions stable when only media settings change", () => {
		const absent = adaptMediaSkillContent(source, [], { includeStatus: false });
		const configured = adaptMediaSkillContent(source, [{ kind: "image", model: "new-model" }], {
			includeStatus: false,
		});
		expect(configured).toBe(absent);
		expect(configured).toContain(source);
		expect(configured).toContain("generate_image / generate_video / get_generated_video");
		expect(configured).not.toContain("Current host defaults");
	});
	it("adapts selected instructions without modifying creative content or exposing model settings", () => {
		const defaults = [{ kind: "image" as const, apiKey: "hidden-secret", baseUrl: "https://hidden.example" }];
		const adapted = adaptMediaSkillContent(source, defaults);
		expect(adapted).toContain(source);
		expect(adapted).toContain("No per-skill media configuration is required");
		expect(adapted).toContain("generate_image / generate_video / get_generated_video");
		expect(adapted).not.toContain("hidden-secret");
		expect(adapted).not.toContain("hidden.example");
	});

	it("keeps the host integration rule required and refreshes readiness between turns", () => {
		const absent = mediaStatusFragment([]);
		const current = mediaStatusFragment([{ kind: "image" }, { kind: "video" }]);
		const configured = mediaSkillRoutingFragment();
		expect(configured).toMatchObject({ kind: "policy", required: true, truncation: "none", cacheScope: "stable" });
		expect(current).toMatchObject({ kind: "workspace", delivery: "user", required: true });
		expect(current.version).not.toBe(absent.version);
		expect(configured).toEqual(mediaSkillRoutingFragment());
		expect(configured.content).not.toContain('"configured"');
		expect(configured.content).toContain("Do not ask the user for another API key");
		expect(configured.content).toContain("Do not generate media for unrelated tasks");
		expect(configured.content).toContain("Only send supported tool arguments");
	});

	it("adapts local skill and reference loads with live settings, preserving source files and attestations", async () => {
		const root = await mkdtemp(join(tmpdir(), "wuming-media-skill-"));
		roots.push(root);
		const packageRoot = join(root, "package");
		await mkdir(join(packageRoot, "scripts"), { recursive: true });
		await writeFile(join(packageRoot, "SKILL.md"), source);
		await writeFile(join(packageRoot, "scripts", "generate.py"), "raise RuntimeError('provider-script-must-not-run')");
		const manager = new ManagedSkillCatalog().manager(root);
		await manager.install(packageRoot, { id: "favorite-media" });
		const installed = await manager.get("workspace", "favorite-media");
		let defaults: MediaDefaults = [{ kind: "image" }];
		const tool = createSkillTools(manager, "workspace", [], { mediaModels: () => defaults }).find(
			(value) => value.name === "skill_load"
		)!;
		const load = (resourcePath?: string) =>
			tool.execute(
				"load",
				{ skillId: "favorite-media", ...(resourcePath ? { resourcePath } : {}) },
				undefined,
				undefined,
				undefined as unknown as Parameters<ToolDefinition["execute"]>[4]
			);
		const first = await load();
		expect(first.content[0]).toMatchObject({ text: expect.stringContaining("Host integration reminder") });
		expect(first.content[0]).toMatchObject({ text: expect.stringContaining('"kind":"video","configured":false') });
		expect(first.details).toMatchObject({
			wumingSkill: { digest: createHash("sha256").update(installed.content).digest("hex"), instructions: true },
		});
		defaults = [{ kind: "image" }, { kind: "video" }];
		const second = await load("scripts/generate.py");
		expect(second.content[0]).toMatchObject({ text: expect.stringContaining('"kind":"video","configured":true') });
		expect(second.details).toMatchObject({ wumingSkill: { instructions: false } });
		expect(await readFile(join(root, ".wuming", "skills", "favorite-media", "SKILL.md"), "utf8")).toBe(source);
		await manager.setEnabled("favorite-media", false);
		await expect(load()).rejects.toMatchObject({ protocolCode: "forbidden" });
	});

	it("keeps on-demand skill and resource wrappers within a restricted member's actual tools", async () => {
		const root = await mkdtemp(join(tmpdir(), "wuming-restricted-media-skill-"));
		roots.push(root);
		const packageRoot = join(root, "package");
		await mkdir(join(packageRoot, "references"), { recursive: true });
		await writeFile(join(packageRoot, "SKILL.md"), source);
		await writeFile(join(packageRoot, "references", "colors.txt"), "Preserve reference colors.");
		const manager = new ManagedSkillCatalog().manager(root);
		await manager.install(packageRoot, { id: "favorite-media" });
		const installedContent = (await manager.get("workspace", "favorite-media")).content;
		for (const names of [["skill_load"], ["skill_load", "generate_image"]]) {
			const tool = createSkillTools(manager, "workspace", [], {
				mediaModels: () => [{ kind: "image", model: "image-test" }],
				availableTools: new Set(names),
			}).find((tool) => tool.name === "skill_load")!;
			for (const resourcePath of [undefined, "references/colors.txt"]) {
				const result = await tool.execute(
					"load",
					{ skillId: "favorite-media", ...(resourcePath ? { resourcePath } : {}) },
					undefined,
					undefined,
					undefined as never
				);
				const text = result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
				for (const absent of ["media_model_status", "get_generated_image", "generate_video", "get_generated_video"])
					expect(text).not.toContain(absent);
				if (names.includes("generate_image")) expect(text).toContain("generate_image");
				else {
					expect(text).not.toContain("generate_image");
					expect(text).toContain("Media execution is unavailable");
				}
				expect(text).toContain(resourcePath ? "Preserve reference colors." : installedContent);
			}
		}
	});
});
