import { relative, resolve } from "node:path";

export interface FileToolEvidence {
	toolName: string;
	status: string;
	isError?: boolean;
	input: unknown;
}

export function verifyFileRoundTrip(input: string, output: string, tools: FileToolEvidence[], workspace: string): void {
	if (!input || output !== input) throw new Error("File round-trip content does not match");
	const expected = [
		["read_file", "input.txt"],
		["write_file", "output.txt"],
		["read_file", "output.txt"],
	];
	if (tools.length !== expected.length) throw new Error("Expected exactly three file tool calls");
	for (const [index, tool] of tools.entries()) {
		if (tool.status !== "complete" || tool.isError) throw new Error("File tool did not succeed");
		const args = tool.input;
		if (!args || typeof args !== "object" || !("path" in args) || typeof args.path !== "string")
			throw new Error("File tool path missing");
		const path = relative(resolve(workspace), resolve(workspace, args.path));
		if (tool.toolName !== expected[index]![0] || path !== expected[index]![1])
			throw new Error("Unexpected file tool sequence or path");
	}
}
