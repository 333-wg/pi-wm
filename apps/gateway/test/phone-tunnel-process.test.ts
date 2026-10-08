import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";

// Real local child processes and streams; no external network, cloudflared or user data.
const observed = vi.hoisted(() => ({ args: [] as string[][] }));
vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return {
		...actual,
		spawn: (_executable: string, args: string[]) => {
			observed.args.push(args);
			return actual.spawn(
				process.execPath,
				[
					"-e",
					`
				const args = JSON.parse(process.argv[1]);
				if (args[args.indexOf('--protocol') + 1] === 'http2') {
					console.log('https://failed-local-fixture.trycloudflare.com');
					console.error('connection reset token=fixture-secret');
					process.exitCode = 1;
				} else {
					console.log('https://local-process-fixture.trycloudflare.com');
					setTimeout(() => console.error('Registered tunnel connection'), 30);
					setInterval(() => {}, 1000);
				}
			`,
					JSON.stringify(args),
				],
				{ stdio: ["ignore", "pipe", "pipe"], windowsHide: true }
			);
		},
	};
});
import { PhoneTunnel } from "../src/phone-tunnel.js";

it("recovers from an actual failed child process and cleans up the replacement", async () => {
	const root = mkdtempSync(join(tmpdir(), "phone-process-check-"));
	const executable = join(root, "cloudflared.exe");
	writeFileSync(executable, "not executed; spawn redirected to a local Node fixture");
	const tunnel = new PhoneTunnel();
	const origins: (string | undefined)[] = [];
	try {
		tunnel.start(executable, 12345, (url) => origins.push(url));
		await vi.waitFor(() => expect(tunnel.state).toBe("ready"), { timeout: 10000, interval: 50 });
		expect(observed.args).toHaveLength(2);
		expect(tunnel.stage).toContain("QUIC");
		expect(tunnel.error).toBeUndefined();
		expect(origins.filter(Boolean)).toEqual(["https://local-process-fixture.trycloudflare.com"]);
		const args = observed.args[1]!;
		const config = args[args.indexOf("--config") + 1]!;
		tunnel.stop();
		await vi.waitFor(() => expect(existsSync(config)).toBe(false), { timeout: 3000 });
		expect(tunnel.state).toBe("off");
		expect(tunnel.nextRetryAt).toBeUndefined();
	} finally {
		tunnel.stop();
		rmSync(root, { recursive: true, force: true });
	}
}, 15000);
