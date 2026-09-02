import type { WorkspaceSummary } from "@wuming/protocol";

export interface GatewayPrincipal {
	id: string;
	workspaces: WorkspaceSummary[];
}

export interface GatewayAuth {
	authenticate(token: string): Promise<GatewayPrincipal | undefined> | GatewayPrincipal | undefined;
}

export class StaticTokenAuth implements GatewayAuth {
	constructor(
		private readonly token: string,
		private readonly principal: GatewayPrincipal,
	) {}

	authenticate(token: string): GatewayPrincipal | undefined {
		return token === this.token ? this.principal : undefined;
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
