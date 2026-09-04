import { createHash, timingSafeEqual } from "node:crypto";
import type { WorkspaceSummary } from "@wuming/protocol";

export interface GatewayPrincipal {
	id: string;
	workspaces: WorkspaceSummary[];
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
		private readonly principal: GatewayPrincipal,
	) {
		this.#fingerprint = fingerprint(token);
	}

	authenticate(token: string): GatewayPrincipal | undefined {
		// A `===` comparison returns as soon as two bytes differ, which tells a
		// caller how much of a guessed token was right.
		return timingSafeEqual(fingerprint(token), this.#fingerprint) ? this.principal : undefined;
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
