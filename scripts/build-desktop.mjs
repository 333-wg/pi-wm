import { Arch, build, Platform } from "electron-builder";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { githubPublishConfig, resolveUpdateRepository } from "../apps/desktop/src/updates.mjs";
import { verifyDesktopRelease } from "./lib/desktop-update-release.mjs";
import { desktopTarget } from "./lib/desktop-target.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const base = JSON.parse(await readFile(new URL("../apps/desktop/electron-builder.json", import.meta.url), "utf8"));
const manifest = JSON.parse(await readFile(new URL("../apps/desktop/package.json", import.meta.url), "utf8"));
const repository = resolveUpdateRepository(process.env.WUMING_UPDATE_REPOSITORY, manifest.desktopUpdateRepository);
const publish = githubPublishConfig(repository);
const target = desktopTarget();
const platform = target.platform === "darwin" ? Platform.MAC : Platform.WINDOWS;
// Never publish implicitly, even when a developer has GH_TOKEN set in their shell.
await build({
	projectDir: root,
	targets: platform.createTarget(process.argv.includes("--dir") ? "dir" : target.targets, Arch[target.arch]),
	publish: "never",
	config: { ...base, publish, extraMetadata: { desktopUpdateRepository: repository ?? null } },
});
if (repository && target.platform === "win32" && !process.argv.includes("--dir")) {
	const result = await verifyDesktopRelease({
		directory: fileURLToPath(new URL("../release", import.meta.url)),
		version: manifest.version,
		repository,
	});
	console.log("Desktop release verified:", JSON.stringify(result));
}
