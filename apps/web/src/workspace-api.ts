import type { GitDiff, GitStatus, WorkspaceDirectory, WorkspaceFileView, WorkspaceSearch, WorkspaceSummary } from "@wuming/protocol";

async function responseError(response: Response, fallback: string): Promise<Error> {
	const value = await response.json().catch(() => ({})) as { error?: string };
	return new Error(value.error ?? `${fallback}，状态码 ${response.status}`);
}

async function get<T>(token: string, path: string, params: Record<string, string | undefined> = {}): Promise<T> {
	const search = new URLSearchParams();
	for (const [name, value] of Object.entries(params)) if (value !== undefined) search.set(name, value);
	const response = await fetch(`${path}${search.size ? `?${search}` : ""}`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	if (!response.ok) {
		throw await responseError(response, "工作区请求失败");
	}
	return response.json() as Promise<T>;
}

function workspacePath(workspaceId: string, suffix: string): string {
	return `/api/workspaces/${encodeURIComponent(workspaceId)}/${suffix}`;
}

export const workspaceApi = {
	async pickProject(token: string) {
		const response = await fetch("/api/projects/pick", {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: "{}",
		});
		if (!response.ok) throw await responseError(response, "打开项目失败");
		return response.json() as Promise<{ project: WorkspaceSummary }>;
	},
	async createProject(token: string, name: string) {
		const response = await fetch("/api/projects", {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify({ name }),
		});
		if (!response.ok) throw await responseError(response, "创建项目失败");
		return response.json() as Promise<{ project: WorkspaceSummary }>;
	},
	async uploadProjectFile(token: string, projectId: string, path: string, file: File) {
		const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/files`, {
			method: "PUT",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": file.type || "application/octet-stream",
				"X-Wuming-Project-Path": encodeURIComponent(path),
			},
			body: file,
		});
		if (!response.ok) throw await responseError(response, `导入 ${path} 失败`);
	},
	async completeProject(token: string, projectId: string) {
		const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/complete`, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}` },
		});
		if (!response.ok) throw await responseError(response, "完成项目导入失败");
		return response.json() as Promise<{ project: WorkspaceSummary }>;
	},
	async renameProject(token: string, projectId: string, name: string) {
		const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}`, {
			method: "PATCH",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify({ name }),
		});
		if (!response.ok) throw await responseError(response, "重命名项目失败");
		return response.json() as Promise<{ project: WorkspaceSummary }>;
	},
	async removeProject(token: string, projectId: string) {
		const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}`, {
			method: "DELETE",
			headers: { Authorization: `Bearer ${token}` },
		});
		if (!response.ok) throw await responseError(response, "移除项目失败");
	},
	list(token: string, workspaceId: string, path = ".") {
		return get<WorkspaceDirectory>(token, workspacePath(workspaceId, "tree"), { path });
	},
	search(token: string, workspaceId: string, query: string, limit = 20) {
		return get<WorkspaceSearch>(token, workspacePath(workspaceId, "search"), { query, limit: String(limit) });
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
