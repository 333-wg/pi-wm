import type {
	WorkspaceGlobResult,
	WorkspaceGrepOptions,
	WorkspaceGrepResult,
	WorkspaceListing,
} from "./workspace-search.js";

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
		options?: EditTextOptions,
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
	exec(
		command: string,
		options?: {
			timeoutMs?: number;
			signal?: AbortSignal;
			onOutput?: (chunk: string) => void;
		},
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
	process?: ProcessSandbox;
	web?: WebSandbox;
	search?: WorkspaceSearchSandbox;
}

