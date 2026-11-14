import { describe, expect, it, vi } from "vitest";

import { AgentEventSchema, type AgentEvent, type Itinerary, type PlanRequest } from "../../../src/contracts/agent";
import type { AgentModel, ModelInput, ModelTurn } from "./model";
import { runPlanningAgent } from "./orchestrator";
import { createAgentTools } from "./tools/registry";
import type { Place } from "./tools/contracts";
import { AgentToolError } from "./tools/weather";

const request: PlanRequest = {
  sessionId: "orchestrator-test", mode: "live",
  setup: { city: "上海", date: "2026-11-14", startTime: "11:00", endTime: "18:00", budget: 300, startingArea: "徐汇滨江" },
  preferences: {
    a: { interests: ["展览"], pace: "轻松", walkingLimitKm: 3, indoorPreference: "室内优先", foodTags: [], budgetStyle: "平衡", avoid: [], wish: "private wish" },
    b: { interests: ["展览", "逛店"], pace: "平衡", walkingLimitKm: 5, indoorPreference: "均可", foodTags: [], budgetStyle: "平衡", avoid: [], wish: "" },
  },
};
const now = () => new Date("2026-11-11T00:00:00Z");
const places: Place[] = [10, 20, 30, 40].map((price, index) => ({
  placeId: `venue-${index}`, name: `场馆${index}`, category: "bookstore", area: "徐汇滨江", address: "测试地址",
  latitude: 31.17, longitude: 121.46 + index * 0.001, tags: ["书店", "展览"], indoor: true,
  priceRange: { min: price, max: price },
  weeklyOpeningHours: [{ days: ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"], intervals: [{ open: "10:00", close: "20:00" }] }],
  sourceUrl: "https://example.com/venue", lastVerifiedAt: "2026-11-11",
}));
const plans: Itinerary[] = [[0, 1], [0, 2], [1, 2]].map((pair, index) => ({
  id: `model-${index}`, title: `模型方案${index}`, summary: "模型组合", matchScore: 90,
  totalCost: 1, totalDistanceKm: 999, indoorRatio: 0, transfers: 49, reasons: ["共同兴趣"],
  stops: pair.map((placeIndex, stopIndex) => ({
    id: `stop-${index}-${stopIndex}`, placeId: places[placeIndex].placeId, name: "untrusted name", area: "untrusted area",
    latitude: 0, longitude: 0, tags: [], cost: 0, startTime: stopIndex ? "13:00" : "11:00",
    endTime: stopIndex ? "14:00" : "12:00", locked: false,
  })),
}));
const final: ModelTurn = { type: "final", consensus: { shared: ["展览"], conflicts: [], constraints: ["预算 300"] }, plans };
const weather = { source: "open-meteo" as const, hourly: [{ time: "2026-11-14T12:00", temperatureC: 20, precipitationProbability: 0, weatherCode: 0 }] };
const weatherCall = { type: "tool_call" as const, id: "weather-1", name: "get_weather", args: { latitude: 31.17, longitude: 121.46, start: "2026-11-14T11:00:00+08:00", end: "2026-11-14T18:00:00+08:00" } };

function scripted(turns: unknown[]) {
  const inputs: ModelInput[] = [];
  const model: AgentModel = { next: vi.fn(async (input) => { inputs.push(input); return turns[inputs.length - 1] as ModelTurn; }) };
  return { model, inputs };
}
function dependencies() {
  const tools = createAgentTools({ request, places, weather: async () => weather });
  vi.spyOn(tools, "get_weather");
  return { places, now, tools };
}
function candidates(events: AgentEvent[]) {
  return events.flatMap((event) => event.type === "plan.proposed" ? [event.plan] : []);
}

describe("controlled planning orchestrator", () => {
  it("passes QWeather observations to the model and publishes the actual provider and attribution", async () => {
    const script = scripted([weatherCall, final]);
    const qweather = { ...weather, source: "qweather" as const, weatherCodeSystem: "qweather" as const,
      attributions: ["https://developer.qweather.com/attribution.html"] };
    const tools = createAgentTools({ request, places, weather: async () => qweather });
    const events = await runPlanningAgent(request, { places, now, tools, model: script.model });
    expect(script.inputs[1].toolResults[0].output).toEqual(qweather);
    expect(events).toContainEqual(expect.objectContaining({ type: "tool.completed", tool: "get_weather", source: "qweather",
      summary: expect.objectContaining({ source: "qweather", attributions: ["https://developer.qweather.com/attribution.html"],
        hourlyCount: 1, temperatureMinC: 20, maxPrecipitationProbability: 0 }) }));
    expect(events.some(event => event.type === "run.degraded")).toBe(false);
    expect(candidates(events)).toHaveLength(3);
  });

  it("returns parallel results with original IDs, verifies three plans, and emits schema-valid events", async () => {
    const script = scripted([{ type: "tool_calls", calls: [
      { ...weatherCall, wireId: "weather-wire-1" },
      { id: "search-2", wireId: "search-wire-2", name: "search_places", args: { limit: 4 } },
    ] }, final]);
    const events = await runPlanningAgent(request, { ...dependencies(), model: script.model });
    expect(script.inputs).toHaveLength(2);
    expect(script.inputs[1].toolResults).toMatchObject([{ id: "weather-1", name: "get_weather" }, { id: "search-2", name: "search_places" }]);
    expect(script.inputs[1].toolResults.map((result) => result.wireId)).toEqual(["weather-wire-1", "search-wire-2"]);
    expect(events.filter((event) => event.type === "tool.completed")).toHaveLength(5);
    expect(events.filter((event) => event.type === "step.started").map((event) => event.step)).toEqual(["VALIDATE", "ANALYZE", "GATHER", "PROPOSE", "VERIFY"]);
    expect(events.every((event) => AgentEventSchema.safeParse(event).success)).toBe(true);
    expect(events.filter((event) => "at" in event).every((event) => event.at === "2026-11-11T00:00:00.000Z")).toBe(true);
    expect(candidates(events).map((plan) => plan.id)).toEqual([
      expect.stringMatching(/^plan-\d+-[a-f0-9-]+-candidate-1$/),
      expect.stringMatching(/^plan-\d+-[a-f0-9-]+-candidate-2$/),
      expect.stringMatching(/^plan-\d+-[a-f0-9-]+-candidate-3$/),
    ]);
    expect(events.at(-1)).toMatchObject({ type: "run.completed", result: { candidateIds: candidates(events).map((plan) => plan.id) } });
  });

  it("recomputes canonical stop prices, coordinates, route, indoor share, and budget before validation", async () => {
    const deps = dependencies();
    const validated: Itinerary[] = [];
    const validate = deps.tools.validate_plan;
    deps.tools.validate_plan = (input) => { validated.push(input.plan); return validate(input); };
    const events = await runPlanningAgent(request, { ...deps, model: scripted([final]).model });
    expect(validated).toHaveLength(3);
    expect(candidates(events).map((plan) => plan.totalCost)).toEqual([66, 88, 110]);
    expect(validated[0]).toMatchObject({ totalCost: 66, totalDistanceKm: 0.1, transfers: 0, indoorRatio: 100 });
    expect(validated[0].stops[0]).toMatchObject({ name: "场馆0", area: "徐汇滨江", cost: 20, latitude: 31.17, longitude: 121.46, tags: ["书店", "展览"] });
    expect(events.some((event) => event.type === "run.degraded")).toBe(false);
  });

  it("publishes only derived descriptions, scores, and consensus for model candidates", async () => {
    const untrusted = structuredClone(plans).map((plan) => ({ ...plan,
      id: `secret candidate ${plan.id}`,
      stops: plan.stops.map((stop) => ({ ...stop, id: `secret stop ${stop.id}` })),
      title: "secret api key", summary: "private wish invented venue", matchScore: 1,
      reasons: ["hidden reasoning"],
    }));
    const events = await runPlanningAgent(request, { ...dependencies(), model: scripted([{
      type: "final", consensus: { shared: ["invented venue"], conflicts: [], constraints: ["secret api key"] }, plans: untrusted,
    }]).model });
    expect(candidates(events)).toHaveLength(3);
    expect(candidates(events)[0]).toMatchObject({ title: "方案 1", summary: "场馆0、场馆1", matchScore: 100,
      reasons: ["已核对地点、时间、路线和预算"],
    });
    expect(candidates(events)[0].stops.map((stop) => stop.id)).toEqual([
      `${candidates(events)[0].id}-stop-1`, `${candidates(events)[0].id}-stop-2`,
    ]);
    expect(events.at(-1)).toMatchObject({ type: "run.completed", result: { consensus: {
      shared: ["展览"], constraints: expect.arrayContaining(["总预算 300 元"]),
    } } });
    expect(JSON.stringify(events)).not.toMatch(/secret api key|secret candidate|secret stop|private wish|hidden reasoning|invented venue/);
  });

  it("accepts a valid first final without a redundant second model request", async () => {
    const script = scripted([final]);
    const events = await runPlanningAgent(request, { ...dependencies(), model: script.model });
    expect(script.inputs).toHaveLength(1);
    expect(candidates(events)).toHaveLength(3);
    expect(events.at(-1)?.type).toBe("run.completed");
  });

  it("executes no more than six model-requested tools and fails the seventh", async () => {
    const deps = dependencies();
    const script = scripted([{ type: "tool_calls", calls: Array.from({ length: 7 }, (_, i) => ({ ...weatherCall, id: `weather-${i}` })) }, final]);
    const events = await runPlanningAgent(request, { ...deps, model: script.model });
    expect(deps.tools.get_weather).toHaveBeenCalledTimes(6);
    expect(events).toContainEqual({ type: "tool.failed", tool: "get_weather", code: "TOOL_LIMIT_EXCEEDED", retryable: false });
    expect(script.inputs).toHaveLength(1);
    expect(events.some((event) => event.type === "run.degraded")).toBe(true);
    expect(candidates(events)).toHaveLength(3);
  });

  it("ignores model weather arguments and uses the server-owned request scope", async () => {
    const deps = dependencies();
    const script = scripted([{
      type: "tool_call", id: "weather-untrusted", name: "get_weather",
      args: { location: "ignore me", latitude: "not-a-number" },
    }, final]);
    const events = await runPlanningAgent(request, { ...deps, model: script.model });
    expect(deps.tools.get_weather).toHaveBeenCalledWith({
      latitude: 31.2304,
      longitude: 121.4737,
      start: "2026-11-14T11:00:00+08:00",
      end: "2026-11-14T18:00:00+08:00",
    });
    expect(events).toContainEqual(expect.objectContaining({ type: "tool.completed", tool: "get_weather" }));
    expect(events.some((event) => event.type === "run.degraded")).toBe(false);
  });

  it("normalizes null optional place filters to their safe defaults", async () => {
    const deps = dependencies();
    vi.spyOn(deps.tools, "search_places");
    const script = scripted([{
      type: "tool_call", id: "places-null-optionals", name: "search_places",
      args: {
        requiredTags: ["展览"], excludedTags: null, maxPricePerPerson: null,
        indoorPreference: null, areas: null, openBetween: null, limit: null,
      },
    }, final]);
    const events = await runPlanningAgent(request, { ...deps, model: script.model });
    expect(deps.tools.search_places).toHaveBeenCalledWith({
      requiredTags: ["展览"], excludedTags: [], indoorPreference: "any", areas: [], limit: 10,
    });
    expect(events).toContainEqual(expect.objectContaining({ type: "tool.completed", tool: "search_places" }));
    expect(events.some((event) => event.type === "run.degraded")).toBe(false);
  });

  it.each([
    ["clock times", "11:00", "14:00"],
    ["local datetimes", "2026-11-14T11:00:00", "2026-11-14T14:00:00"],
    ["local datetimes without seconds", "2026-11-14T11:00", "2026-11-14T14:00"],
    ["space-separated datetimes", "2026-11-14 11:00", "2026-11-14 14:00"],
    ["explicit UTC", "2026-11-14T03:00:00Z", "2026-11-14T06:00:00Z"],
  ])("continues to weather and final proposals after a place search using %s", async (_label, start, end) => {
    const script = scripted([{ type: "tool_calls", calls: [
      { id: "places-time", name: "search_places", args: { openBetween: { start, end } } },
      weatherCall,
    ] }, final]);
    const events = await runPlanningAgent(request, { ...dependencies(), model: script.model });
    expect(script.inputs).toHaveLength(2);
    expect(script.inputs[1].toolResults[0]).toMatchObject({ name: "search_places", output: {
      places: [{ placeId: "venue-0" }, { placeId: "venue-1" }, { placeId: "venue-2" }, { placeId: "venue-3" }],
    } });
    expect(events).toContainEqual(expect.objectContaining({ type: "tool.completed", tool: "get_weather", source: "open-meteo" }));
    expect(events.some((event) => event.type === "run.degraded")).toBe(false);
    expect(candidates(events)).toHaveLength(3);
    expect(events.at(-1)?.type).toBe("run.completed");
  });

  it.each([
    ["invalid clock", "25:00", "26:00"],
    ["reversed interval", "14:00", "11:00"],
    ["invalid calendar date", "2026-11-31T11:00", "2026-11-31T14:00"],
    ["unparseable text", "tomorrow afternoon", "after dinner"],
    ["overlong interval", "2026-11-14T11:00", "2026-11-16T14:00"],
  ])("still rejects a place search with %s", async (_label, start, end) => {
    const script = scripted([{ type: "tool_call", id: "bad-time", name: "search_places", args: { openBetween: { start, end } } }]);
    const events = await runPlanningAgent(request, { ...dependencies(), model: script.model });
    expect(events).toContainEqual({ type: "tool.failed", tool: "search_places", code: "INVALID_TOOL_ARGUMENTS", retryable: false });
    expect(script.inputs).toHaveLength(1);
    expect(events).toContainEqual({ type: "run.degraded", reason: "INVALID_TOOL_ARGUMENTS", fallback: "rule-planner" });
  });

  it.each([
    ["shell", {}, "UNKNOWN_TOOL", "unknown"],
    ["toString", {}, "UNKNOWN_TOOL", "unknown"],
    ["estimate_route", { stops: [] }, "INVALID_TOOL_ARGUMENTS"],
    ["validate_plan", { plan: {} }, "INVALID_TOOL_ARGUMENTS"],
  ])("rejects %s with invalid or unknown arguments safely", async (name, args, code, publicName = name) => {
    const deps = dependencies();
    const script = scripted([{ type: "tool_call", id: "bad", name, args }]);
    const events = await runPlanningAgent(request, { ...deps, model: script.model });
    expect(events).toContainEqual({ type: "tool.failed", tool: publicName, code, retryable: false });
    expect(deps.tools.get_weather).not.toHaveBeenCalled();
    expect(events.some((event) => event.type === "run.degraded")).toBe(true);
    expect(candidates(events)).toHaveLength(3);
  });

  it("does not disclose an unknown tool name or an arbitrary tool error code", async () => {
    const secretName = "secret api key from model";
    const unknownEvents = await runPlanningAgent(request, { ...dependencies(), model: scripted([{
      type: "tool_call", id: "bad", name: secretName, args: {},
    }]).model });
    expect(unknownEvents).toContainEqual({ type: "tool.failed", tool: "unknown", code: "UNKNOWN_TOOL", retryable: false });
    expect(JSON.stringify(unknownEvents)).not.toContain(secretName);

    const deps = dependencies();
    deps.tools.get_weather = async () => { throw new AgentToolError("secret backend code", true); };
    const errorEvents = await runPlanningAgent(request, { ...deps, model: scripted([weatherCall]).model });
    expect(errorEvents).toContainEqual({ type: "tool.failed", tool: "get_weather", code: "TOOL_UNAVAILABLE", retryable: false });
    expect(errorEvents).toContainEqual({ type: "run.degraded", reason: "TOOL_UNAVAILABLE", fallback: "rule-planner" });
    expect(JSON.stringify(errorEvents)).not.toContain("secret backend code");
  });

  it.each([
    { type: "final", consensus: {}, plans: [] },
    { type: "final", consensus: final.consensus, plans: plans.slice(0, 2) },
    { type: "final", consensus: final.consensus, plans: [plans[0], plans[0], plans[0]] },
    weatherCall,
  ])("degrades an invalid second response immediately with no third request", async (invalid) => {
    const script = scripted([weatherCall, invalid, final]);
    const events = await runPlanningAgent(request, { ...dependencies(), model: script.model });
    expect(script.inputs).toHaveLength(2);
    expect(events.some((event) => event.type === "run.degraded")).toBe(true);
    expect(candidates(events)).toHaveLength(3);
    expect(candidates(events).every((plan) => plan.id.includes("-rule-"))).toBe(true);
  });

  it("uses request-scoped Shanghai weather for model results and fallback", async () => {
    const scopes: unknown[] = [];
    const tools = createAgentTools({ request, places, weather: async (scope) => {
      scopes.push(scope);
      return { source: "open-meteo", hourly: [{
        time: "2026-11-14T12:00", temperatureC: 20,
        precipitationProbability: scope.latitude === 35.68 ? 100 : 0, weatherCode: 0,
      }] };
    } });
    const foreignCall = { ...weatherCall, args: {
      latitude: 35.68, longitude: 139.69,
      start: "2026-11-15T11:00:00+09:00", end: "2026-11-15T18:00:00+09:00",
    } };
    const script = scripted([foreignCall, { type: "final", plans: [] }]);
    const events = await runPlanningAgent(request, { places, now, tools, model: script.model });
    expect(scopes).toEqual([{ latitude: 31.2304, longitude: 121.4737,
      start: "2026-11-14T11:00:00+08:00", end: "2026-11-14T18:00:00+08:00" }]);
    expect(script.inputs[1].toolResults[0].output).toMatchObject({ hourly: [{ precipitationProbability: 0 }] });
    expect(events).toContainEqual({ type: "run.degraded", reason: "INVALID_MODEL_RESULT", fallback: "rule-planner" });
    expect(candidates(events)).toHaveLength(3);
    expect(candidates(events).every((plan) => plan.reasons.every((reason) => !reason.includes("降雨")))).toBe(true);
  });

  it("uses a next-day Shanghai midnight end for a 24:00 request", async () => {
    const scopes: unknown[] = [];
    const midnightRequest = { ...request, setup: { ...request.setup, endTime: "24:00" } };
    const tools = createAgentTools({ request: midnightRequest, places, weather: async (scope) => {
      scopes.push(scope);
      return weather;
    } });
    await tools.get_weather({ latitude: 35.68, longitude: 139.69,
      start: "2026-11-15T11:00:00+09:00", end: "2026-11-15T18:00:00+09:00" });
    expect(scopes).toEqual([{ latitude: 31.2304, longitude: 121.4737,
      start: "2026-11-14T11:00:00+08:00", end: "2026-11-15T00:00:00+08:00" }]);
  });

  it.each(["price", "schedule", "unknown place", "avoidance"])("rejects model candidates violating verified %s constraints", async (kind) => {
    const modified = structuredClone(plans);
    const deps = dependencies();
    if (kind === "price") deps.places = places.map((place) => ({ ...place, priceRange: { min: 180, max: 180 } }));
    if (kind === "schedule") modified[0].stops[1].startTime = "11:00";
    if (kind === "unknown place") modified[0].stops[0].placeId = "hallucinated";
    const input = kind === "avoidance" ? { ...request, preferences: { ...request.preferences, a: { ...request.preferences.a, avoid: ["书店"] } } } : request;
    deps.tools = createAgentTools({ request: input, places: deps.places, weather: async () => weather });
    const events = await runPlanningAgent(input, { ...deps, model: scripted([{ ...final, plans: modified }]).model });
    expect(events.some((event) => event.type === "run.degraded")).toBe(true);
    expect(candidates(events).every((plan) => !plan.id.startsWith("model-"))).toBe(true);
  });

  it("uses deterministic rule plans immediately when no model is supplied", async () => {
    const events = await runPlanningAgent(request, dependencies());
    expect(events).toContainEqual({ type: "run.degraded", reason: "MODEL_UNAVAILABLE", fallback: "rule-planner" });
    expect(candidates(events)).toHaveLength(3);
    expect(candidates(events).every((plan) => plan.id.includes("-rule-"))).toBe(true);
    expect(events.at(-1)?.type).toBe("run.completed");
  });

  it("uses distinct run IDs when two runs start at the same clock time", async () => {
    const [first, second] = await Promise.all([
      runPlanningAgent(request, dependencies()), runPlanningAgent(request, dependencies()),
    ]);
    const firstId = first.find((event) => event.type === "run.started")?.runId;
    const secondId = second.find((event) => event.type === "run.started")?.runId;
    expect(firstId).toBeTruthy();
    expect(secondId).toBeTruthy();
    expect(firstId).not.toBe(secondId);
  });

  it("degrades a model exception without exposing its sensitive error", async () => {
    const events = await runPlanningAgent(request, { ...dependencies(), model: { next: async () => { throw new Error("secret api key private wish"); } } });
    expect(events).toContainEqual({ type: "run.degraded", reason: "MODEL_UNAVAILABLE", fallback: "rule-planner" });
    expect(JSON.stringify(events)).not.toMatch(/secret api key|private wish/);
    expect(events.at(-1)?.type).toBe("run.completed");
  });

  it("degrades a tool exception safely", async () => {
    const deps = dependencies();
    deps.tools.get_weather = async () => { throw new Error("secret details"); };
    const events = await runPlanningAgent(request, { ...deps, model: scripted([weatherCall]).model });
    expect(events).toContainEqual({ type: "tool.failed", tool: "get_weather", code: "TOOL_UNAVAILABLE", retryable: false });
    expect(candidates(events)).toHaveLength(3);
    expect(JSON.stringify(events)).not.toContain("secret details");
  });

  it("fails safely when fallback cannot find three valid candidates", async () => {
    const events = await runPlanningAgent(request, { ...dependencies(), places: [] });
    expect(candidates(events)).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({ type: "run.failed", code: "NO_VALID_PLAN" });
    expect(events.every((event) => AgentEventSchema.safeParse(event).success)).toBe(true);
  });

  it("rejects invalid requests before any model call", async () => {
    const script = scripted([final]);
    const events = await runPlanningAgent({ ...request, setup: { ...request.setup, budget: 1 } }, { ...dependencies(), model: script.model });
    expect(script.inputs).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({ type: "run.failed", code: "INVALID_REQUEST" });
  });
});

it("publishes typed public weather/place/verification evidence and stale warnings without raw preferences", async () => {
  const stale = places.map((place) => ({ ...place, lastVerifiedAt: "2026-01-01" }));
  const tools = createAgentTools({ request, places: stale, weather: async () => weather });
  const script = scripted([{ type: "tool_calls", calls: [weatherCall,
    { id: "places", name: "search_places", args: { limit: 4 } },
  ] }, final]);
  const events = await runPlanningAgent(request, { places: stale, now, tools, model: script.model });
  const evidence = (tool: string) => events.filter((event) => event.type === "tool.completed" && event.tool === tool).at(-1);
  expect(evidence("get_weather")).toMatchObject({ summary: { source: "open-meteo", reference: "上海", interval: {
    start: "2026-11-14T11:00:00+08:00", end: "2026-11-14T18:00:00+08:00",
  }, hourlyCount: 1, temperatureMinC: 20, temperatureMaxC: 20, maxPrecipitationProbability: 0 } });
  expect(evidence("search_places")).toMatchObject({ summary: { source: "curated-shanghai-catalog", matchedCount: 4,
    selectedPlaces: expect.arrayContaining([{ placeId: "venue-0", name: "场馆0", lastVerifiedAt: "2026-01-01" }]),
  } });
  expect(evidence("estimate_route")).toMatchObject({ summary: { candidateCount: 3, estimated: true,
    minDistanceKm: 0.1, maxDistanceKm: 0.19, minWalkingDistanceKm: 0.1, maxWalkingDistanceKm: 0.19,
  } });
  expect(evidence("calculate_budget")).toMatchObject({ summary: { candidateCount: 3, minTotal: 66, maxTotal: 110, budgetLimit: 300, withinBudgetCount: 3 } });
  expect(evidence("validate_plan")).toMatchObject({ summary: { validCandidateCount: 3, invalidCandidateCount: 0,
    candidates: expect.arrayContaining([expect.objectContaining({ candidateId: expect.any(String), violationCodes: [], warningCodes: ["STALE_PLACE_DATA"] })]),
  } });
  expect(JSON.stringify(events)).not.toMatch(/private wish|hidden reasoning|测试地址|sourceUrl|apiKey/);
});

it("stops event delivery immediately when an injected sink throws during tool completion", async () => {
  let deliveries = 0;
  let failed = false;
  const deps = dependencies();
  await expect(runPlanningAgent(request, { ...deps, model: scripted([weatherCall, final]).model,
    onEvent: (event) => {
      if (failed) throw new Error("second delivery");
      deliveries++;
      if (event.type === "tool.completed") { failed = true; throw new Error("sink disconnected"); }
    },
  })).rejects.toThrow("sink disconnected");
  expect(deliveries).toBe(5);
});

it("does not publish arbitrary free-text avoidance labels or food tags", async () => {
  const privateRequest = structuredClone(request);
  privateRequest.preferences.a.avoid = ["private avoid"];
  privateRequest.preferences.a.foodTags = ["private food"];
  const events = await runPlanningAgent(privateRequest, dependencies());
  expect(events.at(-1)?.type).toBe("run.completed");
  expect(JSON.stringify(events)).not.toMatch(/private avoid|private food|private wish/);
});
