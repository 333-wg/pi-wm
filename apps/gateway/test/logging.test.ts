import { describe, expect, it } from "vitest";
import { createConsoleStructuredLogger } from "../src/logging.js";

describe("structured gateway logging", () => {
	it("writes JSONL with bounded, redacted fields", () => {
		const lines: string[] = [];
		const logger = createConsoleStructuredLogger({ level: "debug", write: (line) => lines.push(line) });
		logger.log("info", "test.event", {
			requestId: "req-1",
			token: "do-not-write",
			content: "user prompt must not be logged",
			nested: { authorization: "also-secret", value: "ok" },
		});

		expect(lines).toHaveLength(1);
		const record = JSON.parse(lines[0]!);
		expect(record).toMatchObject({ level: "info", event: "test.event", requestId: "req-1", service: "wuming-gateway" });
		expect(record.token).toBe("[redacted]");
		expect(record.content).toBe("[omitted]");
		expect(record.nested).toEqual({ authorization: "[redacted]", value: "ok" });
		expect(lines[0]).not.toContain("do-not-write");
		expect(lines[0]).not.toContain("user prompt must not be logged");
	});

	it("honors the configured minimum level", () => {
		const lines: string[] = [];
		const logger = createConsoleStructuredLogger({ level: "warn", write: (line) => lines.push(line) });
		logger.log("info", "ignored");
		logger.log("warn", "kept");
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0]!).event).toBe("kept");
	});
});
