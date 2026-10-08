import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mock.spawn }));
import { PhoneTunnel } from "../src/phone-tunnel.js";
afterEach(() => {
	vi.useRealTimers();
	mock.spawn.mockReset();
});
it("starts only an explicit executable with isolated configuration, detects readiness and stops without publishing itself", () => {
	const root = mkdtempSync(join(tmpdir(), "phone-tunnel-test-"));
	try {
		const executable = join(root, "cloudflared.exe");
		writeFileSync(executable, "fixture");
		const child = Object.assign(new EventEmitter(), {
			stdout: new EventEmitter(),
			stderr: new EventEmitter(),
			exitCode: null,
			signalCode: null,
			kill: vi.fn(() => {
				child.emit("close", 0);
				return true;
			}),
		});
		mock.spawn.mockReturnValue(child);
		const tunnel = new PhoneTunnel(),
			origins: (string | undefined)[] = [];
		expect(mock.spawn).not.toHaveBeenCalled();
		tunnel.start(executable, 12345, (value) => origins.push(value));
		const [program, args, options] = mock.spawn.mock.calls[0]!;
		expect(program).toBe(executable);
		expect(options.shell).toBe(false);
		expect(args).toContain("http://127.0.0.1:12345");
		const config = args[args.indexOf("--config") + 1];
		expect(readFileSync(config, "utf8")).toBe("{}\n");
		child.stderr.emit("data", Buffer.from("https://fixture.trycloudflare.com\n"));
		expect(tunnel.state).toBe("connecting");
		expect(tunnel.attempt).toBe(1);
		expect(tunnel.stage).toContain("已分配地址，等待边缘连接");
		expect(tunnel.stage).toContain("HTTP/2");
		child.stderr.emit("data", Buffer.from("Registered tunnel connection\n"));
		expect(tunnel.state).toBe("ready");
		expect(origins.at(-1)).toBe("https://fixture.trycloudflare.com");
		tunnel.stop();
		expect(child.kill).toHaveBeenCalledOnce();
		expect(tunnel.state).toBe("off");
		expect(existsSync(config)).toBe(false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
it("reports sanitized failures and exhausts bounded retries without publishing an unready URL", () => {
	vi.useFakeTimers();
	const root = mkdtempSync(join(tmpdir(), "phone-tunnel-retries-"));
	const tunnel = new PhoneTunnel();
	try {
		const executable = join(root, "cloudflared.exe");
		writeFileSync(executable, "fixture");
		mock.spawn.mockImplementation(() => {
			const child = Object.assign(new EventEmitter(), {
				stdout: new EventEmitter(),
				stderr: new EventEmitter(),
				exitCode: null,
				signalCode: null,
				kill: vi.fn(() => {
					child.emit("close", 1);
					return true;
				}),
			});
			return child;
		});
		tunnel.start(executable, 12345, () => {});
		for (let i = 0; i < 4; i++) {
			const child = mock.spawn.mock.results[i]!.value;
			child.stderr.emit(
				"data",
				Buffer.from("https://fixture.trycloudflare.com\nfailed to dial private-path token=secret timeout\n")
			);
			expect(tunnel.error).toContain("7844");
			expect(tunnel.error).not.toContain("secret");
			vi.advanceTimersByTime(20000);
			if (i < 3) {
				expect(tunnel.stage).toContain("等待重试");
				vi.advanceTimersByTime(1000 * 2 ** (i + 1));
			}
		}
		expect(mock.spawn).toHaveBeenCalledTimes(4);
		expect(
			mock.spawn.mock.calls.map(([, args]) => [
				args[args.indexOf("--protocol") + 1],
				args[args.indexOf("--edge-ip-version") + 1],
			])
		).toEqual([
			["http2", "auto"],
			["quic", "auto"],
			["http2", "4"],
			["quic", "4"],
		]);
		expect(tunnel.stage).toContain("重试已用尽");
		expect(tunnel.url).toBeUndefined();
		vi.advanceTimersByTime(120000);
		expect(mock.spawn).toHaveBeenCalledTimes(4);
	} finally {
		tunnel.stop();
		rmSync(root, { recursive: true, force: true });
	}
});
it("switches early only after separated repeated edge failures and a five-second grace", () => {
	const f = fixture();
	try {
		const first = f.child();
		first.stderr.emit("data", Buffer.from("https://fixture.trycloudflare.com\nconnection reset\nconnection reset\n"));
		expect(first.kill).not.toHaveBeenCalled();
		vi.advanceTimersByTime(4999);
		expect(first.kill).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		first.stderr.emit("data", Buffer.from("TLS handshake timeout\n"));
		expect(first.kill).toHaveBeenCalledOnce();
		expect(f.tunnel.stage).toContain("QUIC");
		vi.advanceTimersByTime(1999);
		expect(mock.spawn).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(1);
		expect(mock.spawn).toHaveBeenCalledTimes(2);
	} finally {
		f.clean();
	}
});

it("bounds provisioning retries without cycling unrelated edge transports", () => {
	const f = fixture();
	try {
		for (let i = 0; i < 4; i++) {
			vi.advanceTimersByTime(19999);
			expect(f.child().kill).not.toHaveBeenCalled();
			vi.advanceTimersByTime(1);
			expect(f.child().kill).toHaveBeenCalledOnce();
			if (i < 3) {
				expect(f.tunnel.stage).toContain("不切换边缘协议");
				vi.advanceTimersByTime(1000 * 2 ** (i + 1));
			}
		}
		expect(mock.spawn).toHaveBeenCalledTimes(4);
		for (const [, args] of mock.spawn.mock.calls) expect(args[args.indexOf("--protocol") + 1]).toBe("http2");
		expect(f.tunnel.stage).toContain("临时入口申请重试已用尽");
		expect(f.tunnel.nextRetryAt).toBeUndefined();
	} finally {
		f.clean();
	}
});

it("keeps a connection that recovers after one transient error", () => {
	const f = fixture();
	try {
		f.child().stderr.emit("data", Buffer.from("https://fixture.trycloudflare.com\nconnection reset\n"));
		vi.advanceTimersByTime(6000);
		f.child().stderr.emit("data", Buffer.from("Registered tunnel connection\n"));
		f.child().stderr.emit("data", Buffer.from("connection reset\n"));
		vi.advanceTimersByTime(60000);
		expect(f.tunnel.state).toBe("ready");
		expect(f.child().kill).not.toHaveBeenCalled();
		expect(mock.spawn).toHaveBeenCalledTimes(1);
	} finally {
		f.clean();
	}
});

it("terminates unsupported flags immediately without waiting for the timeout", () => {
	const f = fixture();
	try {
		const child = f.child();
		child.stderr.emit("data", Buffer.from("unknown flag: private\n"));
		expect(child.kill).toHaveBeenCalledOnce();
		expect(f.tunnel.stage).toContain("启动失败");
		vi.advanceTimersByTime(60000);
		expect(mock.spawn).toHaveBeenCalledTimes(1);
	} finally {
		f.clean();
	}
});

it("rejects arbitrary programs before spawning", () => {
	const tunnel = new PhoneTunnel();
	expect(() => tunnel.start("cmd.exe", 12345, () => {})).toThrow();
	expect(() => tunnel.start(join(tmpdir(), "not-cloudflared.exe"), 12345, () => {})).toThrow();
	expect(() => tunnel.start(join(tmpdir(), "cloudflared.exe"), 0, () => {})).toThrow("端口");
	expect(mock.spawn).not.toHaveBeenCalled();
});

function fixture() {
	vi.useFakeTimers();
	const root = mkdtempSync(join(tmpdir(), "phone-tunnel-compat-"));
	const executable = join(root, "cloudflared.exe");
	writeFileSync(executable, "fixture");
	mock.spawn.mockImplementation(() => {
		const child = Object.assign(new EventEmitter(), {
			stdout: new EventEmitter(),
			stderr: new EventEmitter(),
			exitCode: null,
			signalCode: null,
			kill: vi.fn(() => {
				child.emit("close", 1);
				return true;
			}),
		});
		return child;
	});
	const tunnel = new PhoneTunnel();
	const origins: (string | undefined)[] = [];
	tunnel.start(executable, 12345, (url) => origins.push(url));
	return {
		tunnel,
		executable,
		origins,
		child: () => mock.spawn.mock.results.at(-1)!.value,
		clean: () => {
			tunnel.stop();
			rmSync(root, { recursive: true, force: true });
		},
	};
}

it("recovers on QUIC after TCP failure, handles split output, and retains only classified errors", () => {
	const f = fixture();
	try {
		f.child().stderr.emit("data", Buffer.from("https://fixture.trycloudflare.com\nconnection reset token=secret\n"));
		expect(f.tunnel.error).toContain("TLS/连接被中断");
		expect(f.tunnel.error).not.toContain("secret");
		f.child().emit("close", 1);
		vi.advanceTimersByTime(2000);
		f.child().stdout.emit("data", Buffer.from("https://new-fixture.trycloud"));
		f.child().stdout.emit("data", Buffer.from("flare.com\n"));
		expect(f.tunnel.url).toBeUndefined();
		f.child().stderr.emit("data", Buffer.from("Registered tunnel con"));
		f.child().stderr.emit("data", Buffer.from("nection\n"));
		expect(f.tunnel.state).toBe("ready");
		expect(f.tunnel.stage).toContain("QUIC");
		expect(f.tunnel.error).toBeUndefined();
		expect(f.origins.at(-1)).toBe("https://new-fixture.trycloudflare.com");
		vi.advanceTimersByTime(120000);
		expect(mock.spawn).toHaveBeenCalledTimes(2);
		expect(f.child().kill).not.toHaveBeenCalled();
	} finally {
		f.clean();
	}
});

it("does not retry invalid binaries or unsupported flags", () => {
	const f = fixture();
	try {
		f.child().stderr.emit("data", Buffer.from("Incorrect Usage: flag provided but not defined: private-path"));
		f.child().emit("close", 1);
		expect(f.tunnel.error).toContain("更新官方版本");
		expect(f.tunnel.stage).toContain("启动失败");
		expect(f.tunnel.nextRetryAt).toBeUndefined();
		vi.advanceTimersByTime(300000);
		expect(mock.spawn).toHaveBeenCalledTimes(1);
	} finally {
		f.clean();
	}
});

it("stops retrying on an OS spawn error", () => {
	const f = fixture();
	try {
		f.child().emit("error", new Error("EACCES private-path"));
		f.child().emit("close", -1);
		expect(f.tunnel.error).toContain("执行权限");
		expect(f.tunnel.error).not.toContain("private-path");
		vi.advanceTimersByTime(300000);
		expect(mock.spawn).toHaveBeenCalledTimes(1);
	} finally {
		f.clean();
	}
});

it("cancels retry and ignores stale process callbacks after restarting", () => {
	const f = fixture();
	try {
		const old = f.child();
		f.tunnel.stop();
		f.tunnel.start(f.executable, 12345, () => {});
		old.emit("error", new Error("late error"));
		old.stderr.emit("data", Buffer.from("connection reset\n"));
		expect(f.tunnel.error).toBeUndefined();
		expect(f.tunnel.attempt).toBe(1);
		f.child().emit("close", 1);
		f.tunnel.stop();
		vi.advanceTimersByTime(300000);
		expect(mock.spawn).toHaveBeenCalledTimes(2);
		expect(f.tunnel.state).toBe("off");
		expect(vi.getTimerCount()).toBe(0);
	} finally {
		f.clean();
	}
});

it("distinguishes provisioning timeouts and updates diagnostics from newer lines", () => {
	const f = fixture();
	try {
		f.child().stderr.emit("data", Buffer.from("no such host private\n"));
		expect(f.tunnel.error).toContain("DNS");
		f.child().stderr.emit("data", Buffer.from("failed to request quick Tunnel token=secret\n"));
		expect(f.tunnel.error).toContain("临时入口申请失败");
		expect(f.tunnel.error).not.toContain("secret");
		f.tunnel.stop();
		f.tunnel.start(f.executable, 12345, () => {});
		vi.advanceTimersByTime(20000);
		expect(f.tunnel.error).toContain("申请临时入口超时");
	} finally {
		f.clean();
	}
});
