import type { WorkspaceSummary } from "@wuming/protocol";

export const IMPLICIT_WORKSPACE_ID = "local-workspace";

/** The gateway needs a directory even when the user has not opened a project. */
export function isImplicitWorkspace(workspace: Pick<WorkspaceSummary, "id"> | undefined): boolean {
	return workspace?.id === IMPLICIT_WORKSPACE_ID;
}
