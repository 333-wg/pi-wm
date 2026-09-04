import { describe, expect, it } from "vitest";
import {
	DEFAULT_PERMISSION,
	PERMISSION_STORAGE_KEY,
	readStoredPermission,
	writeStoredPermission,
	type PermissionPreference,
} from "../src/lib/permission-preference.js";

function readableStorage(value: string | null, throws = false): Pick<Storage, "getItem"> {
	return {
		getItem() {
			if (throws) throw new Error("storage is blocked");
			return value;
		},
	};
}

describe("permission preference", () => {
	it("reads each supported permission", () => {
		const permissions: PermissionPreference[] = [
			{ sandboxMode: "workspace_write", approvalPolicy: "always" },
			{ sandboxMode: "workspace_write", approvalPolicy: "on_risk" },
			{ sandboxMode: "unrestricted", approvalPolicy: "never" },
		];
		for (const permission of permissions) {
			expect(readStoredPermission(readableStorage(JSON.stringify(permission)))).toEqual(permission);
		}
	});

	it("falls back when the stored value is missing, invalid, or inaccessible", () => {
		expect(readStoredPermission(readableStorage(null))).toEqual(DEFAULT_PERMISSION);
		expect(readStoredPermission(readableStorage("not json"))).toEqual(DEFAULT_PERMISSION);
		expect(readStoredPermission(readableStorage(JSON.stringify({ sandboxMode: "unrestricted", approvalPolicy: "always" })))).toEqual(DEFAULT_PERMISSION);
		expect(readStoredPermission(readableStorage(null, true))).toEqual(DEFAULT_PERMISSION);
		expect(readStoredPermission(undefined)).toEqual(DEFAULT_PERMISSION);
	});

	it("writes a valid selection and tolerates blocked storage", () => {
		const entries = new Map<string, string>();
		writeStoredPermission({ setItem: (key, value) => entries.set(key, value) }, { sandboxMode: "unrestricted", approvalPolicy: "never" });
		expect(entries.get(PERMISSION_STORAGE_KEY)).toBe(JSON.stringify({ sandboxMode: "unrestricted", approvalPolicy: "never" }));
		expect(() => writeStoredPermission({ setItem: () => { throw new Error("storage is blocked"); } }, DEFAULT_PERMISSION)).not.toThrow();
	});
});
