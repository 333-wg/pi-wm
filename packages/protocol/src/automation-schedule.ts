export type CalendarSchedule = {
	kind: "calendar";
	frequency: "daily" | "weekly" | "monthly";
	timeZone: string;
	hour: number;
	minute: number;
	/** Sunday is 0, Saturday is 6. */
	weekdays?: number[];
	dayOfMonth?: number;
};

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function integerInRange(value: unknown, min: number, max: number): boolean {
	return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

function formatter(timeZone: string): Intl.DateTimeFormat {
	return new Intl.DateTimeFormat("en-US-u-ca-gregory-nu-latn", {
		timeZone,
		era: "short",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hourCycle: "h23",
	});
}

export function validateCalendarSchedule(schedule: CalendarSchedule): void {
	if (!schedule || typeof schedule !== "object" || schedule.kind !== "calendar") {
		throw new RangeError("Schedule kind must be calendar");
	}
	if (!["daily", "weekly", "monthly"].includes(schedule.frequency)) {
		throw new RangeError("Invalid calendar frequency");
	}
	// Intl also accepts numeric offsets on newer runtimes; those are not IANA names.
	if (
		typeof schedule.timeZone !== "string" ||
		!schedule.timeZone ||
		schedule.timeZone !== schedule.timeZone.trim() ||
		/^[+-]/.test(schedule.timeZone)
	) {
		throw new RangeError("timeZone must be an IANA time zone (or UTC)");
	}
	try {
		formatter(schedule.timeZone);
	} catch {
		throw new RangeError("timeZone must be an IANA time zone (or UTC)");
	}
	if (!integerInRange(schedule.hour, 0, 23) || !integerInRange(schedule.minute, 0, 59)) {
		throw new RangeError("hour must be an integer 0..23 and minute an integer 0..59");
	}
	if (schedule.frequency === "weekly") {
		if (
			!Array.isArray(schedule.weekdays) ||
			schedule.weekdays.length === 0 ||
			new Set(schedule.weekdays).size !== schedule.weekdays.length ||
			Array.from(schedule.weekdays).some((day) => !integerInRange(day, 0, 6))
		) {
			throw new RangeError("weekly schedules require unique weekdays in 0..6");
		}
	} else if ("weekdays" in schedule) {
		throw new RangeError("weekdays is only allowed for weekly schedules");
	}
	if (schedule.frequency === "monthly") {
		if (!integerInRange(schedule.dayOfMonth, 1, 31)) {
			throw new RangeError("monthly schedules require an integer dayOfMonth in 1..31");
		}
	} else if ("dayOfMonth" in schedule) {
		throw new RangeError("dayOfMonth is only allowed for monthly schedules");
	}
}

// Use UTC only as a Gregorian calendar coordinate, never as the schedule's zone.
// setUTCFullYear avoids Date.UTC's special interpretation of years 0..99.
function calendarDate(year: number, month: number, day: number): Date {
	const date = new Date(0);
	date.setUTCFullYear(year, month - 1, day);
	return date;
}

function localCoordinate(format: Intl.DateTimeFormat, instant: number): number {
	const parts = format.formatToParts(instant);
	const value = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((part) => part.type === type)?.value);
	const year = value("year");
	const date = calendarDate(
		parts.find((part) => part.type === "era")?.value === "BC" ? 1 - year : year,
		value("month"),
		value("day")
	);
	date.setUTCHours(value("hour"), value("minute"), value("second"), 0);
	return date.getTime();
}

function firstInstant(format: Intl.DateTimeFormat, coordinate: number): number | undefined {
	const offsets = new Set<number>();
	// Collect offsets on both sides of nearby IANA transitions, including half-hour
	// DST and whole-day date-line jumps. Fixed work per candidate day, not a scan
	// over every possible minute. Keep seconds for historical sub-minute offsets.
	for (let hours = -48; hours <= 48; hours += 6) {
		const probe = coordinate + hours * HOUR;
		if (!Number.isNaN(new Date(probe).getTime())) {
			offsets.add(localCoordinate(format, probe) - probe);
		}
	}
	let first: number | undefined;
	for (const offset of offsets) {
		const instant = coordinate - offset;
		if (
			!Number.isNaN(new Date(instant).getTime()) &&
			localCoordinate(format, instant) === coordinate &&
			(first === undefined || instant < first)
		) {
			first = instant;
		}
	}
	return first;
}

/** Return the first run strictly after the epoch-millisecond timestamp `after`.
 * Gaps are skipped; folds run only at their first occurrence, even when `after`
 * lies between the two occurrences. Missing month days are never clamped.
 */
export function nextCalendarRun(schedule: CalendarSchedule, after: number): number {
	validateCalendarSchedule(schedule);
	if (typeof after !== "number" || !Number.isFinite(after) || Number.isNaN(new Date(after).getTime())) {
		throw new RangeError("after must be a finite timestamp within the Date range");
	}
	const format = formatter(schedule.timeZone);
	const date = new Date(localCoordinate(format, after));
	date.setUTCHours(0, 0, 0, 0);
	while (!Number.isNaN(date.getTime())) {
		const eligible =
			schedule.frequency === "daily" ||
			(schedule.frequency === "weekly" && schedule.weekdays!.includes(date.getUTCDay())) ||
			(schedule.frequency === "monthly" && schedule.dayOfMonth === date.getUTCDate());
		if (eligible) {
			const coordinate = date.getTime() + schedule.hour * HOUR + schedule.minute * 60_000;
			const instant = firstInstant(format, coordinate);
			if (instant !== undefined && instant > after) return instant;
		}
		date.setTime(date.getTime() + DAY);
	}
	throw new RangeError("No next calendar run exists within the Date range");
}

export function upcomingCalendarRuns(schedule: CalendarSchedule, after: number, count = 3): number[] {
	if (!Number.isSafeInteger(count) || count < 0) {
		throw new RangeError("count must be a non-negative safe integer");
	}
	// Validate even when no results are requested.
	validateCalendarSchedule(schedule);
	if (typeof after !== "number" || !Number.isFinite(after) || Number.isNaN(new Date(after).getTime())) {
		throw new RangeError("after must be a finite timestamp within the Date range");
	}
	const runs: number[] = [];
	for (let index = 0; index < count; index++) {
		after = nextCalendarRun(schedule, after);
		runs.push(after);
	}
	return runs;
}
