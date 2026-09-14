import { strict as assert } from "node:assert";
import { test } from "node:test";
import { resolve } from "node:path";
import { verifyFileRoundTrip } from "./file-acceptance.js";

const workspace = resolve("file-proof-fixture");
const tools = () => [
	{ toolName: "read_file", status: "complete", input: { path: "input.txt" } },
	{ toolName: "write_file", status: "complete", input: { path: "output.txt" } },
	{ toolName: "read_file", status: "complete", input: { path: "output.txt" } },
];

test("accepts exact copied bytes and ordered file evidence", () => {
	const evidence = tools();
	evidence[0]!.input.path = resolve(workspace, "input.txt");
	verifyFileRoundTrip("proof\n", "proof\n", evidence, workspace);
});

test("rejects mismatched or empty file contents", () => {
	assert.throws(() => verifyFileRoundTrip("proof\n", "proof", tools(), workspace));
	assert.throws(() => verifyFileRoundTrip("", "", tools(), workspace));
});

for (const [name, evidence] of [
	["missing readback", tools().slice(0, 2)],
	["wrong order", tools().reverse()],
	["wrong path", tools().map((tool) => ({ ...tool, input: { path: "../output.txt" } }))],
	["tool failure", tools().map((tool) => ({ ...tool, isError: true }))],
	["extra call", [...tools(), tools()[0]!]],
] as const) {
	test("rejects " + name, () => assert.throws(() => verifyFileRoundTrip("proof", "proof", [...evidence], workspace)));
}
