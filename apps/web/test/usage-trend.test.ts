import { describe, expect, it } from "vitest";
import { usageTrendGeometry } from "../src/lib/usage-trend.js";

describe("usage trend geometry", () => {
	it("draws a smooth segment through each actual daily value", () => {
		const chart = usageTrendGeometry([20, 80, 0, 50]);
		expect(chart.points.map((p) => p.y)).toEqual([120, 0, 160, 60]);
		expect(chart.line.match(/ C /g)).toHaveLength(3);
		expect(chart.line).toContain("628 60");
		expect(chart.area).toMatch(/L 628 160 L 12 160 Z$/);
	});
	it("shows zero usage at the baseline instead of inventing a minimum height", () => {
		const chart = usageTrendGeometry(Array(30).fill(0));
		expect(chart.ceiling).toBe(1);
		expect(chart.points).toHaveLength(30);
		expect(chart.points.every((p) => p.y === 160)).toBe(true);
		expect(chart.line).not.toMatch(/NaN|Infinity/);
	});
	it("handles an empty series, a single day and invalid input", () => {
		expect(usageTrendGeometry([]).line).toBe("");
		expect(usageTrendGeometry([5]).points).toEqual([{ x: 320, y: 0 }]);
		expect(usageTrendGeometry([NaN, -1, Infinity]).points.every((p) => p.y === 160)).toBe(true);
	});
});
