import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SkillManager } from "./skill-manager.js";
import type { SkillCatalog } from "./skills.js";

/** UI discovery and runtime resolution share the same enabled-state checks. */
export class ManagedSkillCatalog implements SkillCatalog {
	readonly #managers = new Map<string, SkillManager>();
	constructor(
		private readonly builtins = fileURLToPath(new URL("../builtin-skills/", import.meta.url)),
		private readonly userSkillsEnabled = true,
		private readonly managedEnabled?: (id: string) => boolean | undefined
	) {}
	manager(workspaceRoot: string): SkillManager {
		const key = resolve(workspaceRoot);
		let manager = this.#managers.get(key);
		if (!manager) {
			manager = new SkillManager(key, this.builtins, {
				userSkillsEnabled: this.userSkillsEnabled,
				...(this.managedEnabled ? { managedEnabled: this.managedEnabled } : {}),
			});
			this.#managers.set(key, manager);
		}
		return manager;
	}
	list(workspaceId: string, workspaceRoot: string) {
		return this.manager(workspaceRoot).listEnabled(workspaceId);
	}
	get(workspaceId: string, workspaceRoot: string, skillId: string) {
		return this.manager(workspaceRoot).get(workspaceId, skillId);
	}
}
