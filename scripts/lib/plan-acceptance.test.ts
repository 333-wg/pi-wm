import { strict as assert } from "node:assert";
import { test } from "node:test";
import { resolve } from "node:path";
import { verifyPlanArtifacts, verifyPlanTools } from "./plan-acceptance.js";

const workspace = resolve("acceptance-fixture");
const read = (path: string) => ({ toolName: "read_file", status: "complete", input: { path } });
const write = (path: string) => ({ toolName: "write_file", status: "complete", input: { path } });
const valid = () => [read("left.json"), read("right.json"), write("report.json"), read("report.json")];

test("accepts exact artifacts and ordered file evidence", () => {
	verifyPlanArtifacts({ value: 17 }, { value: 25 }, { sum: 42, sources: ["left.json", "right.json"] });
	verifyPlanTools("left", [write(resolve(workspace, "left.json"))], workspace);
	verifyPlanTools("right", [write("./right.json")], workspace);
	verifyPlanTools("merge", valid(), workspace);
});

for (const report of [
	null,
	[],
	{ sum: 43, sources: ["left.json", "right.json"] },
	{ sum: 42, sources: ["right.json", "left.json"] },
	{ sum: 42, sources: ["left.json", "right.json"], extra: true },
]) {
	test("rejects incorrect artifact " + JSON.stringify(report), () =>
		assert.throws(() => verifyPlanArtifacts({ value: 17 }, { value: 25 }, report))
	);
}

for (const [name, tools] of [
	["repeated unrelated reads", [read("left.json"), read("left.json"), write("report.json"), read("left.json")]],
	["verification before write", [read("left.json"), read("right.json"), read("report.json"), write("report.json")]],
	["rewrite after verification", [...valid(), write("report.json")]],
	["failed write", valid().map((tool) => (tool.toolName === "write_file" ? { ...tool, isError: true } : tool))],
	["outside workspace", [read("../left.json"), ...valid()]],
	["process tool", [...valid(), { toolName: "exec", status: "complete", input: {} }]],
	["wrong output", [read("left.json"), read("right.json"), write("left.json"), read("report.json")]],
] as const) {
	test("rejects " + name, () => assert.throws(() => verifyPlanTools("merge", [...tools], workspace)));
}
