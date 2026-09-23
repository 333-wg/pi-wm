import { describe, expect, it, vi } from "vitest";
import {
	type CalendarSchedule,
	nextCalendarRun,
	upcomingCalendarRuns,
	validateCalendarSchedule,
} from "../src/automation-schedule.js";

const daily: CalendarSchedule = {
	kind: "calendar",
	frequency: "daily",
	timeZone: "UTC",
	hour: 9,
	minute: 30,
};
const weekly: CalendarSchedule = { ...daily, frequency: "weekly", weekdays: [1, 5] };
const monthly: CalendarSchedule = { ...daily, frequency: "monthly", dayOfMonth: 31 };
const ny: CalendarSchedule = { ...daily, timeZone: "America/New_York" };
const next = (schedule: CalendarSchedule, after: string): string =>
	new Date(nextCalendarRun(schedule, Date.parse(after))).toISOString();

describe("validateCalendarSchedule", () => {
	it.each([
		daily,
		weekly,
		monthly,
		{ ...daily, timeZone: "Asia/Shanghai", hour: 0, minute: 0 },
		{ ...ny, hour: 23, minute: 59 },
		{ ...weekly, weekdays: [0, 6] },
		{ ...monthly, dayOfMonth: 1 },
		{ ...daily, timeZone: "Etc/GMT+8" },
	])("accepts valid schedule %j", (schedule) => {
		expect(() => validateCalendarSchedule(schedule)).not.toThrow();
	});

	it.each([
		null,
		undefined,
		{},
		{ ...daily, kind: "interval" },
		{ ...daily, frequency: "yearly" },
		...["", "Mars/Olympus", "Asia Shanghai", " UTC", "UTC ", "+08:00", "-0500", 42, null].map((timeZone) => ({
			...daily,
			timeZone,
		})),
		...[-1, 24, 1.5, NaN, Infinity, "9", null, undefined].map((hour) => ({ ...daily, hour })),
		...[-1, 60, 1.5, NaN, Infinity, "30", null, undefined].map((minute) => ({ ...daily, minute })),
		...[undefined, [], [1, 1], [-1], [7], [1.5], [NaN], ["1"], [null], Array(1), "1"].map((weekdays) => ({
			...weekly,
			weekdays,
		})),
		...[undefined, 0, 32, 1.5, NaN, Infinity, "1", null].map((dayOfMonth) => ({ ...monthly, dayOfMonth })),
		{ ...daily, weekdays: [1] },
		{ ...daily, weekdays: undefined },
		{ ...monthly, weekdays: [1] },
		{ ...daily, dayOfMonth: 1 },
		{ ...daily, dayOfMonth: undefined },
		{ ...weekly, dayOfMonth: 1 },
	])("rejects invalid schedule %j", (schedule) => {
		expect(() => validateCalendarSchedule(schedule as CalendarSchedule)).toThrow(RangeError);
	});
});

describe("nextCalendarRun", () => {
	it("uses strict millisecond boundaries and rolls over the UTC year", () => {
		expect(next(daily, "2024-12-31T09:29:59.999Z")).toBe("2024-12-31T09:30:00.000Z");
		expect(next(daily, "2024-12-31T09:30:00.000Z")).toBe("2025-01-01T09:30:00.000Z");
		expect(next(daily, "2024-12-31T09:30:00.001Z")).toBe("2025-01-01T09:30:00.000Z");
	});

	it("uses the local date and midnight in Shanghai rather than the UTC day", () => {
		const shanghai = { ...daily, timeZone: "Asia/Shanghai", hour: 0, minute: 0 };
		expect(next(shanghai, "2024-12-31T15:59:59.999Z")).toBe("2024-12-31T16:00:00.000Z");
		expect(next(shanghai, "2024-12-31T16:00:00.000Z")).toBe("2025-01-01T16:00:00.000Z");
	});

	it("selects weekly days independent of input order and crosses the year", () => {
		expect(next({ ...weekly, weekdays: [5, 1] }, "2024-12-30T09:30:00Z")).toBe("2025-01-03T09:30:00.000Z");
		expect(next({ ...weekly, weekdays: [0] }, "2024-12-28T10:00:00Z")).toBe("2024-12-29T09:30:00.000Z");
	});

	it("uses the local weekday across UTC midnight", () => {
		expect(next({ ...weekly, timeZone: "Asia/Shanghai", hour: 0, weekdays: [1] }, "2024-12-29T16:00:00Z")).toBe(
			"2024-12-29T16:30:00.000Z"
		);
	});

	it("skips months without day 31 and crosses the year", () => {
		expect(next(monthly, "2024-01-31T09:30:00Z")).toBe("2024-03-31T09:30:00.000Z");
		expect(next(monthly, "2024-03-31T09:30:00Z")).toBe("2024-05-31T09:30:00.000Z");
		expect(next(monthly, "2024-12-31T09:30:00Z")).toBe("2025-01-31T09:30:00.000Z");
	});

	it.each([
		["2024-01-29T09:30:00Z", "2024-02-29T09:30:00.000Z"],
		["2023-01-29T09:30:00Z", "2023-03-29T09:30:00.000Z"],
		["2000-01-29T09:30:00Z", "2000-02-29T09:30:00.000Z"],
		["2100-01-29T09:30:00Z", "2100-03-29T09:30:00.000Z"],
	])("handles Gregorian leap-year rules after %s", (after, expected) => {
		expect(next({ ...monthly, dayOfMonth: 29 }, after)).toBe(expected);
	});

	it("uses Shanghai's local month boundary", () => {
		expect(
			next({ ...monthly, timeZone: "Asia/Shanghai", hour: 0, minute: 0, dayOfMonth: 1 }, "2024-12-31T16:00:00Z")
		).toBe("2025-01-31T16:00:00.000Z");
	});

	it("skips the New York spring gap instead of shifting to 03:30", () => {
		const schedule = { ...ny, hour: 2, minute: 30 };
		expect(next(schedule, "2024-03-09T07:30:00Z")).toBe("2024-03-11T06:30:00.000Z");
		expect(next(schedule, "2024-03-10T05:00:00Z")).toBe("2024-03-11T06:30:00.000Z");
	});

	it("skips weekly and monthly occurrences in a spring gap", () => {
		expect(next({ ...ny, frequency: "weekly", weekdays: [0], hour: 2 }, "2024-03-09T12:00:00Z")).toBe(
			"2024-03-17T06:30:00.000Z"
		);
		expect(next({ ...ny, frequency: "monthly", dayOfMonth: 10, hour: 2 }, "2024-03-09T12:00:00Z")).toBe(
			"2024-04-10T06:30:00.000Z"
		);
	});

	it("chooses the first New York fall occurrence", () => {
		expect(next({ ...ny, hour: 1 }, "2024-11-03T05:29:59.999Z")).toBe("2024-11-03T05:30:00.000Z");
	});

	it.each(["2024-11-03T05:30:00Z", "2024-11-03T06:00:00Z", "2024-11-03T06:15:00Z", "2024-11-03T06:30:00Z"])(
		"never catches up the second fall occurrence after %s",
		(after) => {
			expect(next({ ...ny, hour: 1 }, after)).toBe("2024-11-04T06:30:00.000Z");
		}
	);

	it("does not repeat the fold for weekly or monthly schedules", () => {
		expect(next({ ...ny, frequency: "weekly", weekdays: [0], hour: 1 }, "2024-11-03T05:45:00Z")).toBe(
			"2024-11-10T06:30:00.000Z"
		);
		expect(next({ ...ny, frequency: "monthly", dayOfMonth: 3, hour: 1 }, "2024-11-03T05:45:00Z")).toBe(
			"2024-12-03T06:30:00.000Z"
		);
	});

	it("handles half-hour DST transitions in Lord Howe", () => {
		const schedule = { ...daily, timeZone: "Australia/Lord_Howe" };
		expect(next({ ...schedule, hour: 2, minute: 15 }, "2024-10-05T00:00:00Z")).toBe("2024-10-06T15:15:00.000Z");
		expect(next({ ...schedule, hour: 1, minute: 45 }, "2024-04-06T14:45:00Z")).toBe("2024-04-07T15:15:00.000Z");
	});

	it("skips a whole missing local day at the Apia date-line transition", () => {
		expect(next({ ...daily, timeZone: "Pacific/Apia" }, "2011-12-29T19:30:00Z")).toBe("2011-12-30T19:30:00.000Z");
	});

	it("preserves years below 100 and supports timestamps before the epoch", () => {
		expect(next(daily, "0099-12-31T09:30:00Z")).toBe("0100-01-01T09:30:00.000Z");
		expect(next(daily, "1969-12-31T09:30:00Z")).toBe("1970-01-01T09:30:00.000Z");
	});

	it.each([NaN, Infinity, -Infinity, 8.64e15 + 1, -8.64e15 - 1, "0", null, undefined])(
		"rejects invalid after %j",
		(after) => {
			expect(() => nextCalendarRun(daily, after as number)).toThrow(RangeError);
		}
	);

	it("reports exhausted Date range rather than looping", () => {
		expect(() => nextCalendarRun(daily, 8.64e15)).toThrow(RangeError);
	});

	it("validates schedules on the execution path", () => {
		expect(() => nextCalendarRun({ ...daily, hour: 24 }, 0)).toThrow(RangeError);
	});

	it("performs bounded Intl work on candidate dates, not per minute", () => {
		const spy = vi.spyOn(Intl.DateTimeFormat.prototype, "formatToParts");
		try {
			expect(next(monthly, "2024-01-31T09:30:00Z")).toBe("2024-03-31T09:30:00.000Z");
			expect(spy.mock.calls.length).toBeLessThan(100);
		} finally {
			spy.mockRestore();
		}
	});
});

describe("upcomingCalendarRuns", () => {
	it("defaults to three strictly increasing runs without duplicating a fold", () => {
		const schedule = Object.freeze({ ...ny, hour: 1 });
		expect(
			upcomingCalendarRuns(schedule, Date.parse("2024-11-02T05:30:00Z")).map((run) => new Date(run).toISOString())
		).toEqual(["2024-11-03T05:30:00.000Z", "2024-11-04T06:30:00.000Z", "2024-11-05T06:30:00.000Z"]);
	});

	it("allows zero and custom counts without mutating the schedule", () => {
		const schedule = { ...weekly, weekdays: [5, 1] };
		expect(upcomingCalendarRuns(schedule, 0, 0)).toEqual([]);
		expect(upcomingCalendarRuns(schedule, 0, 2)).toHaveLength(2);
		expect(schedule.weekdays).toEqual([5, 1]);
	});

	it.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "3", null])("rejects invalid count %j", (count) => {
		expect(() => upcomingCalendarRuns(daily, 0, count as number)).toThrow(RangeError);
	});

	it("validates inputs even for zero count", () => {
		expect(() => upcomingCalendarRuns({ ...daily, minute: 60 }, 0, 0)).toThrow(RangeError);
		expect(() => upcomingCalendarRuns(daily, NaN, 0)).toThrow(RangeError);
	});
});
