import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ComputerProcessRunner } from "./computer.js";

export interface SemanticWindow {
	id: string;
	pid: number;
	startedAt: string;
	title: string;
	process: string;
}

export type SemanticAction = "invoke" | "set_value" | "select" | "toggle" | "expand" | "collapse";
export interface SemanticElement {
	ref: string;
	runtimeId: number[];
	name: string;
	automationId: string;
	controlType: string;
	enabled: boolean;
	offscreen: boolean;
	actions: SemanticAction[];
	value?: string;
	valueFingerprint?: string;
	valueTruncated?: boolean;
	toggleState?: string;
	selected?: boolean;
	expandState?: string;
	depth: number;
}
export interface SemanticState {
	window: SemanticWindow;
	elements: SemanticElement[];
	truncated: boolean;
}
export interface SemanticSnapshot extends SemanticState {
	id: string;
	capturedAt: number;
}

/** System UIA patterns only: never silently degrade to synthetic mouse/keyboard input. */
export class WindowsSemanticDesktop {
	#binary: Promise<string> | undefined;
	constructor(
		private readonly directory: string,
		private readonly run: ComputerProcessRunner
	) {}

	async #compile(signal: AbortSignal): Promise<string> {
		const source = fileURLToPath(new URL("../runtime/ComputerUia.cs", import.meta.url));
		const digest = createHash("sha256")
			.update(await readFile(source))
			.digest("hex")
			.slice(0, 20);
		const binary = join(this.directory, `uia-${digest}.exe`);
		if (existsSync(binary)) return binary;
		await mkdir(this.directory, { recursive: true });
		const windows = process.env.SystemRoot ?? "C:\\Windows";
		const framework64 = join(windows, "Microsoft.NET", "Framework64", "v4.0.30319");
		const framework = existsSync(framework64) ? framework64 : join(windows, "Microsoft.NET", "Framework", "v4.0.30319");
		const temporary = join(this.directory, `uia-${randomUUID()}.exe`);
		try {
			await this.run(
				join(framework, "csc.exe"),
				[
					"/nologo",
					"/target:exe",
					`/out:${temporary}`,
					...["UIAutomationClient", "UIAutomationTypes", "WindowsBase"].map(
						(name) => `/r:${join(framework, "WPF", `${name}.dll`)}`
					),
					`/r:${join(framework, "System.Web.Extensions.dll")}`,
					source,
				],
				{ signal, timeoutMs: 30_000 }
			);
			signal.throwIfAborted();
			try {
				await rename(temporary, binary);
			} catch (error) {
				if (!existsSync(binary)) throw error;
			}
			return binary;
		} finally {
			await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
				if (error.code !== "ENOENT") throw error;
			});
		}
	}

	async call<T>(request: Record<string, unknown>, signal: AbortSignal): Promise<T> {
		this.#binary ??= this.#compile(signal).catch((error) => {
			this.#binary = undefined;
			throw error;
		});
		const binary = await this.#binary;
		signal.throwIfAborted();
		const output = await this.run(binary, [], { input: JSON.stringify(request), signal, timeoutMs: 18_000 });
		signal.throwIfAborted();
		const value = JSON.parse(output) as { ok: boolean; result: T; error?: string };
		if (!value.ok) throw new Error(value.error ?? "Windows UI Automation failed");
		return value.result;
	}
}

export function publicSemanticState(state: SemanticSnapshot) {
	return {
		...state,
		mode: "semantic" as const,
		elements: state.elements.map(
			({ runtimeId: _runtimeId, valueFingerprint: _valueFingerprint, ...element }) => element
		),
	};
}
