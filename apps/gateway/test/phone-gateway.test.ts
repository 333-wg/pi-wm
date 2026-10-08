import { afterEach, expect, it } from "vitest";
import { startPhonePreview } from "./phone-preview.mjs";
import https from "node:https";
import WebSocket from "ws";
import type { Command, ServerMessage } from "@wuming/protocol";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const fn of cleanup.splice(0).reverse()) await fn();
});
function call(url: string, body?: unknown, cookie?: string) {
	return new Promise<{ status: number; value: any; cookie?: string | undefined }>((resolve, reject) => {
		// Only the isolated test fixture's self-signed certificate is accepted here.
		const req = https.request(
			url,
			{
				agent: false,
				rejectUnauthorized: false,
				method: body ? "POST" : "GET",
				headers: {
					Origin: new URL(url).origin,
					"Content-Type": "application/json",
					...(cookie ? { Cookie: cookie } : {}),
				},
			},
			(res) => {
				let data = "";
				res.on("data", (c) => (data += c));
				res.on("end", () =>
					resolve({
						status: res.statusCode!,
						value: JSON.parse(data),
						cookie: res.headers["set-cookie"]?.[0]?.split(";")[0],
					})
				);
			}
		);
		req.on("error", reject);
		req.end(body ? JSON.stringify(body) : undefined);
	});
}
it("uses the existing session, denies privileged commands, deduplicates retry, and invalidates a live socket", async () => {
	const f = await startPhonePreview();
	cleanup.push(() => f.close());
	await f.control("enable", { mode: "proxy", origin: f.origin, port: f.remotePort });
	const pair = await f.control("pairing", {});
	const p = await call(`${f.origin}/api/phone/pair`, { secret: new URL(pair.url).hash.slice(6), name: "Phone" });
	await f.control("approve", { id: p.value.id, workbench: true });
	const grant = await call(`${f.origin}/api/phone/claim`, p.value);
	const ws = new WebSocket(`${f.origin.replace("https", "wss")}/api/ws`, ["wuming.v1"], {
		rejectUnauthorized: false,
		origin: f.origin,
		headers: { Cookie: grant.cookie! },
	});
	cleanup.push(() => ws.terminate());
	const messages: ServerMessage[] = [];
	ws.on("message", (m) => messages.push(JSON.parse(String(m))));
	await new Promise<void>((resolve, reject) => {
		ws.once("open", resolve);
		ws.once("error", reject);
	});
	ws.send(JSON.stringify({ type: "hello", protocolVersion: 1, clientId: "phone-test", capabilities: [] }));
	await expect.poll(() => messages.some((m) => m.type === "hello")).toBe(true);
	const request = async (command: Command, key = crypto.randomUUID()) => {
		const id = crypto.randomUUID();
		ws.send(JSON.stringify({ type: "request", requestId: id, idempotencyKey: key, command }));
		await expect.poll(() => messages.find((m) => m.type === "response" && m.requestId === id)).toBeTruthy();
		return messages.find((m) => m.type === "response" && m.requestId === id)!;
	};
	expect(await request({ type: "session.attach", sessionId: f.sessionId })).toMatchObject({
		ok: true,
		result: { snapshot: { session: { id: f.sessionId } } },
	});
	expect(await request({ type: "session.list", workspaceId: "not-granted" })).toMatchObject({
		ok: false,
		error: { code: "forbidden" },
	});
	expect(await request({ type: "model.custom.service.list" })).toMatchObject({
		ok: false,
		error: { code: "forbidden" },
	});
	const create: Extract<Command, { type: "session.create" }> = {
		type: "session.create",
		workspaceId: "phone-project",
		model: { provider: "demo", id: "demo-model" },
		name: "手机创建",
		thinkingLevel: "off",
		sandboxMode: "workspace_write",
		approvalPolicy: "on_risk",
	};
	for (const invalid of [
		{ ...create, workspaceId: "not-granted" },
		{ ...create, approvalPolicy: "never" as const },
		{ ...create, model: { provider: "arbitrary", id: "unknown" } },
	])
		expect(await request(invalid)).toMatchObject({ ok: false, error: { code: "forbidden" } });
	const createKey = crypto.randomUUID();
	const created = await request(create, createKey);
	expect(created).toMatchObject({
		ok: true,
		result: { type: "session.created", snapshot: { sandboxMode: "workspace_write", approvalPolicy: "on_risk" } },
	});
	expect(await request(create, createKey)).toEqual(expect.objectContaining({ ok: true }));
	expect(await request({ type: "session.rename", sessionId: f.sessionId, name: "手机重命名" })).toMatchObject({
		ok: true,
	});
	expect(await request({ type: "session.archive", sessionId: f.sessionId, archived: true })).toMatchObject({
		ok: true,
	});
	expect(await request({ type: "session.archive", sessionId: f.sessionId, archived: false })).toMatchObject({
		ok: true,
	});
	expect(await request({ type: "session.thinking.set", sessionId: f.sessionId, thinkingLevel: "high" })).toMatchObject({
		ok: true,
	});
	expect(f.snapshot().thinkingLevel).toBe("high");
	expect(
		await request({ type: "session.model.set", sessionId: f.sessionId, model: { provider: "unknown", id: "x" } })
	).toMatchObject({ ok: false, error: { code: "forbidden" } });
	expect(await request({ type: "skill.list", workspaceId: "phone-project" })).toMatchObject({
		ok: true,
		result: { skills: [{ id: "phone-check" }] },
	});
	expect(await request({ type: "skill.list", workspaceId: "not-granted" })).toMatchObject({ ok: false });
	expect((await call(`${f.origin}/api/workspaces/not-granted/artifacts`, {}, grant.cookie)).status).toBe(403);
	expect(
		await request({
			type: "session.policy.set",
			sessionId: f.sessionId,
			sandboxMode: "unrestricted",
			approvalPolicy: "never",
		})
	).toMatchObject({ ok: false, error: { code: "forbidden" } });
	const key = crypto.randomUUID(),
		command: Command = {
			type: "turn.prompt",
			sessionId: f.sessionId,
			content: [{ type: "text", text: "same command" }],
		};
	expect(await request(command, key)).toMatchObject({ ok: true });
	expect(await request(command, key)).toMatchObject({ ok: true });
	await expect.poll(() => f.snapshot().session.phase, { timeout: 5000 }).toBe("idle");
	expect(f.snapshot().transcript.filter((i) => i.type === "user")).toHaveLength(1);
	const authorization = f.authorize({ type: "process.exec", executable: "fixture-no-execution", args: [] });
	await expect.poll(() => f.snapshot().pendingApprovals.length).toBe(1);
	const approval = f.snapshot().pendingApprovals[0]!;
	expect(
		await request({ type: "approval.respond", sessionId: f.sessionId, approvalId: approval.id, decision: "approve" })
	).toMatchObject({
		ok: true,
		result: { approval: { decidedBy: `preview-owner:phone:${p.value.id}`, status: "approved" } },
	});
	await authorization;
	const desktopApproval = f.authorize({ type: "computer.use", action: "input" }).catch(() => undefined);
	await expect.poll(() => f.snapshot().pendingApprovals.length).toBe(1);
	expect(
		await request({
			type: "approval.respond",
			sessionId: f.sessionId,
			approvalId: f.snapshot().pendingApprovals[0]!.id,
			decision: "approve",
		})
	).toMatchObject({ ok: false, error: { code: "forbidden" } });
	void desktopApproval;
	const closed = new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)));
	await f.control("revoke", { id: p.value.id });
	expect(await closed).toBe(1008);
	expect((await call(`${f.origin}/api/phone/session`, undefined, grant.cookie)).value.authenticated).toBe(false);
}, 20_000);
