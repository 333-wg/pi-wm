import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { load } from "js-yaml";

const {
	GITHUB_TOKEN: token,
	GITHUB_REPOSITORY: repository,
	UPDATE_RELEASE_ID: releaseId,
	UPDATE_BASELINE_VERSION: baselineVersion,
	UPDATE_TARGET_VERSION: targetVersion,
	UPDATE_FIXTURE_DIRECTORY: directory,
} = process.env;
if (!token || !/^\d+$/.test(releaseId ?? "") || !directory) throw new Error("Missing release download configuration");
for (const version of [baselineVersion, targetVersion])
	if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) throw new Error("Invalid version");
const headers = {
	Authorization: `Bearer ${token}`,
	Accept: "application/vnd.github+json",
	"X-GitHub-Api-Version": "2022-11-28",
};
const response = await fetch(`https://api.github.com/repos/${repository}/releases/${releaseId}`, { headers });
if (!response.ok) {
	const failure = await response.json().catch(() => ({}));
	throw new Error(`Release lookup failed: ${response.status} ${failure.message ?? ""}`);
}
const release = await response.json();
if (!release.draft) throw new Error("Installation fixtures must be in a draft release");
await mkdir(directory, { recursive: true });
const names = [
	`Pi-Wm-${baselineVersion}-Setup-x64.exe`,
	`Pi-Wm-${targetVersion}-Setup-x64.exe`,
	`Pi-Wm-${targetVersion}-Setup-x64.exe.blockmap`,
	"update-test-latest.yml",
];
const hashes = {};
for (const name of names) {
	const asset = release.assets.find((item) => item.name === name);
	if (!asset || asset.state !== "uploaded" || !/^sha256:[a-f0-9]{64}$/.test(asset.digest ?? ""))
		throw new Error(`Missing verified asset: ${name}`);
	const result = await fetch(asset.url, { headers: { ...headers, Accept: "application/octet-stream" } });
	if (!result.ok) throw new Error(`Asset download failed: ${result.status}`);
	const bytes = Buffer.from(await result.arrayBuffer());
	const sha256 = createHash("sha256").update(bytes).digest("hex");
	if (bytes.length !== asset.size || `sha256:${sha256}` !== asset.digest)
		throw new Error(`Asset integrity failure: ${name}`);
	await writeFile(join(directory, name === "update-test-latest.yml" ? "latest.yml" : name), bytes, { flag: "wx" });
	hashes[name] = sha256;
	console.log(`Verified asset: ${name} (${bytes.length} bytes)`);
}
const metadata = load(await readFile(join(directory, "latest.yml"), "utf8"));
if (metadata.version !== targetVersion) throw new Error("Test metadata version mismatch");
await writeFile(
	join(directory, "download-verification.json"),
	JSON.stringify({ releaseId, baselineVersion, targetVersion, hashes }, null, 2)
);
