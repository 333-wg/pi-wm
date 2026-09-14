import type { WorkspaceSummary } from "@wuming/protocol";

export const IMPLICIT_WORKSPACE_ID = "local-workspace";

/** The gateway needs a directory even when the user has not opened a project. */
export function isImplicitWorkspace(workspace: Pick<WorkspaceSummary, "id"> | undefined): boolean {
	return workspace?.id === IMPLICIT_WORKSPACE_ID;
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
