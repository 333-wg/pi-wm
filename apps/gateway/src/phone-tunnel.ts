import { spawn, type ChildProcess } from "node:child_process";
import { isAbsolute, basename, join } from "node:path";
import { accessSync, constants, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

// Keep OS routing/DNS intact. Alternate transports before trying IPv4-only paths.
const strategies = [
	{ protocol: "http2", ip: "auto", label: "HTTP/2 · TCP 7844 · 自动 IP" },
	{ protocol: "quic", ip: "auto", label: "QUIC · UDP 7844 · 自动 IP" },
	{ protocol: "http2", ip: "4", label: "HTTP/2 · TCP 7844 · IPv4" },
	{ protocol: "quic", ip: "4", label: "QUIC · UDP 7844 · IPv4" },
] as const;

/** Opt-in only. No downloads, shell interpolation, account setup or automatic publication. */
export class PhoneTunnel {
	#child: ChildProcess | undefined;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#connectionTimer: ReturnType<typeof setTimeout> | undefined;
	#strategy = 0;
	#stopped = true;
	#configDirectory: string | undefined;
	#attempt = 0;
	state: "off" | "connecting" | "ready" | "error" = "off";
	error: string | undefined;
	url: string | undefined;
	attempt = 0;
	stage = "未启动";
	nextRetryAt: number | undefined;

	start(executable: string, port: number, onUrl: (url: string | undefined) => void): void {
		if (!isAbsolute(executable) || !/^cloudflared(?:\.exe)?$/i.test(basename(executable)))
			throw new Error("请选择已安装 cloudflared 程序的绝对路径");
		if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("手机上游端口无效");
		accessSync(executable, constants.F_OK);
		this.stop();
		this.#stopped = false;
		this.#configDirectory = mkdtempSync(join(tmpdir(), "wuming-phone-tunnel-"));
		const config = join(this.#configDirectory, "config.yml");
		writeFileSync(config, "{}\n", { mode: 0o600 });
		const launch = () => {
			if (this.#stopped) return;
			this.state = "connecting";
			this.attempt++;
			const strategy = strategies[this.#strategy]!;
			this.stage = `申请临时入口（${strategy.label}；本轮最多等待 20 秒）`;
			this.nextRetryAt = undefined;
			this.url = undefined;
			this.error = undefined;
			onUrl(undefined);
			let candidate: string | undefined;
			let registered = false;
			let permanentFailure = false;
			let terminating = false;
			let closing = false;
			let edgeFailures = 0;
			let lastEdgeFailureAt: number | undefined;
			let edgeStartedAt: number | undefined;
			const child = spawn(
				executable,
				[
					"tunnel",
					"--config",
					config,
					"--no-autoupdate",
					"--url",
					`http://127.0.0.1:${port}`,
					"--protocol",
					strategy.protocol,
					"--edge-ip-version",
					strategy.ip,
					"--loglevel",
					"info",
					"--grace-period",
					"1s",
					"--metrics",
					"127.0.0.1:0",
				],
				{
					stdio: ["ignore", "pipe", "pipe"],
					windowsHide: true,
					shell: false,
				}
			);
			this.#child = child;
			const terminate = () => {
				if (terminating || closing) return;
				terminating = true;
				child.kill();
			};
			const timeout = setTimeout(() => {
				if (this.#stopped || this.#child !== child || this.state === "ready") return;
				this.error ??= candidate
					? `边缘连接超时（${strategy.label}）；请检查代理/TUN 路由，普通 HTTPS 可用不代表 7844 可用`
					: "申请临时入口超时，请检查 api.trycloudflare.com 的 HTTPS 连接；切换隧道协议不能修复入口申请失败";
				this.stage = `连接超时（${strategy.label}）`;
				terminate();
			}, 20_000);
			this.#connectionTimer = timeout;
			const readLine = (line: string) => {
				if (this.#stopped || this.#child !== child || terminating) return;
				candidate ??= line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/)?.[0];
				if (candidate) edgeStartedAt ??= Date.now();
				registered ||= line.includes("Registered tunnel connection");
				if (this.state !== "ready") {
					if (candidate) this.stage = `已分配地址，等待边缘连接（${strategy.label}；本轮最多等待 20 秒）`;
					// Only fixed classifications leave this closure; never expose paths, credentials or raw logs.
					if (/flag provided but not defined|unknown flag|incorrect usage/i.test(line)) {
						permanentFailure = true;
						this.error = "cloudflared 不支持所需启动参数，请更新官方版本后重新开启";
						terminate();
						return;
					} else if (/no such host|failed to resolve|DNS.*failed|lookup .*(?:timeout|server misbehaving)/i.test(line))
						this.error = "DNS 解析失败，请检查系统 DNS 与代理 Fake-IP/TUN 兼容性；不会自动更改系统 DNS";
					else if (
						/failed to request quick tunnel|quick tunnel provisioning failed|failed to unmarshal quick tunnel/i.test(
							line
						)
					)
						this.error = "Cloudflare 临时入口申请失败，请检查 api.trycloudflare.com 的 HTTPS 连接或稍后重试";
					else if (/x509|certificate.*(?:invalid|expired|unknown)|unknown authority/i.test(line))
						this.error = "隧道 TLS 证书校验失败，请检查系统时间及 HTTPS 检查代理；不会关闭证书校验";
					else if (/TLS handshake|connection reset|forcibly closed|unexpected EOF/i.test(line))
						this.error = `TLS/连接被中断（${strategy.label}），请检查代理线路与 TUN 路由`;
					else if (/timeout|connection refused|failed to dial|network is unreachable/i.test(line))
						this.error = `网络连接失败（${strategy.label}），请检查代理路由及出站端口`;
				}
				// A single transient error (or duplicate lines in one burst) must not kill a recoverable connection.
				if (
					!registered &&
					candidate &&
					/TLS handshake|connection reset|forcibly closed|unexpected EOF|timeout|connection refused|failed to dial|network is unreachable/i.test(
						line
					)
				) {
					const now = Date.now();
					if (lastEdgeFailureAt === undefined || now - lastEdgeFailureAt >= 1000) {
						edgeFailures++;
						lastEdgeFailureAt = now;
						if (edgeFailures >= 2 && now - edgeStartedAt! >= 5000) {
							this.stage = `边缘连接持续失败，准备切换策略（${strategy.label}）`;
							terminate();
							return;
						}
					}
				}
				if (candidate && registered && this.url !== candidate) {
					clearTimeout(timeout);
					this.url = candidate;
					this.state = "ready";
					this.stage = `隧道已连接（${strategy.label}）`;
					this.error = undefined;
					this.#attempt = 0;
					onUrl(candidate);
				}
			};
			// Separate streams and complete lines prevent old failures overriding later diagnostics.
			const reader = () => {
				let pending = "";
				return {
					data: (chunk: Buffer) => {
						pending = (pending + chunk.toString()).slice(-16_384);
						const lines = pending.split(/\r?\n/);
						pending = lines.pop() ?? "";
						for (const line of lines) readLine(line);
					},
					flush: () => {
						if (pending) readLine(pending);
						pending = "";
					},
				};
			};
			const stdout = reader(),
				stderr = reader();
			child.stdout?.on("data", stdout.data);
			child.stderr?.on("data", stderr.data);
			child.on("error", () => {
				if (this.#stopped || this.#child !== child) return;
				permanentFailure = true;
				this.error = "无法启动 cloudflared，请检查程序路径和执行权限";
			});
			child.once("close", () => {
				closing = true;
				clearTimeout(timeout);
				if (this.#stopped || this.#child !== child) return;
				stdout.flush();
				stderr.flush();
				this.#connectionTimer = undefined;
				this.#child = undefined;
				this.url = undefined;
				onUrl(undefined);
				this.state = "error";
				this.error ??= "隧道已断开，将有限次数重试；重建后地址可能变化";
				if (!permanentFailure && ++this.#attempt <= 3) {
					// Transport changes cannot repair HTTPS provisioning before a URL was assigned.
					if (candidate) this.#strategy = (this.#strategy + 1) % strategies.length;
					const delay = 1000 * 2 ** this.#attempt;
					this.stage = candidate
						? `等待重试，将尝试 ${strategies[this.#strategy]!.label}`
						: "等待重试临时入口申请（尚未分配地址，不切换边缘协议）";
					this.nextRetryAt = Date.now() + delay;
					this.#timer = setTimeout(launch, delay);
				} else {
					this.stage = permanentFailure
						? "启动失败，请修正 cloudflared 后手动重新开启"
						: candidate
							? "重试已用尽，请检查网络后手动重新开启（TCP/UDP 7844 至少一种需可用）"
							: "临时入口申请重试已用尽，请检查 api.trycloudflare.com 的 HTTPS 连接后手动重新开启";
					this.nextRetryAt = undefined;
				}
			});
		};
		launch();
	}
	stop(): void {
		this.#stopped = true;
		clearTimeout(this.#timer);
		clearTimeout(this.#connectionTimer);
		this.#timer = undefined;
		this.#connectionTimer = undefined;
		const child = this.#child,
			directory = this.#configDirectory;
		this.#configDirectory = undefined;
		const clean = () => {
			if (directory) {
				try {
					rmSync(directory, { recursive: true, force: true });
				} catch {
					/* OS will also clean temporary files. */
				}
			}
		};
		if (child && child.exitCode === null && child.signalCode === null) {
			child.once("close", clean);
			child.kill();
		} else clean();
		this.#child = undefined;
		this.#attempt = 0;
		this.#strategy = 0;
		this.state = "off";
		this.attempt = 0;
		this.stage = "未启动";
		this.nextRetryAt = undefined;
		this.url = undefined;
		this.error = undefined;
	}
}
