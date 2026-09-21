import { createHash, timingSafeEqual } from "node:crypto";
import type { WorkspaceSummary } from "@wuming/protocol";

export interface GatewayPrincipal {
	id: string;
	workspaces: WorkspaceSummary[];
	/** Only the single-user local profile may include hidden/unregistered workspaces in usage totals. */
	allWorkspaceUsage?: boolean;
	/** Optional role for deployments migrating from workspace-only auth. */
	role?: GatewayRole;
}

export type GatewayRole = "owner" | "member" | "viewer";
export type GatewayPermission = "workspace.read" | "workspace.write" | "admin";

export function parseGatewayTokenEntries(
	value: string,
	workspaces: WorkspaceSummary[]
): Array<{ token: string; principal: GatewayPrincipal }> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new Error("WUMING_AUTH_TOKENS_JSON must be valid JSON");
	}
	if (!Array.isArray(parsed) || parsed.length === 0)
		throw new Error("WUMING_AUTH_TOKENS_JSON must be a non-empty array");
	return parsed.map((entry, index) => {
		if (!entry || typeof entry !== "object") throw new Error("Invalid auth entry " + index);
		const candidate = entry as {
			token?: unknown;
			id?: unknown;
			role?: unknown;
			workspaceIds?: unknown;
		};
		if (typeof candidate.token !== "string" || typeof candidate.id !== "string")
			throw new Error("Auth entry requires token and id");
		if (
			candidate.role !== undefined &&
			candidate.role !== "owner" &&
			candidate.role !== "member" &&
			candidate.role !== "viewer"
		)
			throw new Error("Auth entry role is invalid");
		if (
			candidate.workspaceIds !== undefined &&
			(!Array.isArray(candidate.workspaceIds) || candidate.workspaceIds.some((id) => typeof id !== "string"))
		)
			throw new Error("Auth entry workspaceIds is invalid");
		const workspaceIds = candidate.workspaceIds as string[] | undefined;
		if (workspaceIds !== undefined && workspaceIds.some((id) => !workspaces.some((workspace) => workspace.id === id)))
			throw new Error("Auth entry workspaceIds references an unknown workspace");
		const allowed =
			workspaceIds === undefined ? workspaces : workspaces.filter((workspace) => workspaceIds.includes(workspace.id));
		return {
			token: candidate.token,
			principal: {
				id: candidate.id,
				...(candidate.role === undefined ? {} : { role: candidate.role }),
				workspaces: allowed,
			} as GatewayPrincipal,
		};
	});
}

const ROLE_PERMISSIONS: Record<GatewayRole, readonly GatewayPermission[]> = {
	owner: ["workspace.read", "workspace.write", "admin"],
	member: ["workspace.read", "workspace.write"],
	viewer: ["workspace.read"],
};

/** Backwards-compatible default: existing static-token deployments are owners. */
export function hasGatewayPermission(principal: GatewayPrincipal, permission: GatewayPermission): boolean {
	return ROLE_PERMISSIONS[principal.role ?? "owner"].includes(permission);
}

export interface GatewayAuth {
	authenticate(token: string): Promise<GatewayPrincipal | undefined> | GatewayPrincipal | undefined;
}

/**
 * Hashing first keeps the comparison fixed-width, so `timingSafeEqual` never
 * throws on a length mismatch and the token's length does not leak either.
 */
function fingerprint(token: string): Buffer {
	return createHash("sha256").update(token, "utf8").digest();
}

export class StaticTokenAuth implements GatewayAuth {
	readonly #fingerprint: Buffer;

	constructor(
		token: string,
		private readonly principal: GatewayPrincipal
	) {
		if (token.trim().length === 0) throw new Error("Authentication token must not be empty");
		this.#fingerprint = fingerprint(token.trim());
	}

	authenticate(token: string): GatewayPrincipal | undefined {
		// A `===` comparison returns as soon as two bytes differ, which tells a
		// caller how much of a guessed token was right.
		return timingSafeEqual(fingerprint(token.trim()), this.#fingerprint) ? this.principal : undefined;
	}
}

/** Multi-principal static-token adapter for small deployments and local IAM pilots. */
export class StaticTokenMapAuth implements GatewayAuth {
	readonly #tokens: Array<{ fingerprint: Buffer; principal: GatewayPrincipal }>;

	constructor(entries: ReadonlyArray<{ token: string; principal: GatewayPrincipal }>) {
		if (entries.length === 0) throw new Error("At least one authentication entry is required");
		const normalized = entries.map((entry) => ({ ...entry, token: entry.token.trim() }));
		if (normalized.some((entry) => entry.token.length === 0))
			throw new Error("Authentication tokens must not be empty");
		const fingerprints = normalized.map((entry) => fingerprint(entry.token));
		for (let index = 0; index < fingerprints.length; index += 1) {
			for (let other = index + 1; other < fingerprints.length; other += 1) {
				if (timingSafeEqual(fingerprints[index]!, fingerprints[other]!))
					throw new Error("Authentication tokens must be unique");
			}
		}
		this.#tokens = normalized.map((entry, index) => ({
			fingerprint: fingerprints[index]!,
			principal: entry.principal,
		}));
	}

	authenticate(token: string): GatewayPrincipal | undefined {
		const candidate = fingerprint(token.trim());
		for (const entry of this.#tokens) {
			if (timingSafeEqual(candidate, entry.fingerprint)) return entry.principal;
		}
		return undefined;
	}
}

export function bearerProtocol(token: string): string {
	return `wuming.bearer.${Buffer.from(token, "utf8").toString("base64url")}`;
}

export function tokenFromProtocols(header: string | undefined): string | undefined {
	if (!header) return undefined;
	const encoded = header
		.split(",")
		.map((value) => value.trim())
		.find((value) => value.startsWith("wuming.bearer."))
		?.slice("wuming.bearer.".length);
	if (!encoded) return undefined;
	try {
		return Buffer.from(encoded, "base64url").toString("utf8");
	} catch {
		return undefined;
	}
}
