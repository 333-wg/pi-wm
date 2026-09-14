import type {
	WorkspaceGlobResult,
	WorkspaceGrepOptions,
	WorkspaceGrepResult,
	WorkspaceListing,
} from "./workspace-search.js";
import type { EnvironmentInspector } from "./environment.js";

export interface ReadTextOptions {
	offset?: number;
	limit?: number;
}

export interface ReadTextResult {
	content: string;
	bytesRead: number;
	totalBytes: number;
	truncated: boolean;
}

export interface EditTextOptions {
	replaceAll?: boolean;
}

export interface WorkspaceFiles {
	readonly root: string;
	readFile?(path: string): Promise<Buffer>;
	readText(path: string, options?: ReadTextOptions): Promise<ReadTextResult>;
	writeText(path: string, content: string): Promise<{ bytesWritten: number }>;
	writeTextIfUnchanged?(path: string, content: string, expectedSha256: string): Promise<{ bytesWritten: number }>;
	editText(
		path: string,
		oldText: string,
		newText: string,
		options?: EditTextOptions
	): Promise<{ bytesWritten: number; replacements: number }>;
}

export interface ProcessResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
	truncated: boolean;
	timedOut: boolean;
}

export interface ProcessSandbox {
	/**
	 * Whether commands can reach the network. The model is told, because it
	 * decides between installing a dependency and working with what is present.
	 */
	readonly networkAccess?: boolean;
	/** Executable used by run_python for this backend. */
	readonly pythonExecutable?: string;
	exec(
		command: string,
		options?: {
			timeoutMs?: number;
			signal?: AbortSignal;
			onOutput?: (chunk: string) => void;
		}
	): Promise<ProcessResult>;
}

export interface WebFetchOptions {
	signal?: AbortSignal;
	maxBytes?: number;
}

export interface WebFetchResult {
	requestedUrl: string;
	finalUrl: string;
	status: number;
	contentType: string;
	content: string;
	truncated: boolean;
}

export interface WebSearchOptions {
	count?: number;
	signal?: AbortSignal;
}

export interface WebSearchResult {
	provider: string;
	items: Array<{
		title: string;
		url: string;
		snippet: string;
	}>;
}

export interface WebSandbox {
	readonly searchHost: string | undefined;
	readonly searchSecretName: string | undefined;
	fetch(url: string, options?: WebFetchOptions): Promise<WebFetchResult>;
	search?(query: string, options?: WebSearchOptions): Promise<WebSearchResult>;
}

export interface BrowserTarget {
	ref?: string;
	selector?: string;
	role?: string;
	name?: string;
	text?: string;
}

export type BrowserAction =
	| { action: "click" | "hover" | "check" | "uncheck"; target: BrowserTarget }
	| { action: "fill" | "type"; target: BrowserTarget; value: string }
	| { action: "press"; key: string; target?: BrowserTarget }
	| { action: "select"; target: BrowserTarget; values: string[] }
	| { action: "scroll"; deltaX?: number; deltaY?: number; target?: BrowserTarget }
	| {
			action: "wait";
			timeoutMs: number;
			target?: BrowserTarget;
			state?: "attached" | "detached" | "visible" | "hidden";
	  }
	| { action: "back" | "forward" | "reload" }
	| { action: "new_tab"; url?: string }
	| { action: "switch_tab"; tabId: string }
	| { action: "close_tab"; tabId?: string };

export interface BrowserSnapshot {
	tabId: string;
	tabCount: number;
	url: string;
	title: string;
	text: string;
	interactiveCount: number;
	truncated: boolean;
}

export interface BrowserTab {
	id: string;
	url: string;
	title: string;
	active: boolean;
}

export interface BrowserDiagnostics {
	url: string;
	console: Array<{ level: string; text: string; timestamp: number }>;
	pageErrors: Array<{ message: string; timestamp: number }>;
	failedRequests: Array<{ method: string; url: string; error: string; timestamp: number }>;
	httpErrors: Array<{ method: string; url: string; status: number; timestamp: number }>;
}

export interface BrowserSearchItem {
	title: string;
	url: string;
	snippet: string;
}

export interface BrowserSearchResult {
	provider: string;
	query: string;
	url: string;
	items: BrowserSearchItem[];
}

export interface BrowserDownloadRequest {
	url?: string;
	target?: BrowserTarget;
	path?: string;
}

export interface BrowserDownloadResult {
	path: string;
	filename: string;
	url: string;
	title: string;
}

/** Isolated per agent session while preserving page and login state between calls. */
export interface BrowserAutomation {
	readonly searchHost?: string;
	open(
		url: string,
		options?: {
			width?: number;
			height?: number;
			waitUntil?: "commit" | "domcontentloaded" | "load" | "networkidle";
			signal?: AbortSignal;
		}
	): Promise<BrowserSnapshot>;
	snapshot(options?: { selector?: string; maxChars?: number }): Promise<BrowserSnapshot>;
	act(action: BrowserAction, signal?: AbortSignal): Promise<BrowserSnapshot>;
	screenshot(options?: {
		fullPage?: boolean;
		signal?: AbortSignal;
	}): Promise<{ image: Buffer; url: string; title: string }>;
	search?(query: string, options?: { count?: number; signal?: AbortSignal }): Promise<BrowserSearchResult>;
	currentHost?(): Promise<string | undefined>;
	download?(
		request: BrowserDownloadRequest,
		options: { workspaceRoot: string; signal?: AbortSignal }
	): Promise<BrowserDownloadResult>;
	diagnostics(clear?: boolean): Promise<BrowserDiagnostics>;
	tabs(): Promise<BrowserTab[]>;
	close(): Promise<void>;
}

export interface PreviewServerStatus {
	state: "stopped" | "starting" | "running" | "exited";
	command?: string;
	cwd?: string;
	url?: string;
	pid?: number;
	startedAt?: number;
	exitCode?: number | null;
	log: string;
	truncated: boolean;
}

/** One long-lived local preview process scoped to an agent session. */
export interface PreviewServerAutomation {
	start(
		command: string,
		options: { cwd?: string; url: string; timeoutMs?: number; signal?: AbortSignal }
	): Promise<PreviewServerStatus>;
	status(): Promise<PreviewServerStatus>;
	stop(): Promise<PreviewServerStatus>;
}

/**
 * Read-only navigation over the workspace tree. Structurally satisfied by
 * {@link WorkspaceSearcher}; declared separately so a deployment can substitute
 * its own implementation (a remote index, a language server) without depending
 * on the filesystem one.
 */
export interface WorkspaceSearchSandbox {
	list(path?: string, depth?: number): Promise<WorkspaceListing>;
	glob(pattern: string, options?: { path?: string; limit?: number }): Promise<WorkspaceGlobResult>;
	grep(pattern: string, options?: WorkspaceGrepOptions): Promise<WorkspaceGrepResult>;
}

export interface SandboxExecutor {
	files: WorkspaceFiles;
	environment?: EnvironmentInspector;
	process?: ProcessSandbox;
	web?: WebSandbox;
	search?: WorkspaceSearchSandbox;
	browser?: BrowserAutomation;
	preview?: PreviewServerAutomation;
}
