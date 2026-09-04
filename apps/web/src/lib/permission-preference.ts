import type { ApprovalPolicy, SandboxMode } from "@wuming/protocol";

export interface PermissionPreference {
	sandboxMode: SandboxMode;
	approvalPolicy: ApprovalPolicy;
}

export const PERMISSION_STORAGE_KEY = "wuming.permission";

export const DEFAULT_PERMISSION: PermissionPreference = {
	sandboxMode: "workspace_write",
	approvalPolicy: "on_risk",
};

const PERMISSIONS: readonly PermissionPreference[] = [
	{ sandboxMode: "workspace_write", approvalPolicy: "always" },
	DEFAULT_PERMISSION,
	{ sandboxMode: "unrestricted", approvalPolicy: "never" },
];

function isPermissionPreference(value: unknown): value is PermissionPreference {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Partial<PermissionPreference>;
	return PERMISSIONS.some((permission) =>
		permission.sandboxMode === candidate.sandboxMode
		&& permission.approvalPolicy === candidate.approvalPolicy,
	);
}

export function readStoredPermission(storage: Pick<Storage, "getItem"> | undefined): PermissionPreference {
	if (!storage) return DEFAULT_PERMISSION;
	try {
		const raw = storage.getItem(PERMISSION_STORAGE_KEY);
		if (!raw) return DEFAULT_PERMISSION;
		const value: unknown = JSON.parse(raw);
		return isPermissionPreference(value) ? value : DEFAULT_PERMISSION;
	} catch {
		return DEFAULT_PERMISSION;
	}
}

export function writeStoredPermission(storage: Pick<Storage, "setItem"> | undefined, value: PermissionPreference): void {
	if (!storage || !isPermissionPreference(value)) return;
	try {
		storage.setItem(PERMISSION_STORAGE_KEY, JSON.stringify(value));
	} catch {
		// The session policy still works when browser storage is unavailable.
	}
}
