import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OAuthCredential, Provider, ProviderAuthInteraction } from "@earendil-works/pi-ai";
import { OfficialAccountManager, OfficialCredentialStore, officialProviders } from "../src/official-accounts.js";

const roots: string[] = [];
const managers: OfficialAccountManager[] = [];
afterEach(async () => {
	await Promise.all(managers.splice(0).map((manager) => manager.dispose()));
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
	vi.restoreAllMocks();
});
const credential = (expires = Date.now() + 3_600_000): OAuthCredential => ({
	type: "oauth",
	access: "private-access",
	refresh: "private-refresh",
	expires,
});
async function setup(login?: (interaction: ProviderAuthInteraction) => Promise<OAuthCredential>, timeout?: number) {
	const root = await mkdtemp(join(tmpdir(), "wuming-official-"));
	roots.push(root);
	const key = randomBytes(32);
	const store = new OfficialCredentialStore(join(root, "accounts.enc"), key);
	await store.load();
	const base = officialProviders()[0]!;
	const provider: Provider = login ? { ...base, auth: { oauth: { ...base.auth.oauth!, login } } } : base;
	const manager = new OfficialAccountManager(store, [provider], timeout);
	managers.push(manager);
	return { root, key, store, manager, provider };
}
const manualLogin = async (interaction: ProviderAuthInteraction) => {
	interaction.notify({ type: "auth_url", url: "https://claude.ai/oauth/authorize?state=expected" });
	await interaction.prompt({ type: "manual_code", message: "callback" });
	return credential();
};

describe("official credentials", () => {
	it("persists encrypted credentials, reloads and deletes without plaintext", async () => {
		const { root, key, store } = await setup();
		await store.modify("official-claude", async () => credential());
		const text = await readFile(join(root, "accounts.enc"), "utf8");
		expect(text).not.toContain("private-access");
		expect(text).not.toContain("private-refresh");
		const restored = new OfficialCredentialStore(join(root, "accounts.enc"), key);
		await restored.load();
		expect(await restored.read("official-claude")).toMatchObject({ access: "private-access" });
		const copy = await restored.read("official-claude");
		if (copy?.type === "oauth") copy.access = "changed";
		expect(await restored.read("official-claude")).toMatchObject({ access: "private-access" });
		await restored.delete("official-claude");
		await restored.load();
		expect(await restored.list()).toEqual([]);
	});
	it("fails closed for wrong keys, corruption and invalid provider IDs", async () => {
		const { root, store } = await setup();
		await expect(store.modify("custom-relay", async () => credential())).rejects.toThrow("Unknown");
		await store.modify("official-claude", async () => credential());
		await expect(new OfficialCredentialStore(join(root, "accounts.enc"), randomBytes(32)).load()).rejects.toThrow(
			"Cannot decrypt"
		);
		await writeFile(join(root, "accounts.enc"), "broken");
		await expect(store.load()).rejects.toThrow("Cannot decrypt");
	});
	it("serializes rotation against logout and does not lose other providers", async () => {
		const { store } = await setup();
		await store.modify("official-claude", async () => credential());
		let release!: () => void;
		const barrier = new Promise<void>((resolve) => {
			release = resolve;
		});
		const refresh = store.modify("official-claude", async () => {
			await barrier;
			return { ...credential(), access: "rotated" };
		});
		const logout = store.delete("official-claude");
		const other = store.modify("official-grok", async () => credential());
		release();
		await Promise.all([refresh, logout, other]);
		expect(await store.read("official-claude")).toBeUndefined();
		expect(await store.read("official-grok")).toBeDefined();
	});
});

describe("official authorization lifecycle", () => {
	it("validates manual state, publishes models only after login and redacts tokens", async () => {
		const { manager } = await setup(manualLogin);
		expect(manager.list()).toEqual([]);
		await manager.start("official-claude");
		await vi.waitFor(() => expect(manager.accounts()[0]?.login?.manualCode).toBe(true));
		const loginId = manager.accounts()[0]!.login!.id;
		expect(() =>
			manager.submit("official-claude", loginId, "http://localhost/callback?code=secret&state=wrong")
		).toThrow("state");
		expect(() => manager.submit("official-claude", "stale", "anything")).toThrow("no longer");
		manager.submit("official-claude", loginId, "http://localhost/callback?code=secret&state=expected");
		await vi.waitFor(() => expect(manager.accounts()[0]?.login?.status).toBe("complete"));
		expect(manager.list().length).toBeGreaterThan(0);
		expect(JSON.stringify(manager.accounts())).not.toMatch(/private-access|private-refresh|authorizeUrl|userCode/);
		await manager.logout("official-claude");
		expect(manager.list()).toEqual([]);
	});
	it("cancels old sessions on restart, rejects replay and aborts pending login on logout", async () => {
		const { manager, store } = await setup(manualLogin);
		await manager.start("official-claude");
		await vi.waitFor(() => expect(manager.accounts()[0]?.login?.manualCode).toBe(true));
		const old = manager.accounts()[0]!.login!.id;
		await manager.start("official-claude");
		await vi.waitFor(() => expect(manager.accounts()[0]?.login?.manualCode).toBe(true));
		expect(manager.accounts()[0]!.login!.id).not.toBe(old);
		await expect(manager.cancel("official-claude", old)).rejects.toThrow("no longer");
		await manager.logout("official-claude");
		expect(await store.list()).toEqual([]);
		expect(manager.accounts()[0]?.login).toBeUndefined();
	});
	it("expires pending prompts and never leaks upstream errors", async () => {
		const { manager } = await setup(manualLogin, 20);
		await manager.start("official-claude");
		await vi.waitFor(() => expect(manager.accounts()[0]?.login?.status).toBe("error"));
		expect(manager.accounts()[0]?.login?.error).toContain("timed out");
		const bad = await setup(async () => {
			throw new Error("private-refresh and private-access");
		});
		await bad.manager.start("official-claude");
		await vi.waitFor(() => expect(bad.manager.accounts()[0]?.login?.status).toBe("error"));
		expect(JSON.stringify(bad.manager.accounts())).not.toContain("private-");
	});
	it("rejects authorization URLs outside the provider allowlist", async () => {
		const { manager, store } = await setup(async (interaction) => {
			interaction.notify({ type: "auth_url", url: "https://attacker.invalid/login" });
			return credential();
		});
		await manager.start("official-claude");
		await vi.waitFor(() => expect(manager.accounts()[0]?.login?.status).toBe("error"));
		expect(await store.list()).toEqual([]);
		expect(JSON.stringify(manager.accounts())).not.toContain("attacker");
	});
	it("supports device-code notifications and ChatGPT method selection", async () => {
		const { root, store } = await setup();
		const base = officialProviders()[1]!;
		let selected: string | undefined;
		const manager = new OfficialAccountManager(store, [
			{
				...base,
				auth: {
					oauth: {
						...base.auth.oauth!,
						login: async (interaction) => {
							selected = await interaction.prompt({ type: "select", message: "method", options: [] });
							interaction.notify({
								type: "device_code",
								verificationUri: "https://auth.openai.com/codex/device",
								userCode: "ABCD-1234",
							});
							await new Promise((_, reject) =>
								interaction.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true })
							);
							return credential();
						},
					},
				},
			},
		]);
		managers.push(manager);
		await manager.start("official-chatgpt", "device_code");
		await vi.waitFor(() => expect(manager.accounts()[0]?.login?.userCode).toBe("ABCD-1234"));
		expect(selected).toBe("device_code");
		await manager.cancel("official-chatgpt", manager.accounts()[0]!.login!.id);
		expect(manager.accounts()[0]?.login?.status).toBe("cancelled");
		expect(manager.accounts()[0]?.login?.userCode).toBeUndefined();
		expect(root).toBeTruthy();
	});
});

describe("official runtime integration", () => {
	it("shares rotation across runtimes, preserves it on disk and stops resolving after logout", async () => {
		const { root, key, store, provider } = await setup();
		const refresh = vi.fn(async () => {
			await new Promise((resolve) => setTimeout(resolve, 10));
			return credential();
		});
		const manager = new OfficialAccountManager(store, [
			{ ...provider, auth: { oauth: { ...provider.auth.oauth!, refresh } } },
		]);
		managers.push(manager);
		await store.modify("official-claude", async () => credential(0));
		const a = await manager.createRuntime(root, "official-claude");
		const b = await manager.createRuntime(root, "official-claude");
		const auth = await Promise.all([a.getAuth("official-claude"), b.getAuth("official-claude")]);
		expect(refresh).toHaveBeenCalledTimes(1);
		expect(auth[0]?.auth.apiKey).toBe("private-access");
		const restored = new OfficialCredentialStore(join(root, "accounts.enc"), key);
		await restored.load();
		expect((await restored.read("official-claude"))?.type).toBe("oauth");
		await manager.logout("official-claude");
		expect(await a.getAuth("official-claude")).toBeUndefined();
	});
	it("registers all subscription models on native APIs with isolated credentials", async () => {
		const { root, store } = await setup();
		const manager = new OfficialAccountManager(store);
		managers.push(manager);
		for (const provider of officialProviders()) await store.modify(provider.id, async () => credential());
		const runtime = await manager.createRuntime(root, "official-chatgpt");
		for (const [provider, api] of [
			["official-claude", "anthropic-messages"],
			["official-chatgpt", "openai-codex-responses"],
			["official-grok", "openai-responses"],
		]) {
			const model = runtime.getModels(provider)[0]!;
			expect(model).toBeDefined();
			expect(model.provider).toBe(provider);
			expect(model.api).toBe(api);
			expect(runtime.getProvider(provider!)?.auth.apiKey).toBeUndefined();
			expect((await runtime.getAuth(model))?.auth.apiKey).toBe("private-access");
		}
		await expect(readFile(join(root, "auth.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
	});
});
