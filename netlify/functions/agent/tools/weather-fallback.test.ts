import { describe, expect, it, vi } from "vitest";
import { createWeatherTool } from "./weather";

const input = { latitude: 31.2304, longitude: 121.4737,
  start: "2026-11-14T12:00:00+08:00", end: "2026-11-14T14:00:00+08:00" };
const now = () => new Date("2026-11-14T00:00:00Z");
const env = { QWEATHER_API_HOST: "example.qweatherapi.com", QWEATHER_API_KEY: "test-weather-secret" };
const forecast = {
  metadata: { tag: "test", attributions: ["https://www.qweather.com"] },
  hours: [
    { forecastTime: "2026-11-14T04:00Z", temperature: { value: 17.5, unit: "°C" },
      precipitation: { probability: 0.65 }, condition: { code: "305", text: "小雨" } },
    { forecastTime: "2026-11-14T13:00+08:00", temperature: { value: 18, unit: "°C" },
      precipitation: { probability: 0.1 }, condition: { code: "100", text: "晴" } },
  ],
};

describe("QWeather fallback", () => {
  it("returns a real hourly fallback with converted units, Shanghai time and honest attribution", async () => {
    const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
      if (url.startsWith("https://api.open-meteo.com/")) throw new Error("connection timeout");
      const query = new URL(url);
      expect(query.origin + query.pathname).toBe("https://example.qweatherapi.com/weather/v1/hourly/31.23/121.47");
      expect(Number(query.searchParams.get("hours"))).toBeGreaterThanOrEqual(6);
      expect(new Headers(options?.headers).get("X-QW-Api-Key")).toBe("test-weather-secret");
      expect(url).not.toContain("test-weather-secret");
      expect(options?.signal).toBeInstanceOf(AbortSignal);
      return Response.json(forecast);
    });
    const weather = createWeatherTool({ fetch: fetcher, now, env });
    expect(await weather(input)).toEqual({
      source: "qweather", weatherCodeSystem: "qweather",
      attributions: ["https://www.qweather.com"],
      hourly: [
        { time: "2026-11-14T12:00", temperatureC: 17.5, precipitationProbability: 65, weatherCode: 305 },
        { time: "2026-11-14T13:00", temperatureC: 18, precipitationProbability: 10, weatherCode: 100 },
      ],
    });
    await weather(input);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("falls back when Open-Meteo returns no hours for the requested outing", async () => {
    const fetcher = vi.fn(async (url: string) => url.includes("open-meteo")
      ? Response.json({ hourly: { time: ["2026-11-14T10:00"], temperature_2m: [20], precipitation_probability: [0], weather_code: [0] } })
      : Response.json(forecast));
    expect((await createWeatherTool({ fetch: fetcher, now, env })(input)).source).toBe("qweather");
  });

  it("supports an API host under the shared QWeather regional subdomain", async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (url.startsWith("https://api.open-meteo.com/")) throw new Error("connection timeout");
      expect(new URL(url).origin).toBe("https://nh2yw3hdrc.re.qweatherapi.com");
      return Response.json(forecast);
    });
    const weather = createWeatherTool({
      fetch: fetcher,
      now,
      env: { ...env, QWEATHER_API_HOST: "nh2yw3hdrc.re.qweatherapi.com" },
    });
    expect((await weather(input)).source).toBe("qweather");
  });

  it("keeps a successful Open-Meteo request free of authenticated fallback calls", async () => {
    const fetcher = vi.fn(async () => Response.json({ hourly: {
      time: ["2026-11-14T12:00"], temperature_2m: [17], precipitation_probability: [20], weather_code: [0],
    } }));
    expect((await createWeatherTool({ fetch: fetcher, now, env })(input)).source).toBe("open-meteo");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["missing key", { QWEATHER_API_HOST: env.QWEATHER_API_HOST }],
    ["untrusted host", { ...env, QWEATHER_API_HOST: "http://127.0.0.1:8787" }],
    ["host with path", { ...env, QWEATHER_API_HOST: "example.qweatherapi.com/other" }],
  ])("does not send credentials with %s", async (_name, config) => {
    const fetcher = vi.fn(async () => { throw new Error("unavailable"); });
    await expect(createWeatherTool({ fetch: fetcher, now, env: config })(input))
      .rejects.toMatchObject({ code: "WEATHER_UNAVAILABLE", retryable: true });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["missing probability", { ...forecast.hours[0], precipitation: {} }],
    ["wrong temperature unit", { ...forecast.hours[0], temperature: { value: 63, unit: "°F" } }],
    ["probability outside range", { ...forecast.hours[0], precipitation: { probability: 65 } }],
    ["invalid timestamp", { ...forecast.hours[0], forecastTime: "2026-02-30T12:00+08:00" }],
  ])("rejects %s rather than inventing weather", async (_name, hour) => {
    const fetcher = vi.fn(async (url: string) => url.includes("open-meteo")
      ? new Response(null, { status: 503 }) : Response.json({ ...forecast, hours: [hour, forecast.hours[1]] }));
    await expect(createWeatherTool({ fetch: fetcher, now, env })(input))
      .rejects.toMatchObject({ code: "WEATHER_UNAVAILABLE", retryable: true });
  });

  it("rejects an incomplete forecast and evicts failed fallback results so a later request can recover", async () => {
    let complete = false;
    const fetcher = vi.fn(async (url: string) => url.includes("open-meteo")
      ? new Response(null, { status: 503 })
      : Response.json({ ...forecast, hours: complete ? forecast.hours : forecast.hours.slice(0, 1) }));
    const weather = createWeatherTool({ fetch: fetcher, now, env });
    await expect(weather(input)).rejects.toMatchObject({ code: "WEATHER_UNAVAILABLE" });
    complete = true;
    expect((await weather(input)).hourly).toHaveLength(2);
  });

  it("does not spend a QWeather request for dates beyond its 240 hour horizon", async () => {
    const fetcher = vi.fn(async () => { throw new Error("unavailable"); });
    await expect(createWeatherTool({ fetch: fetcher, now: () => new Date("2026-11-01T00:00Z"), env })(input))
      .rejects.toMatchObject({ code: "WEATHER_UNAVAILABLE" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403, 429, 500])("reports QWeather HTTP %i without leaking the key or upstream response", async status => {
    const fetcher = vi.fn(async (url: string) => url.includes("open-meteo")
      ? new Response(null, { status: 503 }) : new Response("test-weather-secret", { status }));
    await expect(createWeatherTool({ fetch: fetcher, now, env })(input))
      .rejects.toMatchObject({ message: "WEATHER_UNAVAILABLE", retryable: true });
  });

  it("coalesces concurrent fallbacks and refetches after the thirty minute cache expires", async () => {
    let clock = new Date("2026-11-14T00:00:00Z");
    let fallbackCalls = 0;
    const fetcher = vi.fn(async (url: string) => {
      if (url.includes("open-meteo")) throw new Error("timeout");
      fallbackCalls++;
      return Response.json(forecast);
    });
    const weather = createWeatherTool({ fetch: fetcher, now: () => clock, env });
    const results = await Promise.all([weather(input), weather(input)]);
    expect(results.map(result => result.source)).toEqual(["qweather", "qweather"]);
    expect(fallbackCalls).toBe(1);
    clock = new Date("2026-11-14T00:30:00Z");
    await weather(input);
    expect(fallbackCalls).toBe(2);
  });
});
