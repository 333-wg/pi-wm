import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { load, JSON_SCHEMA } from "js-yaml";
import { desktopTarget } from "../../../scripts/lib/desktop-target.mjs";
import { runtimeNodeName } from "../src/runtime-paths.mjs";

test("native desktop targets retain Windows NSIS and split Intel and Apple Silicon", () => {
	assert.deepEqual(desktopTarget("win32", "x64").targets, ["nsis"]);
	assert.equal(runtimeNodeName("win32"), "node.exe");
	assert.equal(runtimeNodeName("darwin"), "node");
	for (const arch of ["x64", "arm64"]) {
		const target = desktopTarget("darwin", arch);
		assert.deepEqual(target.targets, ["dmg", "zip"]);
		assert.equal(target.platform, "darwin");
		assert.equal(target.arch, arch);
	}
	assert.throws(() => desktopTarget("linux", "x64"), /Unsupported/);
	assert.throws(() => desktopTarget("win32", "arm64"), /Unsupported/);
	assert.throws(() => desktopTarget("darwin", "ia32"), /Unsupported/);
});

test("Mac configuration has a full-size product icon and explicit internal-test signing", async () => {
	const config = JSON.parse(await readFile(new URL("../electron-builder.json", import.meta.url), "utf8"));
	const icon = await readFile(new URL(`../../../${config.mac.icon}`, import.meta.url));
	assert.ok(icon.readUInt32BE(16) >= 512 && icon.readUInt32BE(20) >= 512);
	assert.equal(config.mac.identity, "-");
	assert.equal(config.mac.notarize, false);
	assert.deepEqual(config.mac.target, ["dmg", "zip"]);
	assert.equal(config.mac.artifactName, "Pi-Wm-${version}-mac-${arch}.${ext}");
	assert.deepEqual(config.win.target, [{ target: "nsis", arch: ["x64"] }]);
});

test("Mac CI gates both architectures before explicit release attachment", async () => {
	const workflow = load(
		await readFile(new URL("../../../.github/workflows/desktop-macos.yml", import.meta.url), "utf8"),
		{ schema: JSON_SCHEMA }
	);
	assert.equal(workflow.on.workflow_dispatch.inputs.upload_to_release.default, false);
	assert.equal(workflow.on.workflow_dispatch.inputs.candidate_run_id.default, "");
	assert.match(workflow.jobs.build.if, /inputs.candidate_run_id == ''/);
	assert.deepEqual(workflow.jobs.build.strategy.matrix.include, [
		{ runner: "macos-15", arch: "arm64" },
		{ runner: "macos-15-intel", arch: "x64" },
	]);
	const steps = workflow.jobs.build.steps;
	assert.ok(
		steps.findIndex((step) => step.run === "npm run desktop:dist") <
			steps.findIndex((step) => step.run === "npm run test:desktop")
	);
	assert.ok(steps.some((step) => step.run === "node scripts/verify-desktop-macos.mjs"));
	assert.equal(workflow.jobs.upload.needs, "build");
	assert.match(workflow.jobs.upload.if, /inputs.upload_to_release/);
	assert.match(workflow.jobs.upload.if, /needs.build.result == 'success'/);
	assert.equal(workflow.jobs.upload.permissions.actions, "read");
	const provenance = workflow.jobs.upload.steps.find((step) => step.name?.startsWith("Validate existing candidate"));
	assert.match(provenance.run, /git merge-base --is-ancestor/);
	assert.match(provenance.run, /Application changed after candidate build/);
	assert.match(provenance.run, /conclusion == "success"/);
	const download = workflow.jobs.upload.steps.find((step) => step.uses === "actions/download-artifact@v4");
	assert.equal(download.with["run-id"], "${{ inputs.candidate_run_id || github.run_id }}");
	assert.match(workflow.jobs.upload.steps.at(-1).run, /sha256sum --check/);
	assert.doesNotMatch(workflow.jobs.upload.steps.at(-1).run, /--clobber|release create|release edit|latest-mac/);
});
