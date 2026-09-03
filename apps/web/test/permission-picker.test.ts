import { describe, expect, it } from "vitest";
import { permissionMode } from "../src/components/PermissionPicker.js";

describe("permission mode", () => {
	it("maps persisted sandbox and approval settings to the three composer modes", () => {
		expect(permissionMode({ sandboxMode: "workspace_write", approvalPolicy: "always" })).toBe("ask");
		expect(permissionMode({ sandboxMode: "workspace_write", approvalPolicy: "on_risk" })).toBe("agent");
		expect(permissionMode({ sandboxMode: "unrestricted", approvalPolicy: "never" })).toBe("full");
	});

	it("keeps nonstandard safe combinations out of the full-access presentation", () => {
		expect(permissionMode({ sandboxMode: "read_only", approvalPolicy: "always" })).toBe("ask");
		expect(permissionMode({ sandboxMode: "unrestricted", approvalPolicy: "on_risk" })).toBe("agent");
	});
});
