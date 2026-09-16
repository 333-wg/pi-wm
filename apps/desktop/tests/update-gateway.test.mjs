import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { GatewayHost } from "../src/gateway-host.mjs";
import { openDesktopRpc } from "../../../scripts/lib/desktop-rpc.mjs";

function exchange(ws, message, type) {
 return new Promise((resolve, reject) => {
  const timer = setTimeout(() => { ws.off("message", receive); reject(new Error("Timed out: " + type)); }, 5_000);
  const receive = raw => {
   const result = JSON.parse(raw.toString());
   if (result.type !== type && result.type !== "terminal.error") return;
   clearTimeout(timer); ws.off("message", receive);
   if (result.type === "terminal.error") reject(new Error(result.message)); else resolve(result);
  };
  ws.on("message", receive); ws.send(JSON.stringify(message));
 });
}

test("real service blocks update preparation for open terminals and shuts down only when idle", { timeout: 30_000 }, async () => {
 const parent = await realpath(tmpdir());
 const root = await mkdtemp(join(parent, "wuming-update-gateway-"));
 const workspace = join(root, "workspace"); await mkdir(workspace);
 const host = new GatewayHost({ entry: fileURLToPath(new URL("../../gateway/dist/main.js", import.meta.url)), nodeExecutable: process.execPath,
  dataDirectory: join(root, "data"), workspace, runtime: "demo", startupTimeoutMs: 15_000 });
 let rpc, ws;
 try {
  const connection = await host.start();
  rpc = await openDesktopRpc(connection);
  const { workspaces } = await rpc.request({ type: "workspace.list" });
  ws = new WebSocket(connection.websocketUrl, ["wuming.v1", "wuming.bearer." + Buffer.from(connection.token).toString("base64url")], { origin: "wuming://app" });
  await once(ws, "open");
  await exchange(ws, { type: "hello", protocolVersion: 1, clientId: "update-terminal", capabilities: [] }, "hello");
  await exchange(ws, { type: "terminal.create", requestId: "create-terminal", terminalId: "update-terminal", workspaceId: workspaces[0].id, cols: 80, rows: 24 }, "terminal.ready");
  assert.equal((await host.updateStatus()).busy, true);
  assert.equal((await host.updateStatus(true)).busy, true);
  assert.equal(host.stopping, false);
  assert.equal((await fetch(connection.baseUrl + "/health")).status, 200);
  await exchange(ws, { type: "terminal.close", requestId: "close-terminal", terminalId: "update-terminal" }, "terminal.closed");
  await rpc.close(); rpc = undefined;
  ws.close(); await once(ws, "close");
  assert.equal((await host.updateStatus()).busy, false);
  assert.equal((await host.updateStatus(true)).busy, false);
  await host.stop();
  assert.equal(host.child.exitCode, 0);
  await assert.rejects(fetch(connection.baseUrl + "/health"));
 } finally {
  ws?.terminate(); await rpc?.close(); await host.stop();
  assert.equal(dirname(await realpath(root)), parent);
  await rm(root, { recursive: true, force: true });
 }
});
