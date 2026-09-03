import { describe, expect, it } from "vitest";
import { distanceFromBottom, isNearBottom } from "../src/lib/scroll.js";

describe("distanceFromBottom", () => {
	it("measures the content hidden below the viewport", () => {
		expect(distanceFromBottom({ scrollTop: 0, clientHeight: 400, scrollHeight: 1200 })).toBe(800);
		expect(distanceFromBottom({ scrollTop: 500, clientHeight: 400, scrollHeight: 1200 })).toBe(300);
		expect(distanceFromBottom({ scrollTop: 800, clientHeight: 400, scrollHeight: 1200 })).toBe(0);
	});

	it("clamps overscroll instead of reporting a negative distance", () => {
		expect(distanceFromBottom({ scrollTop: 900, clientHeight: 400, scrollHeight: 1200 })).toBe(0);
	});

	it("reports zero when the content does not fill the viewport", () => {
		expect(distanceFromBottom({ scrollTop: 0, clientHeight: 400, scrollHeight: 260 })).toBe(0);
	});
});

describe("isNearBottom", () => {
	it("follows the tail at the bottom and just above it", () => {
		expect(isNearBottom({ scrollTop: 800, clientHeight: 400, scrollHeight: 1200 })).toBe(true);
		expect(isNearBottom({ scrollTop: 740, clientHeight: 400, scrollHeight: 1200 })).toBe(true);
		expect(isNearBottom({ scrollTop: 728, clientHeight: 400, scrollHeight: 1200 })).toBe(true);
	});

	it("lets go once the reader has scrolled up past the threshold", () => {
		expect(isNearBottom({ scrollTop: 727, clientHeight: 400, scrollHeight: 1200 })).toBe(false);
		expect(isNearBottom({ scrollTop: 0, clientHeight: 400, scrollHeight: 1200 })).toBe(false);
	});

	it("still follows a transcript too short to scroll", () => {
		expect(isNearBottom({ scrollTop: 0, clientHeight: 400, scrollHeight: 400 })).toBe(true);
	});

	it("accepts a custom threshold", () => {
		const metrics = { scrollTop: 700, clientHeight: 400, scrollHeight: 1200 };
		expect(isNearBottom(metrics, 200)).toBe(true);
		expect(isNearBottom(metrics, 50)).toBe(false);
	});
});
