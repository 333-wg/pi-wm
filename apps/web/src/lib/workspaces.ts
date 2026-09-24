import type { WorkspaceSummary } from "@wuming/protocol";

export const IMPLICIT_WORKSPACE_ID = "local-workspace";

/** The gateway needs a directory even when the user has not opened a project. */
export function isImplicitWorkspace(workspace: Pick<WorkspaceSummary, "id"> | undefined): boolean {
	return workspace?.id === IMPLICIT_WORKSPACE_ID;
}

export const PROJECT_ORDER_STORAGE_KEY = "wuming.projectOrder";

export function readProjectOrder(storage: Pick<Storage, "getItem">): string[] {
	try {
		const value: unknown = JSON.parse(storage.getItem(PROJECT_ORDER_STORAGE_KEY) ?? "[]");
		return Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === "string"))] : [];
	} catch {
		return [];
	}
}

/** Unknown/new projects retain their server order after the user's ordered projects. */
export function orderProjects(workspaces: readonly WorkspaceSummary[], order: readonly string[]): WorkspaceSummary[] {
	const ranks = new Map(order.map((id, index) => [id, index]));
	return workspaces
		.filter((workspace) => !isImplicitWorkspace(workspace))
		.sort((a, b) => (ranks.get(a.id) ?? order.length) - (ranks.get(b.id) ?? order.length));
}

/** Move to the target's slot, without changing selection or mutating the source list. */
export function moveProject(order: readonly string[], sourceId: string, targetId: string): string[] {
	const source = order.indexOf(sourceId);
	const target = order.indexOf(targetId);
	const next = [...order];
	if (source < 0 || target < 0 || source === target) return next;
	next.splice(source, 1);
	next.splice(target, 0, sourceId);
	return next;
}

export function writeProjectOrder(storage: Pick<Storage, "setItem">, order: readonly string[]): boolean {
	try {
		storage.setItem(PROJECT_ORDER_STORAGE_KEY, JSON.stringify(order));
		return true;
	} catch {
		return false;
	}
}

/** New chats inherit the current project unless the caller explicitly chooses another one. */
export function resolveNewChatWorkspace(
	workspaces: readonly WorkspaceSummary[],
	selectedWorkspaceId: string | undefined,
	requestedWorkspaceId?: string
): WorkspaceSummary | undefined {
	return (
		(requestedWorkspaceId ? workspaces.find((workspace) => workspace.id === requestedWorkspaceId) : undefined) ??
		(selectedWorkspaceId ? workspaces.find((workspace) => workspace.id === selectedWorkspaceId) : undefined) ??
		workspaces.find(isImplicitWorkspace) ??
		workspaces[0]
	);
}
