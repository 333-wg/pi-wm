import { describe, expect, it } from "vitest";
import {
	hasGatewayPermission,
	parseGatewayTokenEntries,
	StaticTokenMapAuth,
	type GatewayPrincipal,
} from "../src/auth.js";

const principal = (role?: GatewayPrincipal["role"]): GatewayPrincipal => ({
	id: "user",
	...(role === undefined ? {} : { role }),
	workspaces: [],
});

describe("Gateway role permissions", () => {
	it("preserves owner compatibility for existing principals", () => {
		expect(hasGatewayPermission(principal(), "admin")).toBe(true);
		expect(hasGatewayPermission(principal(), "workspace.write")).toBe(true);
	});
	it("separates viewer, member, and owner capabilities", () => {
		expect(hasGatewayPermission(principal("viewer"), "workspace.read")).toBe(true);
		expect(hasGatewayPermission(principal("viewer"), "workspace.write")).toBe(false);
		expect(hasGatewayPermission(principal("member"), "workspace.write")).toBe(true);
		expect(hasGatewayPermission(principal("member"), "admin")).toBe(false);
	});
	it("authenticates independent principals with independent roles", async () => {
		const auth = new StaticTokenMapAuth([
			{ token: "owner-token", principal: principal("owner") },
			{ token: "viewer-token", principal: principal("viewer") },
		]);
		expect(await auth.authenticate("owner-token")?.role).toBe("owner");
		expect(await auth.authenticate("viewer-token")?.role).toBe("viewer");
		expect(await auth.authenticate("wrong-token")).toBeUndefined();
		expect(await auth.authenticate(" viewer-token ")?.role).toBe("viewer");
		expect(
			() =>
				new StaticTokenMapAuth([
					{ token: "same", principal: principal("owner") },
					{ token: "same", principal: principal("viewer") },
				])
		).toThrow("tokens must be unique");
		expect(() => new StaticTokenMapAuth([{ token: "   ", principal: principal("viewer") }])).toThrow(
			"must not be empty"
		);
	});
	it("parses deployment token configuration without starting the gateway", () => {
		const entries = parseGatewayTokenEntries(
			JSON.stringify([{ token: "viewer", id: "v", role: "viewer", workspaceIds: ["w1"] }]),
			[
				{ id: "w1", name: "One", status: "ready", createdAt: 1, updatedAt: 1 },
				{ id: "w2", name: "Two", status: "ready", createdAt: 1, updatedAt: 1 },
			]
		);
		expect(entries[0]?.principal).toMatchObject({
			id: "v",
			role: "viewer",
			workspaces: [{ id: "w1" }],
		});
		expect(() => parseGatewayTokenEntries("{}", [])).toThrow("non-empty array");
		expect(() => parseGatewayTokenEntries(JSON.stringify([{ token: "x", id: "v", role: "admin" }]), [])).toThrow(
			"role is invalid"
		);
		expect(() => parseGatewayTokenEntries(JSON.stringify([{ token: "x", id: "v", workspaceIds: [1] }]), [])).toThrow(
			"workspaceIds is invalid"
		);
		expect(() =>
			parseGatewayTokenEntries(JSON.stringify([{ token: "x", id: "v", workspaceIds: ["missing"] }]), [])
		).toThrow("unknown workspace");
	});
});
