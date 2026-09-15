import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { VideoPollSchedule } from "../src/media-video-polling.js";

const databases: DatabaseSync[] = [];
afterEach(() => {
	for (const db of databases.splice(0)) db.close();
});
function fixture() {
	const db = new DatabaseSync(":memory:");
	databases.push(db);
	return { db, schedule: new VideoPollSchedule(db) };
}
describe("durable video polling", () => {
	it("waits 30 seconds initially, then 45 and at most 60 seconds while generating", () => {
		const { schedule: s } = fixture();
		s.initialize("job", "account", 0, true);
		expect(s.nextAt("job")).toBe(30_000);
		expect(s.claim("job", 29_999)).toBe(false);
		expect(s.claim("job", 30_000)).toBe(true);
		s.pending("job", 30_000);
		s.release("job");
		expect(s.nextAt("job")).toBe(75_000);
		s.pending("job", 75_000);
		expect(s.nextAt("job")).toBe(135_000);
		s.pending("job", 135_000);
		expect(s.nextAt("job")).toBe(195_000);
	});
	it("preserves the schedule across initialization and competing scheduler instances", () => {
		const { db, schedule: s } = fixture();
		s.initialize("job", "account", 0, true);
		const other = new VideoPollSchedule(db);
		other.initialize("job", "account", 10_000, true);
		expect(other.nextAt("job")).toBe(30_000);
		expect(s.claim("job", 30_000)).toBe(true);
		expect(other.claim("job", 30_000)).toBe(false);
		s.pending("job", 31_000);
		s.release("job");
		expect(other.nextAt("job")).toBe(76_000);
		expect(other.claim("job", 76_000)).toBe(true);
	});
	it("backs off 60, 120, 240, then 300 seconds and respects a longer Retry-After", () => {
		const { schedule: s } = fixture();
		s.initialize("job", "account", 0);
		for (const interval of [60_000, 120_000, 240_000, 300_000, 300_000]) {
			s.defer("job", 0);
			expect(s.nextAt("job")).toBe(interval);
		}
		s.defer("job", 0, 900_000);
		expect(s.nextAt("job")).toBe(900_000);
		s.pending("job", 900_000);
		s.defer("job", 900_000);
		expect(s.nextAt("job")).toBe(960_000);
	});
	it("shares 429 cooldowns across jobs on the same connection without shortening them", () => {
		const { schedule: s } = fixture();
		s.initialize("a", "account", 0);
		s.initialize("b", "account", 0);
		s.initialize("c", "other", 0);
		s.defer("a", 0, 180_000, true);
		expect(s.claim("b", 60_000)).toBe(false);
		expect(s.claim("c", 0)).toBe(true);
		s.defer("b", 0, 0, true);
		expect(s.nextAt("b")).toBe(180_000);
		expect(s.claim("b", 180_000)).toBe(true);
	});
	it("lets old jobs resume and recovers an abandoned lease after its timeout", () => {
		const { db, schedule: s } = fixture();
		s.initialize("old", "account", 1000);
		expect(s.claim("old", 1000)).toBe(true);
		const restarted = new VideoPollSchedule(db);
		expect(restarted.claim("old", 180_999)).toBe(false);
		expect(restarted.claim("old", 181_000)).toBe(true);
	});
});
