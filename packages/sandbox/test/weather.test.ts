import { describe, expect, it } from "vitest";
import type { WebSandbox } from "../src/index.js";
import { queryWeather } from "../src/index.js";

describe("weather service", () => {
	it("resolves a place and returns bounded current and daily weather", async () => {
		const requested: string[] = [];
		const web: WebSandbox = {
			searchHost: undefined,
			searchSecretName: undefined,
			async fetch(url) {
				requested.push(url);
				const geocoding = url.includes("geocoding-api")
					? { results: [{ name: "北京", admin1: "北京市", country: "中国", latitude: 39.9042, longitude: 116.4074 }] }
					: {
						timezone: "Asia/Shanghai",
						current_units: { temperature_2m: "°C", apparent_temperature: "°C", relative_humidity_2m: "%", precipitation: "mm", wind_speed_10m: "km/h" },
						current: { time: "2026-09-01T14:00", temperature_2m: 28, apparent_temperature: 30, relative_humidity_2m: 60, precipitation: 0, weather_code: 1, wind_speed_10m: 8 },
						daily_units: { temperature_2m_max: "°C", temperature_2m_min: "°C", precipitation_probability_max: "%" },
						daily: { time: ["2026-09-01", "2026-09-02"], weather_code: [1, 61], temperature_2m_max: [31, 29], temperature_2m_min: [20, 19], precipitation_probability_max: [10, 70] },
					};
				return { requestedUrl: url, finalUrl: url, status: 200, contentType: "application/json", content: JSON.stringify(geocoding), truncated: false };
			},
		};
		const report = await queryWeather(web, "北京", 2);
		expect(report).toMatchObject({
			location: { name: "北京", country: "中国", timezone: "Asia/Shanghai" },
			current: { temperature_2m: "28 °C", condition: "Mainly clear" },
			daily: [
				{ date: "2026-09-01", temperature_max: "31 °C", condition: "Mainly clear" },
				{ date: "2026-09-02", precipitation_probability_max: "70 %", condition: "Slight rain" },
			],
		});
		expect(requested).toHaveLength(2);
		expect(requested[1]).toContain("forecast_days=2");
	});

	it("reports an unmatched location", async () => {
		const web: WebSandbox = {
			searchHost: undefined,
			searchSecretName: undefined,
			async fetch(url) { return { requestedUrl: url, finalUrl: url, status: 200, contentType: "application/json", content: "{}", truncated: false }; },
		};
		await expect(queryWeather(web, "not-a-place", 3)).rejects.toMatchObject({ code: "network_failed" });
	});
});
