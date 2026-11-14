import { afterEach, describe, expect, it, vi } from "vitest";
import demoRequest from "../../../tests/fixtures/plan-request.demo.json";
import { AgentEventSchema, PlanRequestSchema } from "../../../src/contracts/agent";
import { createPlanHandler } from "../plan";
import { createPlanningLimiter } from "../agent/requestProtection";
const now = () => new Date("2026-11-12T00:00:00Z");
const handler = createPlanHandler({ now, limiter: createPlanningLimiter() });

const url = "http://localhost/.netlify/functions/plan";
const post = (body: unknown) => new Request(url, { method: "POST", body: JSON.stringify(body) });
afterEach(() => vi.unstubAllGlobals());

describe("plan function", () => {
  it("uses server-supplied QWeather configuration without exposing credentials in NDJSON", async () => {
    vi.stubGlobal("fetch", async (target: string) => {
      const targetUrl = new URL(target);
      if (targetUrl.hostname === "api.open-meteo.com") return new Response(null, { status: 503 });
      expect(targetUrl.hostname).toBe("localtest.qweatherapi.com");
      return Response.json({ metadata: { attributions: ["https://developer.qweather.com/attribution.html"] },
        hours: [3, 4, 5, 6, 7, 8, 9].map(hour => ({ forecastTime: `2026-11-14T0${hour}:00Z`,
          temperature: { value: 20, unit: "°C" }, precipitation: { probability: 0.5 }, condition: { code: "305" } })) });
    });
    let turns = 0;
    const response = await createPlanHandler({ now, limiter: createPlanningLimiter(),
      env: { DEEPSEEK_API_KEY: "test-model-key", QWEATHER_API_HOST: "localtest.qweatherapi.com", QWEATHER_API_KEY: "test-weather-key" },
      createModel: () => ({ next: async () => {
        if (turns++ === 0) return { type: "tool_call", id: "weather", name: "get_weather", args: {} };
        throw new Error("skip final model generation");
      } }),
    })(post({ ...demoRequest, setup: { ...demoRequest.setup, startTime: "11:00", endTime: "18:00" }, mode: "live" }));
    const text = await response.text();
    const events = text.trim().split("\n").map(line => JSON.parse(line));
    expect(events).toContainEqual(expect.objectContaining({ type: "tool.completed", tool: "get_weather", source: "qweather",
      summary: expect.objectContaining({ hourlyCount: 7, maxPrecipitationProbability: 50 }) }));
    expect(text).not.toMatch(/test-model-key|test-weather-key|skip final model/);
  });

  it("accepts POST only and returns the public error envelope", async () => {
    const response = await handler(new Request(url));
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    expect(await response.json()).toMatchObject({ error: { code: "METHOD_NOT_ALLOWED", retryable: false } });
  });

  it.each(["{", "null", "[]", JSON.stringify({ sessionId: "missing-fields" }),
    JSON.stringify({ ...demoRequest, setup: { ...demoRequest.setup, date: "2026-11-31" } }),
  ])("rejects invalid input without exposing validation internals: %s", async (body) => {
    const response = await handler(new Request(url, { method: "POST", body }));
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("application/json");
    const payload = await response.json();
    expect(payload).toMatchObject({ error: { code: "INVALID_REQUEST", message: expect.any(String), retryable: false } });
    expect(JSON.stringify(payload)).not.toMatch(/Zod|issues|invalid_type|stack/);
  });

  it("returns deterministic valid demo events for the committed complete request", async () => {
    expect(PlanRequestSchema.safeParse(demoRequest).success).toBe(true);
    const first = await handler(post(demoRequest));
    const second = await handler(post(demoRequest));
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toBe("application/x-ndjson; charset=utf-8");
    expect(first.headers.get("cache-control")).toBe("no-store");
    const text = await first.text();
    expect(text).toBe(await second.text());
    const events = text.trim().split("\n").map((line) => AgentEventSchema.parse(JSON.parse(line)));
    expect(events[0]).toMatchObject({ type: "run.started", runId: demoRequest.sessionId });
    expect(events.filter((event) => event.type === "plan.proposed")).toHaveLength(3);
    expect(events.filter((event) => ["run.completed", "run.failed"].includes(event.type))).toHaveLength(1);
    expect(events.at(-1)?.type).toBe("run.completed");
  });

  it("visibly degrades a live no-key request to three verified local plans without network", async () => {
    const fetch = vi.fn(() => { throw new Error("Network must not be used"); });
    vi.stubGlobal("fetch", fetch);
    const response = await createPlanHandler({ now, limiter: createPlanningLimiter(), env: {} })(post({ ...demoRequest, mode: "live" }));
    expect(response.status).toBe(200);
    const events = (await response.text()).trim().split("\n").map((line) => AgentEventSchema.parse(JSON.parse(line)));
    expect(events).toContainEqual({ type: "run.degraded", reason: "MODEL_UNAVAILABLE", fallback: "rule-planner" });
    expect(events.filter((event) => event.type === "plan.proposed")).toHaveLength(3);
    expect(events.at(-1)?.type).toBe("run.completed");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([{ DEEPSEEK_API_KEY: " " }, {}])(
    "does not construct DeepSeek without an API key", async (env) => {
      let constructions = 0;
      const response = await createPlanHandler({ now, limiter: createPlanningLimiter(), env, createModel: () => { constructions += 1; throw new Error("Must not construct DeepSeek"); } })(post({ ...demoRequest, mode: "live" }));
      const text = await response.text();
      expect(constructions).toBe(0);
      expect(response.status).toBe(200);
      expect(text).toContain('"reason":"MODEL_UNAVAILABLE"');
      expect(text).not.toContain("secret");
    },
  );

  it("uses the configured model with a server-owned registry", async () => {
    let turns = 0;
    const response = await createPlanHandler({ now, limiter: createPlanningLimiter(),
      env: { DEEPSEEK_API_KEY: "test-key", DEEPSEEK_MODEL: "test-model" },
      createModel: () => ({ next: async () => { turns += 1; throw new Error("Unavailable test model"); } }),
    })(post({ ...demoRequest, mode: "live", places: [], tools: { validate_plan: "fake" } }));
    const text = await response.text();
    expect(turns).toBe(1);
    expect(text).toContain('"type":"run.completed"');
    expect(text).not.toMatch(/test-key|test-model|Unavailable test model/);
  });

  it("degrades a model-construction failure without exposing configuration or the raw error", async () => {
    const response = await createPlanHandler({ now, limiter: createPlanningLimiter(), env: { DEEPSEEK_API_KEY: "secret-key", DEEPSEEK_MODEL: "test-model" },
      createModel: () => { throw new Error("private SDK construction failure secret-key"); },
    })(post({ ...demoRequest, mode: "live" }));
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).toContain('"reason":"MODEL_UNAVAILABLE"');
    expect(text).toContain('"type":"run.completed"');
    expect(text).not.toMatch(/private SDK|secret-key|test-model/);
  });

  it("emits one failed terminal when the valid live request cannot produce verified rule plans", async () => {
    const response = await createPlanHandler({ now, limiter: createPlanningLimiter(), env: {} })(post({ ...demoRequest, mode: "live", setup: {
      ...demoRequest.setup, startTime: "21:00", endTime: "24:00",
    } }));
    expect(response.status).toBe(200);
    const events = (await response.text()).trim().split("\n").map((line) => AgentEventSchema.parse(JSON.parse(line)));
    expect(events.filter((event) => ["run.completed", "run.failed"].includes(event.type))).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: "run.failed", code: "NO_VALID_PLAN" });
  });
});
