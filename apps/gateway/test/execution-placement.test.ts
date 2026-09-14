import { describe, expect, it } from "vitest";
import { isLoopbackHost, resolveExecutionPlacement } from "../src/execution-placement.js";

describe("execution placement", () => {
	it.each(["127.0.0.1", "127.0.0.8", "localhost", "::1", "[::1]"])("recognizes %s as loopback", (host) =>
		expect(isLoopbackHost(host)).toBe(true)
	);

	it("requires an explicit local-device marker before enabling the user shell", () => {
		expect(resolveExecutionPlacement({ host: "127.0.0.1", deploymentMode: "local_device" })).toEqual({
			deploymentMode: "local_device",
			processMode: "local",
			terminalMode: "host",
			previewEnabled: true,
		});
	});

	it("treats an unmarked loopback Gateway as a server because it may sit behind a proxy", () => {
		expect(resolveExecutionPlacement({ host: "127.0.0.1" })).toEqual({
			deploymentMode: "server",
			processMode: "disabled",
			terminalMode: "disabled",
			previewEnabled: false,
		});
	});

	it("defaults a network-bound Gateway to server-safe execution", () => {
		expect(resolveExecutionPlacement({ host: "0.0.0.0" })).toEqual({
			deploymentMode: "server",
			processMode: "disabled",
			terminalMode: "disabled",
			previewEnabled: false,
		});
	});

	it("rejects host execution that would be mistaken for user-device execution", () => {
		expect(() => resolveExecutionPlacement({ host: "0.0.0.0", processMode: "local" })).toThrow(
			/server, not the user device/
		);
		expect(() => resolveExecutionPlacement({ host: "0.0.0.0", terminalMode: "host" })).toThrow(/server shell/);
		expect(() => resolveExecutionPlacement({ host: "0.0.0.0", previewEnabled: true })).toThrow(/Gateway host/);
	});

	it("allows an explicitly isolated Docker backend in server mode", () => {
		expect(
			resolveExecutionPlacement({
				host: "0.0.0.0",
				processMode: "docker",
				terminalMode: "docker",
			})
		).toMatchObject({
			deploymentMode: "server",
			processMode: "docker",
			terminalMode: "docker",
		});
	});
});
