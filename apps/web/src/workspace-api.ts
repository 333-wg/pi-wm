import type { GitDiff, GitStatus, WorkspaceDirectory, WorkspaceFileView } from "@wuming/protocol";

async function get<T>(token: string, path: string, params: Record<string, string | undefined> = {}): Promise<T> {
	const search = new URLSearchParams();
	for (const [name, value] of Object.entries(params)) if (value !== undefined) search.set(name, value);
	const response = await fetch(`${path}${search.size ? `?${search}` : ""}`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	if (!response.ok) {
		const value = await response.json().catch(() => ({})) as { error?: string };
		throw new Error(value.error ?? `工作区请求失败，状态码 ${response.status}`);
	}
	return response.json() as Promise<T>;
}

function workspacePath(workspaceId: string, suffix: string): string {
	return `/api/workspaces/${encodeURIComponent(workspaceId)}/${suffix}`;
}

export const workspaceApi = {
	list(token: string, workspaceId: string, path = ".") {
		return get<WorkspaceDirectory>(token, workspacePath(workspaceId, "tree"), { path });
	},
	read(token: string, workspaceId: string, path: string) {
		return get<WorkspaceFileView>(token, workspacePath(workspaceId, "file"), { path });
	},
	status(token: string, workspaceId: string) {
		return get<GitStatus>(token, workspacePath(workspaceId, "git/status"));
	},
	diff(token: string, workspaceId: string, path: string | undefined, staged: boolean) {
		return get<GitDiff>(token, workspacePath(workspaceId, "git/diff"), {
			path,
			staged: staged ? "true" : "false",
		});
	},
};
