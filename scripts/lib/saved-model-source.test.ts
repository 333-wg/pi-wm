import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSavedModelSource, smokeRegistrations } from "./saved-model-source.js";

const key = "fixture-only-encryption-key";
const service = {
	provider: "saved-test",
	baseUrl: "http://127.0.0.1:9000/v1",
	api: "openai-completions",
	apiKey: "fixture-only-api-key",
};
const model = {
	provider: service.provider,
	id: "test-model",
	name: "Test",
	reasoning: false,
	input: ["text"],
	contextWindow: 32000,
	maxOutputTokens: 4096,
};

for (const legacy of [true, false]) {
	test("loads saved models without modifying " + (legacy ? "legacy" : "version 2") + " source", async () => {
		const directory = await mkdtemp(join(tmpdir(), "wuming-model-source-test-"));
		try {
			const iv = randomBytes(12);
			const cipher = createCipheriv("aes-256-gcm", createHash("sha256").update(key).digest(), iv);
			const value = legacy ? [{ ...service, ...model }] : { version: 2, services: [service], models: [model] };
			const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
			const encoded = JSON.stringify({
				iv: iv.toString("base64url"),
				tag: cipher.getAuthTag().toString("base64url"),
				data: data.toString("base64url"),
			});
			await writeFile(join(directory, "custom-models.enc"), encoded, "utf8");
			await writeFile(join(directory, "custom-models.key"), key, "utf8");
			const source = await loadSavedModelSource(directory);
			assert.deepEqual(
				source.models.map((entry) => entry.model),
				[{ provider: service.provider, id: model.id }]
			);
			assert.equal(source.registrations[0]?.config.apiKey, service.apiKey);
			const bounded = smokeRegistrations(source.registrations, service.provider, model.id);
			assert.equal(bounded[0]?.config.models?.[0]?.maxTokens, 256);
			assert.equal(source.registrations[0]?.config.models?.[0]?.maxTokens, 4096);
			assert.throws(() => smokeRegistrations(source.registrations, service.provider, "missing"));
			assert.equal(await readFile(join(directory, "custom-models.enc"), "utf8"), encoded);
			assert.equal(await readFile(join(directory, "custom-models.key"), "utf8"), key);
			assert.deepEqual((await readdir(directory)).sort(), ["custom-models.enc", "custom-models.key"]);
			await assert.rejects(loadSavedModelSource(directory, "wrong-key"));
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
}

test("missing sources do not create directories or encryption keys", async () => {
	const parent = await mkdtemp(join(tmpdir(), "wuming-model-missing-test-"));
	const directory = join(parent, "missing");
	try {
		await assert.rejects(loadSavedModelSource(directory), { code: "ENOENT" });
		assert.equal(
			await access(directory).then(
				() => true,
				() => false
			),
			false
		);
	} finally {
		await rm(parent, { recursive: true, force: true });
	}
});
