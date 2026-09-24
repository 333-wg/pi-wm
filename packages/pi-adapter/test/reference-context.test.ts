import { expect, it } from "vitest";
import { pendingReferenceMessage } from "../src/reference-context.js";

it("reuses unchanged retained snapshots and sends updated or empty snapshots", () => {
	const first = pendingReferenceMessage("snapshot one", [])!;
	const history = [{ role: "custom", ...first }];
	expect(pendingReferenceMessage("snapshot one", history)).toBeUndefined();
	expect(pendingReferenceMessage("snapshot two", history)?.content).toBe("snapshot two");
	expect(pendingReferenceMessage("[]", history)?.content).toBe("[]");
	expect(pendingReferenceMessage(undefined, history)).toBeUndefined();
});

it("reinjects after compaction and ignores user or tool messages with matching text", () => {
	expect(pendingReferenceMessage("snapshot", [{ role: "compactionSummary" }])?.content).toBe("snapshot");
	for (const role of ["user", "toolResult"])
		expect(
			pendingReferenceMessage("snapshot", [{ role, customType: "wuming-reference-context", content: "snapshot" }])
		).toBeDefined();
});

it("uses only the latest active snapshot, including after durable JSON restoration", () => {
	const history = ["old", "new"].map((content) => ({ role: "custom", ...pendingReferenceMessage(content, [])! }));
	const restored = JSON.parse(JSON.stringify(history));
	expect(pendingReferenceMessage("new", restored)).toBeUndefined();
	expect(pendingReferenceMessage("old", restored)?.content).toBe("old");
});

it("supersedes inline streaming snapshots even when returning to a prior configuration", () => {
	const original = { role: "custom", ...pendingReferenceMessage("snapshot A", [])! };
	const inline = {
		role: "user",
		content: [{ type: "text", text: "steer\n\n## Current host reference snapshot\n[snapshot B]\n" }],
	};
	expect(pendingReferenceMessage("snapshot A", [original, inline])?.content).toBe("snapshot A");
	expect(pendingReferenceMessage("snapshot A", [inline, original])).toBeUndefined();
});
