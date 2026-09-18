import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { load, JSON_SCHEMA } from "js-yaml";
import { githubPublishConfig } from "../../apps/desktop/src/updates.mjs";

function requireValue(condition, message) {
	if (!condition) throw new Error("Desktop release verification failed: " + message);
}

export async function verifyDesktopRelease({ directory, version, repository }) {
	const expected = githubPublishConfig(repository);
	requireValue(expected, "an update repository is required");
	requireValue(/^\d+\.\d+\.\d+$/.test(version), "a stable desktop version is required");
	const info = load(await readFile(join(directory, "latest.yml"), "utf8"), { schema: JSON_SCHEMA });
	const filename = `Pi-Wm-${version}-Setup-x64.exe`;
	requireValue(info?.version === version, "latest.yml version does not match the desktop version");
	requireValue(
		Array.isArray(info.files) && info.files.length === 1 && info.files[0]?.url === filename,
		"latest.yml must reference exactly the expected Windows x64 installer"
	);
	const file = info.files[0];
	const installer = join(directory, filename);
	const size = (await stat(installer)).size;
	requireValue(
		size > 0 && file.size === size,
		"installer size does not match latest.yml; rebuild the complete release"
	);
	const hash = createHash("sha512");
	for await (const chunk of createReadStream(installer)) hash.update(chunk);
	const sha512 = hash.digest("base64");
	requireValue(
		file.sha512 === sha512 && info.sha512 === sha512 && info.path === filename,
		"installer checksum or legacy metadata does not match latest.yml"
	);
	const blockmap = JSON.parse(
		gunzipSync(await readFile(installer + ".blockmap"), { maxOutputLength: 16 * 1024 * 1024 })
	);
	requireValue(blockmap.version === "2" && blockmap.files?.length === 1, "unsupported blockmap format");
	const blocks = blockmap.files[0];
	requireValue(
		blocks.offset === 0 &&
			Array.isArray(blocks.sizes) &&
			blocks.sizes.every((value) => Number.isSafeInteger(value) && value > 0) &&
			blocks.sizes.reduce((sum, value) => sum + value, 0) === size &&
			blocks.checksums?.length === blocks.sizes.length,
		"blockmap does not cover the installer"
	);
	const config = load(await readFile(join(directory, "win-unpacked/resources/app-update.yml"), "utf8"), {
		schema: JSON_SCHEMA,
	});
	requireValue(
		config?.provider === "github" &&
			config.owner === expected.owner &&
			config.repo === expected.repo &&
			config.private !== true &&
			!config.token &&
			!config.host &&
			!config.url,
		"packaged app-update.yml does not match the public GitHub update source"
	);
	return {
		version,
		repository,
		installer: filename,
		size,
		sha512,
		assets: [filename, filename + ".blockmap", "latest.yml"],
	};
}
