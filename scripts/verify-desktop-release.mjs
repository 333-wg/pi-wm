import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolveUpdateRepository } from "../apps/desktop/src/updates.mjs";
import { verifyDesktopRelease } from "./lib/desktop-update-release.mjs";

const manifest = JSON.parse(await readFile(new URL("../apps/desktop/package.json", import.meta.url), "utf8"));
try {
	const report = await verifyDesktopRelease({
		directory: fileURLToPath(new URL("../release", import.meta.url)),
		version: manifest.version,
		repository: resolveUpdateRepository(process.env.WUMING_UPDATE_REPOSITORY, manifest.desktopUpdateRepository),
	});
	console.log(JSON.stringify(report, null, 2));
	console.log("Release files are consistent. This does not verify code signing or a real installation/upgrade.");
} catch (error) {
	console.error(error.message);
	process.exitCode = 1;
}
