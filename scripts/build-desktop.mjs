import { Arch, build, Platform } from "electron-builder";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { githubPublishConfig } from "../apps/desktop/src/updates.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const base = JSON.parse(await readFile(new URL("../apps/desktop/electron-builder.json", import.meta.url), "utf8"));
const repository = process.env.WUMING_UPDATE_REPOSITORY?.trim() || undefined;
const publish = githubPublishConfig(repository);
// Never publish implicitly, even when a developer has GH_TOKEN set in their shell.
await build({
	projectDir: root,
	targets: Platform.WINDOWS.createTarget(process.argv.includes("--dir") ? "dir" : "nsis", Arch.x64),
	publish: "never",
	config: { ...base, publish, extraMetadata: { desktopUpdateRepository: repository ?? null } },
});
