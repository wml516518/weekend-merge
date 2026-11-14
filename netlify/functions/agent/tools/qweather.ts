import { z } from "zod";
import type { WeatherInput, WeatherOutput } from "./weather";

export type WeatherEnvironment = { QWEATHER_API_HOST?: string; QWEATHER_API_KEY?: string };
const HOUR_MS = 3_600_000;
const OFFSET_MS = 8 * HOUR_MS;
const timestamp = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})$/)
  .refine(value => {
    const [year, month, day] = value.slice(0, 10).split("-").map(Number);
    return Number.isFinite(Date.parse(value)) &&
      new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10) === value.slice(0, 10);
  });
const ForecastSchema = z.object({
  metadata: z.object({ attributions: z.array(z.string().min(1)).min(1) }),
  hours: z.array(z.object({
    forecastTime: timestamp,
    temperature: z.object({ value: z.number().finite(), unit: z.literal("°C") }),
    precipitation: z.object({ probability: z.number().finite().min(0).max(1) }),
    condition: z.object({ code: z.string().regex(/^\d+$/) }),
  })).min(1).max(240),
});

/** Current QWeather v1 uses fractions for rain and its own condition-code system. */
export async function fetchQWeather(input: WeatherInput, env: WeatherEnvironment,
  fetcher: typeof fetch, now: Date): Promise<WeatherOutput> {
  const host = env.QWEATHER_API_HOST?.trim();
  const key = env.QWEATHER_API_KEY?.trim();
  // Keys must never be sent to arbitrary URLs, localhost, paths or query strings.
  if (!key || !host || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.qweatherapi\.com$/i.test(host)) {
    throw new Error("Weather fallback is not configured");
  }
  const start = Date.parse(input.start);
  const end = Date.parse(input.end);
  const hours = Math.ceil((end - now.getTime()) / HOUR_MS);
  if (start < now.getTime() || hours < 1 || hours > 240) throw new Error("Weather outside forecast horizon");

  const url = new URL(`https://${host}/weather/v1/hourly/${input.latitude.toFixed(2)}/${input.longitude.toFixed(2)}`);
  url.searchParams.set("hours", String(hours));
  const response = await fetcher(url.toString(), {
    headers: { "X-QW-Api-Key": key }, signal: AbortSignal.timeout(4000), redirect: "error",
  });
  if (!response.ok) throw new Error("Weather fallback request failed");
  const forecast = ForecastSchema.parse(await response.json());
  const hourly = forecast.hours.filter(hour => {
    const time = Date.parse(hour.forecastTime);
    return time >= start && time < end;
  }).map(hour => ({
    time: new Date(Date.parse(hour.forecastTime) + OFFSET_MS).toISOString().slice(0, 16),
    temperatureC: hour.temperature.value,
    precipitationProbability: Math.round(hour.precipitation.probability * 100),
    weatherCode: Number(hour.condition.code),
  })).sort((a, b) => a.time.localeCompare(b.time));

  // A short/partial response must not masquerade as weather for a later outing.
  const expected: string[] = [];
  for (let hour = Math.ceil(start / HOUR_MS) * HOUR_MS; hour < end; hour += HOUR_MS) {
    expected.push(new Date(hour + OFFSET_MS).toISOString().slice(0, 16));
  }
  if (!expected.length || hourly.length !== expected.length || hourly.some((hour, i) => hour.time !== expected[i])) {
    throw new Error("Weather fallback does not cover the outing");
  }
  return { source: "qweather", weatherCodeSystem: "qweather", attributions: forecast.metadata.attributions, hourly };
}
