import { Arch, build, Platform } from "electron-builder";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { githubPublishConfig } from "../apps/desktop/src/updates.mjs";
import { verifyDesktopRelease } from "./lib/desktop-update-release.mjs";

// Same application code as the candidate, with only a higher test version. Never publish this build.
const root = fileURLToPath(new URL("..", import.meta.url));
const base = JSON.parse(await readFile(new URL("../apps/desktop/electron-builder.json", import.meta.url), "utf8"));
const manifest = JSON.parse(await readFile(new URL("../apps/desktop/package.json", import.meta.url), "utf8"));
const parts = manifest.version.split(".").map(Number);
if (parts.length !== 3 || parts.some((part) => !Number.isSafeInteger(part)))
	throw new Error("Stable candidate required");
const version = `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
const output = "test-results/desktop-update-fixture";
await build({
	projectDir: root,
	targets: Platform.WINDOWS.createTarget("nsis", Arch.x64),
	publish: "never",
	config: {
		...base,
		directories: { ...base.directories, output },
		publish: githubPublishConfig(manifest.desktopUpdateRepository),
		extraMetadata: { version, desktopUpdateRepository: manifest.desktopUpdateRepository },
	},
});
console.log(
	"Unpublished update fixture:",
	await verifyDesktopRelease({
		directory: fileURLToPath(new URL(`../${output}`, import.meta.url)),
		version,
		repository: manifest.desktopUpdateRepository,
	})
);
