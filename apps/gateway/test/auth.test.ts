import type { WorkspaceSummary } from "@wuming/protocol";
import { describe, expect, it, test } from "vitest";
import { bearerProtocol, parseGatewayTokenEntries, StaticTokenAuth, tokenFromProtocols } from "../src/auth.js";

const workspace: WorkspaceSummary = {
	id: "workspace-1",
	name: "Workspace",
	status: "ready",
	createdAt: 1,
	updatedAt: 1,
};
const principal = { id: "user-1", workspaces: [workspace] };

test("configured principals cannot opt into unrestricted local-profile usage", () => {
	const [entry] = parseGatewayTokenEntries(
		JSON.stringify([
			{ token: "secret", id: "owner", role: "owner", workspaceIds: [workspace.id], allWorkspaceUsage: true },
		]),
		[workspace]
	);
	expect(entry?.principal.workspaces).toEqual([workspace]);
	expect(entry?.principal.allWorkspaceUsage).toBeUndefined();
});

test("normalizes static token whitespace and rejects empty credentials", () => {
	const auth = new StaticTokenAuth(" secret ", principal);
	expect(auth.authenticate("secret")?.id).toBe("user-1");
	expect(auth.authenticate(" secret ")?.id).toBe("user-1");
	expect(() => new StaticTokenAuth("   ", principal)).toThrow("must not be empty");
});

describe("StaticTokenAuth", () => {
	it("accepts the configured token and rejects every other one", () => {
		const auth = new StaticTokenAuth("secret", principal);

		expect(auth.authenticate("secret")).toBe(principal);
		// Same length, so a byte-by-byte comparison would bail out early here.
		expect(auth.authenticate("secrft")).toBeUndefined();
		// Different lengths reach `timingSafeEqual`, which throws unless both
		// sides are hashed to a fixed width first.
		expect(auth.authenticate("")).toBeUndefined();
		expect(auth.authenticate("secret-with-a-tail")).toBeUndefined();
		expect(auth.authenticate("Secret")).toBeUndefined();
	});
});

describe("bearer protocol", () => {
	it("round-trips a token through the WebSocket subprotocol header", () => {
		expect(tokenFromProtocols(bearerProtocol("secret"))).toBe("secret");
		expect(tokenFromProtocols(`chat, ${bearerProtocol("tokén/with+chars")}`)).toBe("tokén/with+chars");
	});

	it("returns nothing when the header is absent, unrelated, or empty", () => {
		expect(tokenFromProtocols(undefined)).toBeUndefined();
		expect(tokenFromProtocols("chat, superchat")).toBeUndefined();
		expect(tokenFromProtocols("wuming.bearer.")).toBeUndefined();
	});
});
