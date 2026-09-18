import { afterEach, describe, expect, it, vi } from "vitest";
import { desktopConnection } from "../src/lib/desktop.js";
import { bearerProtocol, gatewayWebSocketUrl } from "../src/lib/gateway-connection.js";

vi.mock("../src/lib/desktop.js", () => ({ desktopConnection: vi.fn() }));
afterEach(() => {
	vi.resetAllMocks();
	vi.unstubAllGlobals();
});

describe("gateway connection", () => {
	it("uses the desktop bridge rather than ws://app", () => {
		vi.stubGlobal("location", { protocol: "wuming:", host: "app" });
		vi.mocked(desktopConnection).mockReturnValue({ token: "secret", websocketUrl: "ws://127.0.0.1:61338/api/ws" });
		expect(gatewayWebSocketUrl()).toBe("ws://127.0.0.1:61338/api/ws");
	});
	it("uses the browser origin, including TLS and port", () => {
		vi.stubGlobal("location", { protocol: "https:", host: "localhost:5173" });
		expect(gatewayWebSocketUrl()).toBe("wss://localhost:5173/api/ws");
	});
	it("keeps unicode tokens out of the URL and encodes them as a subprotocol", () => {
		expect(bearerProtocol("密码")).toBe("wuming.bearer.5a-G56CB");
	});
});
