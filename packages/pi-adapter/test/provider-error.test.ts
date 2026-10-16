import { expect, it } from "vitest";
import { providerErrorMessage } from "../src/provider-error.js";

it("retains safe cause codes and request identifiers but not headers or nested bodies", () => {
	const error = Object.assign(new Error("Connection error. Bearer sk-secret123456"), {
		status: 503,
		request_id: "req-test-123",
		headers: { authorization: "private-header" },
		cause: Object.assign(new Error("private-response-body"), { code: "ECONNRESET" }),
	});
	const message = providerErrorMessage(error);
	expect(message).toContain("HTTP 503");
	expect(message).toContain("ECONNRESET");
	expect(message).toContain("request_id=req-test-123");
	expect(message).not.toMatch(/secret123456|private-header|private-response-body/);
});

it("redacts DeepSeek account headers including JSON and quoted values", () => {
	for (const raw of [
		"x-dsh-auth-token: opaque-grant-value",
		'headers={"x-dsh-auth-token":"opaque-grant-value"}',
		"X-DSH-AUTH-TOKEN='opaque-grant-value'",
	]) {
		expect(providerErrorMessage(new Error(raw))).not.toContain("opaque-grant-value");
		expect(providerErrorMessage(new Error(raw))).toContain("[REDACTED]");
	}
});

it("bounds cyclic causes and rejects arbitrary diagnostic identifiers", () => {
	const error = Object.assign(new Error("failed"), {
		cause: {} as unknown,
		request_id: "Bearer secret",
		code: "bad code",
	});
	error.cause = error;
	expect(providerErrorMessage(error)).toBe("failed");
});
