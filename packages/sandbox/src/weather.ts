import { SandboxError } from "./errors.js";
import type { WebSandbox } from "./types.js";

export const WEATHER_HOSTS = ["geocoding-api.open-meteo.com", "api.open-meteo.com"] as const;

export interface WeatherReport {
	location: {
		name: string;
		admin1?: string;
		country?: string;
		latitude: number;
		longitude: number;
		timezone?: string;
	};
	current?: Record<string, string | number>;
	daily: Array<Record<string, string | number>>;
	sources: string[];
}

const WEATHER_CODES: Record<number, string> = {
	0: "Clear sky",
	1: "Mainly clear",
	2: "Partly cloudy",
	3: "Overcast",
	45: "Fog",
	48: "Depositing rime fog",
	51: "Light drizzle",
	53: "Moderate drizzle",
	55: "Dense drizzle",
	56: "Light freezing drizzle",
	57: "Dense freezing drizzle",
	61: "Slight rain",
	63: "Moderate rain",
	65: "Heavy rain",
	66: "Light freezing rain",
	67: "Heavy freezing rain",
	71: "Slight snowfall",
	73: "Moderate snowfall",
	75: "Heavy snowfall",
	77: "Snow grains",
	80: "Slight rain showers",
	81: "Moderate rain showers",
	82: "Violent rain showers",
	85: "Slight snow showers",
	86: "Heavy snow showers",
	95: "Thunderstorm",
	96: "Thunderstorm with slight hail",
	99: "Thunderstorm with heavy hail",
};

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value ? value : undefined;
}

function weatherLabel(value: unknown): string | undefined {
	const code = finiteNumber(value);
	return code === undefined ? undefined : WEATHER_CODES[code] ?? `Weather code ${code}`;
}

async function fetchJson(web: WebSandbox, url: URL, signal?: AbortSignal): Promise<Record<string, unknown>> {
	const response = await web.fetch(url.toString(), { maxBytes: 1024 * 1024, ...(signal ? { signal } : {}) });
	if (response.status < 200 || response.status >= 300) throw new SandboxError("network_failed", `Weather service returned HTTP ${response.status}`);
	try {
		const parsed = JSON.parse(response.content);
		const result = record(parsed);
		if (!result) throw new Error("root is not an object");
		return result;
	} catch (error) {
		throw new SandboxError("network_failed", `Weather service returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export async function queryWeather(
	web: WebSandbox,
	location: string,
	days: number,
	signal?: AbortSignal,
): Promise<WeatherReport> {
	const normalized = location.trim();
	if (!normalized) throw new SandboxError("network_failed", "Weather location must not be empty");
	const forecastDays = Math.min(7, Math.max(1, Math.floor(days)));
	const geocodingUrl = new URL("https://geocoding-api.open-meteo.com/v1/search");
	geocodingUrl.searchParams.set("name", normalized);
	geocodingUrl.searchParams.set("count", "1");
	geocodingUrl.searchParams.set("language", "zh");
	geocodingUrl.searchParams.set("format", "json");
	const geocoding = await fetchJson(web, geocodingUrl, signal);
	const match = Array.isArray(geocoding.results) ? record(geocoding.results[0]) : undefined;
	const latitude = finiteNumber(match?.latitude);
	const longitude = finiteNumber(match?.longitude);
	const name = stringValue(match?.name);
	if (!match || latitude === undefined || longitude === undefined || !name) {
		throw new SandboxError("network_failed", `No weather location matched ${JSON.stringify(normalized)}`);
	}

	const forecastUrl = new URL("https://api.open-meteo.com/v1/forecast");
	forecastUrl.searchParams.set("latitude", String(latitude));
	forecastUrl.searchParams.set("longitude", String(longitude));
	forecastUrl.searchParams.set("current", "temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m");
	forecastUrl.searchParams.set("daily", "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max");
	forecastUrl.searchParams.set("timezone", "auto");
	forecastUrl.searchParams.set("forecast_days", String(forecastDays));
	const forecast = await fetchJson(web, forecastUrl, signal);
	const current = record(forecast.current);
	const currentUnits = record(forecast.current_units);
	const daily = record(forecast.daily);
	const dailyUnits = record(forecast.daily_units);
	const times = Array.isArray(daily?.time) ? daily.time : [];

	const currentReport: Record<string, string | number> = {};
	for (const key of ["time", "temperature_2m", "apparent_temperature", "relative_humidity_2m", "precipitation", "wind_speed_10m"] as const) {
		const value = current?.[key];
		if (typeof value === "string" || typeof value === "number") {
			const unit = stringValue(currentUnits?.[key]);
			currentReport[key] = unit && key !== "time" ? `${value} ${unit}` : value;
		}
	}
	const currentCondition = weatherLabel(current?.weather_code);
	if (currentCondition) currentReport.condition = currentCondition;

	const dailyReport = times.slice(0, forecastDays).flatMap((time, index) => {
		if (typeof time !== "string") return [];
		const entry: Record<string, string | number> = { date: time };
		const mappings = [
			["temperature_2m_max", "temperature_max"],
			["temperature_2m_min", "temperature_min"],
			["precipitation_probability_max", "precipitation_probability_max"],
		] as const;
		for (const [source, target] of mappings) {
			const values = daily?.[source];
			const value = Array.isArray(values) ? values[index] : undefined;
			if (typeof value === "number") {
				const unit = stringValue(dailyUnits?.[source]);
				entry[target] = unit ? `${value} ${unit}` : value;
			}
		}
		const weatherCodes = daily?.weather_code;
		const condition = weatherLabel(Array.isArray(weatherCodes) ? weatherCodes[index] : undefined);
		if (condition) entry.condition = condition;
		return [entry];
	});

	return {
		location: {
			name,
			...(stringValue(match.admin1) ? { admin1: stringValue(match.admin1)! } : {}),
			...(stringValue(match.country) ? { country: stringValue(match.country)! } : {}),
			latitude,
			longitude,
			...(stringValue(forecast.timezone) ? { timezone: stringValue(forecast.timezone)! } : {}),
		},
		...(Object.keys(currentReport).length > 0 ? { current: currentReport } : {}),
		daily: dailyReport,
		sources: [geocodingUrl.toString(), forecastUrl.toString()],
	};
}
