import assert from "node:assert/strict";
import { test } from "node:test";
import { startDesktopWorkflowFixture } from "../../../scripts/lib/desktop-workflow-fixture.mjs";

test("workflow fixture keeps the task and tool steps across hidden reference snapshots", async (t) => {
	const fixture = await startDesktopWorkflowFixture();
	t.after(() => fixture.close());
	const reference = { role: "user", content: "## Current host reference snapshot\nCurrent workspace data." };
	const task = { role: "user", content: [{ type: "text", text: "DESKTOP_CASE:copy Perform the task." }] };
	const request = async (messages) => {
		const response = await fetch(`${fixture.baseUrl}/chat/completions`, {
			method: "POST",
			headers: { authorization: "Bearer desktop-fixture-only", "content-type": "application/json" },
			body: JSON.stringify({ model: "desktop-fixture", messages, stream: true }),
		});
		assert.equal(response.status, 200);
		return response.text();
	};
	assert.match(await request([task, reference]), /"name":"read_file"/);
	assert.deepEqual(fixture.requests.at(-1), { scenario: "copy", step: 0, model: "desktop-fixture" });
	assert.match(
		await request([task, reference, { role: "tool", content: "DESKTOP_FILE_PROOF_fixture" }, reference]),
		/"name":"write_file"/
	);
	assert.deepEqual(fixture.requests.at(-1), { scenario: "copy", step: 1, model: "desktop-fixture" });
	assert.match(
		await request([task, { role: "user", content: "DESKTOP_CASE:deny Perform another task." }, reference]),
		/"name":"write_file"/
	);
	assert.deepEqual(fixture.requests.at(-1), { scenario: "deny", step: 0, model: "desktop-fixture" });
	assert.match(await request([{ role: "user", content: "Test connection." }, reference]), /DESKTOP_CONNECTION_OK/);
	assert.deepEqual(fixture.errors, []);
});
