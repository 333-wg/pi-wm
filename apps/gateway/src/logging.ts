import { stderr } from "node:process";
import type { StructuredLogger, StructuredLogLevel } from "@wuming/orchestrator";

const LEVELS: Record<StructuredLogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const SECRET_KEY = /token|secret|password|authorization|cookie|credential|api.?key/i;
const PRIVATE_KEY = /^(content|prompt|input|output|arguments|args|delta|stack)$/i;

function safeValue(key: string, value: unknown): unknown {
	if (SECRET_KEY.test(key)) return "[redacted]";
	if (PRIVATE_KEY.test(key)) return "[omitted]";
	if (value instanceof Error) return { name: value.name, message: value.message.slice(0, 1000) };
	if (typeof value === "string") return value.length > 1000 ? `${value.slice(0, 997)}...` : value;
	if (Array.isArray(value)) return value.slice(0, 20).map((item) => safeValue(key, item));
	if (value && typeof value === "object") {
		const result: Record<string, unknown> = {};
		for (const [childKey, childValue] of Object.entries(value).slice(0, 50)) result[childKey] = safeValue(childKey, childValue);
		return result;
	}
	return value;
}

export interface ConsoleStructuredLoggerOptions {
	level?: StructuredLogLevel;
	write?: (line: string) => void;
}

export function createConsoleStructuredLogger(options: ConsoleStructuredLoggerOptions = {}): StructuredLogger {
	const threshold = LEVELS[options.level ?? "info"];
	const write = options.write ?? ((line: string) => stderr.write(`${line}\n`));
	return {
		log(level, event, fields = {}) {
			if (LEVELS[level] < threshold) return;
			const payload: Record<string, unknown> = { timestamp: new Date().toISOString(), level, event, service: "wuming-gateway", pid: process.pid };
			for (const [key, value] of Object.entries(fields)) payload[key] = safeValue(key, value);
			write(JSON.stringify(payload));
		},
	};
}
