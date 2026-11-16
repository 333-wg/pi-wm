import { expect, it } from "vitest";
import { optimizerErrorKey } from "../src/lib/prompt-optimizer-error.js";

it("uses stable error codes, with status fallback for authentication and older gateways", () => {
	expect(optimizerErrorKey("provider_auth", 502)).toBe("optimizeProviderAuth");
	expect(optimizerErrorKey("invalid_output", 502)).toBe("optimizeInvalidOutput");
	expect(optimizerErrorKey("model_unavailable", 400)).toBe("optimizeModelUnavailable");
	expect(optimizerErrorKey(undefined, 401)).toBe("optimizePermission");
	expect(optimizerErrorKey(undefined, 409)).toBe("optimizeBusy");
	expect(optimizerErrorKey(undefined, 429)).toBe("optimizeRateLimited");
	expect(optimizerErrorKey(undefined, 504)).toBe("optimizeTimeout");
});

it("never renders arbitrary provider messages or prototype properties", () => {
	for (const code of ["secret-key", "toString", "__proto__", null, { message: "private" }])
		expect(optimizerErrorKey(code, 502)).toBe("optimizeFailed");
});
