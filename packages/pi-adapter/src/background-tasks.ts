import { randomUUID, createHash } from "node:crypto";
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { dirname, resolve, relative, isAbsolute } from "node:path";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { BackgroundTaskSchema, type BackgroundTask } from "@wuming/protocol";
import { Type } from "typebox";
import { Value } from "typebox/value";

type ToolResult = Awaited<ReturnType<ToolDefinition["execute"]>>;
type Context = Parameters<ToolDefinition["execute"]>[4];
export interface BackgroundCompletion {
	task: BackgroundTask;
	result: ToolResult;
}
interface Entry {
	task: BackgroundTask;
	resources: string[];
	digest: string;
	result?: ToolResult;
	controller?: AbortController;
	done?: Promise<void>;
	error?: unknown;
	inFlight?: boolean;
}

const eligible = (name: string) =>
	/^(exec|shell|run_python|web_fetch|web_search|generate_image|generate_video|get_generated_video)$/.test(name) ||
	name.startsWith("mcp__");
const workspaceTool = (name: string) => /^(exec|shell|run_python)$/.test(name) || name.startsWith("mcp__");
const textResult = (text: string): ToolResult => ({ content: [{ type: "text", text }], details: {} });
const preview = (result: ToolResult) =>
	result.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n")
		.slice(-8000);

export class BackgroundTasks {
	readonly #entries = new Map<string, Entry>();
	readonly #listeners = new Set<() => void>();
	#persisting: Promise<void> = Promise.resolve();
	#operation: { id: string; signal: AbortSignal } | undefined;
	#detachAbort: (() => void) | undefined;
	#disposed = false;
	constructor(
		readonly sessionId: string,
		readonly cwd: string,
		readonly journal: string
	) {}

	async restore(): Promise<void> {
		let saved: unknown;
		try {
			saved = JSON.parse(await readFile(this.journal, "utf8"));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		if (!Array.isArray(saved)) throw new Error("Invalid background task journal");
		for (const value of saved.slice(-64)) {
			if (!value || typeof value !== "object") continue;
			if (!Value.Check(BackgroundTaskSchema, value.task) || value.task.sessionId !== this.sessionId) continue;
			const entry: Entry = { task: value.task, resources: [], digest: "", result: value.result };
			if (entry.task.status === "running") {
				entry.task = {
					...entry.task,
					status: "interrupted",
					finishedAt: Date.now(),
					consumed: false,
					preview:
						"The host restarted. The previous operation may have side effects. Inspect its state; do not resubmit automatically.",
				};
				entry.result = textResult(entry.task.preview);
			}
			this.#entries.set(entry.task.id, entry);
		}
		await this.#persist();
	}

	list(): BackgroundTask[] {
		return [...this.#entries.values()].map(({ task }) => ({ ...task }));
	}
	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}
	#emit(): void {
		for (const listener of this.#listeners) listener();
	}
	#persist(): Promise<void> {
		const data = JSON.stringify([...this.#entries.values()].map(({ task, result }) => ({ task, result })));
		const write = this.#persisting
			.catch(() => {})
			.then(async () => {
				await mkdir(dirname(this.journal), { recursive: true });
				const temporary = `${this.journal}.${randomUUID()}.tmp`;
				await writeFile(temporary, data, "utf8");
				await rename(temporary, this.journal);
			});
		this.#persisting = write;
		return write;
	}
	begin(operationId: string, signal: AbortSignal): void {
		this.#detachAbort?.();
		this.#operation = { id: operationId, signal };
		const abort = () => {
			for (const entry of this.#entries.values()) if (entry.task.status === "running") this.#cancel(entry);
		};
		signal.addEventListener("abort", abort, { once: true });
		this.#detachAbort = () => signal.removeEventListener("abort", abort);
		if (signal.aborted) abort();
	}
	async end(): Promise<void> {
		this.#detachAbort?.();
		this.#detachAbort = undefined;
		this.#operation = undefined;
		for (const entry of this.#entries.values()) if (entry.task.status === "running") this.#cancel(entry);
		await Promise.allSettled([...this.#entries.values()].map((entry) => entry.done));
		await this.#persisting;
	}
	dispose(): void {
		this.#disposed = true;
		this.#detachAbort?.();
		for (const entry of this.#entries.values()) if (entry.task.status === "running") this.#cancel(entry);
	}
	#cancel(entry: Entry): void {
		entry.controller?.abort(
			new Error("Background task cancelled. A remote operation may still be running; do not resubmit.")
		);
	}
	async cancel(id: string): Promise<void> {
		const entry = this.#get(id);
		if (entry.task.status === "running") {
			this.#cancel(entry);
			await entry.done;
		}
	}
	#get(id: string): Entry {
		const entry = this.#entries.get(id);
		if (!entry) throw new Error("Background task does not belong to this session");
		return entry;
	}
	#path(path: string): string {
		const absolute = resolve(this.cwd, path);
		return process.platform === "win32" ? absolute.toLowerCase() : absolute;
	}
	#overlap(a: string, b: string): boolean {
		if (a === "*" || b === "*") return true;
		const within = (parent: string, child: string) => {
			const path = relative(parent, child);
			return path === "" || (!path.startsWith("..") && !isAbsolute(path));
		};
		return within(a, b) || within(b, a);
	}
	assertAvailable(resources: string[]): void {
		for (const entry of this.#entries.values()) {
			if (entry.task.status !== "running" && !entry.inFlight) continue;
			if (resources.some((a) => entry.resources.some((b) => this.#overlap(a, b))))
				throw new Error(
					`Resource is in use by background task ${entry.task.id}. Do independent work or use background_wait before accessing it.`
				);
		}
	}
	guard(tool: ToolDefinition): ToolDefinition {
		return {
			...tool,
			execute: async (...args) => {
				if (
					/^(read_file|write_file|edit|apply_patch|grep|glob|ls|exec|shell|run_python|browser_action|browser_batch|preview_start)$/.test(
						tool.name
					) ||
					tool.name.startsWith("mcp__")
				) {
					const params = args[1] as { path?: unknown };
					this.assertAvailable([typeof params?.path === "string" ? this.#path(params.path) : "*"]);
				}
				return tool.execute(...args);
			},
		};
	}
	async #wait(entry: Entry, ms: number, signal?: AbortSignal): Promise<void> {
		signal?.throwIfAborted();
		if (entry.task.status !== "running") return;
		await new Promise<void>((resolve, reject) => {
			const finish = () => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", abort);
				resolve();
			};
			const abort = () => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", abort);
				reject(signal?.reason);
			};
			const timer = setTimeout(finish, ms);
			signal?.addEventListener("abort", abort, { once: true });
			void entry.done?.then(finish, (error) => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", abort);
				reject(error);
			});
		});
	}
	async next(signal: AbortSignal): Promise<BackgroundCompletion[]> {
		while (true) {
			signal.throwIfAborted();
			const ready = [...this.#entries.values()].filter(
				(entry) => entry.task.status !== "running" && !entry.task.consumed && entry.result
			);
			if (ready.length) return ready.map((entry) => ({ task: { ...entry.task }, result: entry.result! }));
			if (![...this.#entries.values()].some((entry) => entry.task.status === "running")) return [];
			await new Promise<void>((resolve, reject) => {
				const done = () => {
					unsubscribe();
					signal.removeEventListener("abort", abort);
					resolve();
				};
				const abort = () => {
					unsubscribe();
					signal.removeEventListener("abort", abort);
					reject(signal.reason);
				};
				const unsubscribe = this.subscribe(done);
				signal.addEventListener("abort", abort, { once: true });
				if (signal.aborted) abort();
			});
		}
	}
	async consume(ids: string[]): Promise<void> {
		for (const id of ids) this.#get(id).task.consumed = true;
		await this.#persist();
		this.#emit();
	}
	async #result(entry: Entry): Promise<ToolResult> {
		if (entry.task.status === "running")
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify({
							taskId: entry.task.id,
							status: "running",
							next: "Continue independent work. Use background_wait only when this result is needed. Do not submit again.",
						}),
					},
				],
				details: { backgroundTask: { ...entry.task } },
			};
		await this.consume([entry.task.id]);
		if (entry.task.status !== "completed") throw entry.error ?? new Error(entry.task.preview);
		return entry.result!;
	}
	async start(
		tool: ToolDefinition,
		params: unknown,
		toolCallId: string,
		label: string,
		paths: string[] | undefined,
		yieldMs: number,
		timeoutSeconds: number,
		signal: AbortSignal | undefined,
		context: Context
	): Promise<ToolResult> {
		signal?.throwIfAborted();
		if (this.#disposed || !this.#operation) throw new Error("No active operation for background work");
		this.#operation.signal.throwIfAborted();
		const digest = createHash("sha256")
			.update(JSON.stringify([tool.name, params]))
			.digest("hex");
		const duplicate = [...this.#entries.values()].find(
			(entry) => entry.digest === digest && (entry.task.status === "running" || entry.task.toolCallId === toolCallId)
		);
		if (duplicate) return this.#result(duplicate);
		const running = [...this.#entries.values()].filter((entry) => entry.task.status === "running" || entry.inFlight);
		if (running.length >= 8)
			throw new Error("At most 8 background tasks may run in a session. Consume existing work first.");
		for (const [id, entry] of this.#entries) {
			if (this.#entries.size < 64) break;
			if (entry.task.consumed && !entry.inFlight && entry.task.status !== "running") this.#entries.delete(id);
		}
		if (this.#entries.size >= 64) throw new Error("Consume background results before creating more tasks");
		const resources = paths ? paths.map((path) => this.#path(path)) : workspaceTool(tool.name) ? ["*"] : [];
		this.assertAvailable(resources);
		const controller = new AbortController();
		const entry: Entry = {
			task: {
				id: randomUUID(),
				sessionId: this.sessionId,
				operationId: this.#operation.id,
				toolCallId,
				toolName: tool.name,
				label,
				status: "running",
				startedAt: Date.now(),
				preview: "",
				consumed: false,
			},
			resources,
			digest,
			controller,
		};
		this.#entries.set(entry.task.id, entry);
		try {
			await this.#persist();
		} catch (error) {
			this.#entries.delete(entry.task.id);
			throw error;
		}
		this.#emit();
		let lastUpdate = 0;
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			controller.abort(new Error("Background task exceeded its execution timeout. Inspect state before retrying."));
		}, timeoutSeconds * 1000);
		entry.inFlight = true;
		const work = Promise.resolve()
			.then(() => {
				controller.signal.throwIfAborted();
				return tool.execute(
					toolCallId,
					params,
					controller.signal,
					(result) => {
						if (entry.task.status !== "running") return;
						entry.task.preview = preview(result);
						if (Date.now() - lastUpdate >= 250) {
							lastUpdate = Date.now();
							this.#emit();
						}
					},
					context
				);
			})
			.finally(() => {
				entry.inFlight = false;
			});
		entry.done = (async () => {
			let detach = () => {};
			try {
				const cancelled = new Promise<never>((_resolve, reject) => {
					const abort = () => reject(controller.signal.reason);
					controller.signal.addEventListener("abort", abort, { once: true });
					detach = () => controller.signal.removeEventListener("abort", abort);
					if (controller.signal.aborted) abort();
				});
				entry.result = await Promise.race([work, cancelled]);
				const details = entry.result.details as
					{ exitCode?: unknown; timedOut?: boolean; wumingRecovery?: { status?: string } } | undefined;
				entry.task.status =
					details?.timedOut ||
					details?.exitCode === null ||
					details?.wumingRecovery?.status === "failed" ||
					(typeof details?.exitCode === "number" && details.exitCode !== 0)
						? "failed"
						: "completed";
				entry.task.preview = preview(entry.result);
			} catch (error) {
				entry.error = error;
				entry.task.status = timedOut ? "failed" : controller.signal.aborted ? "cancelled" : "failed";
				entry.task.preview = error instanceof Error ? error.message : String(error);
				entry.result = textResult(entry.task.preview);
			} finally {
				clearTimeout(timer);
				detach();
				entry.task.finishedAt = Date.now();
				try {
					await this.#persist();
				} finally {
					this.#emit();
				}
			}
		})();
		// Keep errors observable through end()/next(), without an unhandled rejection.
		void entry.done.catch(() => {});
		await this.#wait(entry, yieldMs, signal);
		if (entry.error && !entry.inFlight && /approval/i.test(String(entry.error)) && entry.task.status !== "running") {
			// Pre-execution approval failures must remain resumable through the original call.
			this.#entries.delete(entry.task.id);
			await this.#persist();
			this.#emit();
			throw entry.error;
		}
		return this.#result(entry);
	}

	tools(definitions: ToolDefinition[]): ToolDefinition[] {
		const available = definitions.filter((tool) => eligible(tool.name));
		if (!available.length) return [];
		return [
			defineTool({
				name: "background_start",
				label: "Start background task",
				executionMode: "sequential",
				description: `Run an independent, slow tool in the background without creating an agent. Available: ${available.map((tool) => tool.name).join(", ")}. Original validation and permissions still apply. Return a task ID after a short wait; continue independent work. Required results are automatically delivered before the operation ends. Use preview_start for persistent servers.`,
				promptSnippet: "Start a slow registered tool while continuing independent work",
				parameters: Type.Object(
					{
						tool: Type.String(),
						arguments: Type.Record(Type.String(), Type.Unknown()),
						label: Type.String({ minLength: 1, maxLength: 160 }),
						workspace_paths: Type.Optional(
							Type.Array(Type.String({ minLength: 1 }), {
								maxItems: 32,
								description:
									"All workspace paths read or written. Omit for an exclusive workspace lock on commands/MCP. Use [] only for operations wholly outside the workspace. These declarations coordinate work; they do not grant permissions.",
							})
						),
						yield_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: 10000 })),
						timeout_seconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 1200 })),
					},
					{ additionalProperties: false }
				),
				execute: async (id, args, signal, _update, context) => {
					const tool = available.find((tool) => tool.name === args.tool);
					if (!tool) throw new Error("This tool cannot run in the background");
					const params = tool.prepareArguments?.(args.arguments) ?? args.arguments;
					if (!Value.Check(tool.parameters, params)) throw new Error(`Invalid arguments for ${tool.name}`);
					return this.start(
						tool,
						params,
						id,
						args.label,
						args.workspace_paths,
						args.yield_ms ?? 1000,
						args.timeout_seconds ?? 1200,
						signal,
						context
					);
				},
			}),
			defineTool({
				name: "background_wait",
				label: "Read background result",
				executionMode: "parallel",
				description:
					"Read a background task result. Wait only when it is needed and no independent work remains. Never resubmit the original operation to check progress.",
				parameters: Type.Object({
					task_id: Type.String(),
					wait_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: 30000 })),
				}),
				execute: async (_id, args, signal) => {
					const entry = this.#get(args.task_id);
					await this.#wait(entry, args.wait_ms ?? 1000, signal);
					return this.#result(entry);
				},
			}),
			defineTool({
				name: "background_list",
				label: "List background tasks",
				executionMode: "parallel",
				description: "List this session's background task states without starting work.",
				parameters: Type.Object({}),
				execute: async () => textResult(JSON.stringify(this.list())),
			}),
			defineTool({
				name: "background_cancel",
				label: "Cancel background task",
				executionMode: "sequential",
				description:
					"Cancel a background task. Remote side effects may continue; cancellation is not permission to resubmit.",
				parameters: Type.Object({ task_id: Type.String() }),
				execute: async (_id, args) => {
					await this.cancel(args.task_id);
					return this.#result(this.#get(args.task_id));
				},
			}),
		];
	}
}
