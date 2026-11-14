import { describe, expect, it } from "vitest";
import * as contracts from "../../../src/contracts/agent";
import { type AgentEvent, type Itinerary, type PersonPreferences, type PlanRequest } from "../../../src/contracts/agent";
import { createReplanHandler } from "../replan";
import { createDeepSeekModel } from "./deepseek";
import { analyzeConsensus } from "./fallbacks/consensus";
import { createRulePlans, NoValidPlanError } from "./fallbacks/rulePlanner";
import { type ModelInput } from "./model";
import { runPlanningAgent } from "./orchestrator";
import { type Place } from "./tools/contracts";
import { shanghaiPlaces } from "./tools/places";
import { effectiveWalkingLimitKm } from "./tools/preferences";
import { createAgentTools } from "./tools/registry";

const basePreferences: PersonPreferences = {
  interests: ["展览"], pace: "平衡", walkingLimitKm: 8, indoorPreference: "均可",
  foodTags: [], budgetStyle: "平衡", avoid: [], wish: "",
};
function request(): PlanRequest {
  return {
    sessionId: "group-test", mode: "live",
    setup: { city: "上海", date: "2026-11-14", startTime: "10:00", endTime: "20:00", budget: 12000, startingArea: "徐汇滨江" },
    preferences: { participants: Array.from({ length: 6 }, (_, index) => ({
      id: `private-nickname-${index}`, preferences: { ...basePreferences, wish: `wish-${index}`, foodTags: [`food-${index}`] },
    })) },
  };
}
const places: Place[] = Array.from({ length: 4 }, (_, index) => ({
  ...shanghaiPlaces[0], placeId: `venue-${index}`, name: `地点 ${index}`, category: "cafe", indoor: true,
  latitude: 31.2 + index * 0.025, longitude: 121.4,
  tags: [index === 0 ? "咖啡" : "展览"], priceRange: { min: 10, max: 20 },
  weeklyOpeningHours: [{ days: ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"], intervals: [{ open: "09:00", close: "22:00" }] }],
  lastAdmissionTime: undefined,
}));
function proposal(venues: Place[], id = "original"): Itinerary {
  return {
    id, title: "行程", summary: "行程", matchScore: 80, totalCost: 0, totalDistanceKm: 0, indoorRatio: 100, transfers: 0,
    stops: venues.map((place, index) => ({
      id: `${id}-stop-${index}`, placeId: place.placeId, name: place.name, area: place.area,
      latitude: place.latitude, longitude: place.longitude, tags: place.tags, cost: 0, locked: false,
      startTime: `${11 + index * 3}:00`, endTime: `${11 + index * 3}:45`,
    })), reasons: ["行程"],
  };
}
function proposed(events: AgentEvent[]): Itinerary[] {
  return events.filter((event) => event.type === "plan.proposed").map((event) => event.plan);
}
const now = () => new Date("2026-11-12T00:00:00Z");

describe("group planning contracts and real core", () => {
  it("normalizes six participants and preserves legacy inputs without leaking legacy fields into group snapshots", () => {
    const input = request();
    const parsed = contracts.PlanRequestSchema.parse(input);
    expect(contracts.getParticipants(parsed.preferences)).toHaveLength(6);
    expect(parsed.preferences).not.toHaveProperty("a");
    expect(contracts.getParticipants({ a: basePreferences, b: basePreferences }).map((person) => person.id)).toEqual(["member-1", "member-2"]);
  });

  it("retains the legacy 2000 yuan ceiling while allowing 4000 for an explicit two-member group", () => {
    const input = request();
    input.setup.budget = 2001;
    input.preferences = { a: basePreferences, b: basePreferences };
    expect(contracts.PlanRequestSchema.safeParse(input).success).toBe(false);
    input.preferences = { participants: [{ id: "one", preferences: basePreferences }, { id: "two", preferences: basePreferences }] };
    input.setup.budget = 4000;
    expect(contracts.PlanRequestSchema.safeParse(input).success).toBe(true);
  });

  it.each([
    ["legacy", 2000, true], ["legacy", 2001, false],
    ["group", 12000, true], ["group", 12001, false],
  ] as const)("enforces the same replan budget boundary for %s at %s", (kind, budget, accepted) => {
    const input = request();
    input.setup.budget = budget;
    if (kind === "legacy") input.preferences = { a: basePreferences, b: basePreferences };
    const plan = proposal(places.slice(0, 2));
    expect(contracts.ReplanRequestSchema.safeParse({
      ...input, plan, lockedStopIds: [], rejectedStopId: plan.stops[0].id, reason: "更换地点", replanCount: 0,
    }).success).toBe(accepted);
  });

  it.each([null, {}, { participants: null }, { participants: [{}] }, { a: {} }])("rejects malformed preferences without throwing: %j", (preferences) => {
    expect(contracts.PlanRequestSchema.safeParse({ ...request(), preferences }).success).toBe(false);
  });

  it.each([1, 7, "duplicate", "mixed", "group-budget", "legacy-budget"])("rejects invalid participant identities or request budget: %s", (kind) => {
    const input = request();
    if (typeof kind === "number") input.preferences.participants = Array.from({ length: kind }, (_, index) => ({ id: String(index), preferences: basePreferences }));
    if (kind === "duplicate") input.preferences.participants[5].id = input.preferences.participants[0].id;
    if (kind === "mixed") Object.assign(input.preferences, { a: basePreferences, b: basePreferences });
    if (kind === "group-budget") input.preferences.participants = input.preferences.participants.slice(0, 2).map((person, index) =>
      index === 0 ? { ...person, preferences: { ...basePreferences, interests: ["咖啡"] } } : person);
    if (kind === "legacy-budget") input.preferences = { a: basePreferences, b: basePreferences };
    expect(contracts.PlanRequestSchema.safeParse(input).success).toBe(false);
  });

  it("charges six venue tickets and six transit allowances plus a ten-percent buffer in both model verification and rules", async () => {
    const input = request();
    const plans = [proposal(places.slice(0, 2), "one"), proposal(places.slice(1, 3), "two"), proposal([places[0], places[2]], "three")];
    const events = await runPlanningAgent(input, { places, model: { next: async () => ({ type: "final", plans, consensus: { shared: [], conflicts: [], constraints: [] } }) } });
    expect(proposed(events)).toHaveLength(3);
    for (const plan of [...proposed(events), ...createRulePlans({ request: input, places })]) {
      expect(plan.stops.map((stop) => stop.cost)).toEqual([120, 120]);
      expect(plan.transfers).toBe(1);
      expect(plan.totalCost).toBe(290.4); // (20 * 6 * 2 + 4 * 6) * 1.1
    }
  });

  it("applies the last member's walking cap and union of avoidances through the real validation tool", async () => {
    const input = request();
    input.preferences.participants[5].preferences = { ...basePreferences, walkingLimitKm: 1, avoid: ["咖啡"] };
    expect(effectiveWalkingLimitKm(input.preferences)).toBe(1);
    const result = await createAgentTools({ request: input, places }).validate_plan({ plan: proposal(places.slice(0, 2)), walkingDistanceKm: 2 });
    expect(result.violations.map((violation) => violation.code)).toEqual(expect.arrayContaining(["WALKING_LIMIT_EXCEEDED", "AVOID_TAG_MATCHED"]));
    const plans = createRulePlans({ request: input, places });
    expect(plans.every((plan) => plan.stops.every((stop) => !stop.tags.includes("咖啡")))).toBe(true);
  });

  it("counts member support before rank and does not claim unanimity for a majority interest", () => {
    const input = request();
    input.preferences.participants[0].preferences = { ...basePreferences, interests: ["咖啡"] };
    const plans = createRulePlans({ request: input, places });
    expect(plans[0].stops.some((stop) => stop.tags.includes("展览"))).toBe(true);
    expect(plans[0].reasons.join(" ")).toContain("5/6");
    expect(plans[0].reasons.join(" ")).not.toMatch(/双方共同|全员共同/);
    expect(analyzeConsensus(input).shared).toEqual([]);
    expect(analyzeConsensus(input)).toMatchObject({ interestSupport: [
      { interest: "展览", count: 5, total: 6 }, { interest: "咖啡", count: 1, total: 6 },
    ] });
    expect(JSON.stringify(analyzeConsensus(input))).not.toMatch(/wish-|food-|private-nickname/);
  });

  it("scores model plans by member support rather than the number of distinct interests", async () => {
    const input = request();
    input.preferences.participants[0].preferences = { ...basePreferences, interests: ["咖啡"] };
    const catalog = Array.from({ length: 4 }, (_, index) => ({ ...places[index],
      tags: [index < 2 ? "展览" : "咖啡"],
    }));
    const plans = [proposal(catalog.slice(0, 2), "majority"), proposal(catalog.slice(2), "minority"), proposal([catalog[0], catalog[2]], "mixed")];
    const events = await runPlanningAgent(input, { places: catalog, model: { next: async () => ({ type: "final", plans, consensus: { shared: [], conflicts: [], constraints: [] } }) } });
    const actual = proposed(events);
    expect(actual).toHaveLength(3);
    expect(actual.map(plan => plan.matchScore)).toEqual([93, 67, 80]);
    expect(events.at(-1)).toMatchObject({ type: "run.completed", result: { consensus: { interestSupport: [
      { interest: "展览", count: 5, total: 6 }, { interest: "咖啡", count: 1, total: 6 },
    ] } } });
  });

  it("ranks broad member coverage ahead of one member's interests even when all venues are equally near", () => {
    const input = request();
    input.preferences.participants[0].preferences.interests = ["咖啡"];
    const catalog = Array.from({ length: 5 }, (_, index) => ({ ...places[0],
      placeId: `rank-${index}`, tags: [index < 3 ? "咖啡" : "展览"],
    }));
    const first = createRulePlans({ request: input, places: catalog })[0];
    expect(first.stops.map((stop) => stop.placeId).sort()).toEqual(["rank-3", "rank-4"]);
    expect(first.reasons[0]).toContain("5/6");
  });

  it("uses interest rank to break equal member coverage", () => {
    const input = request();
    for (const member of input.preferences.participants) member.preferences.interests = ["展览", "咖啡"];
    const catalog = Array.from({ length: 5 }, (_, index) => ({ ...places[0],
      placeId: `rank-${index}`, tags: [index < 3 ? "咖啡" : "展览"],
    }));
    const first = createRulePlans({ request: input, places: catalog })[0];
    expect(first.stops.map((stop) => stop.placeId).sort()).toEqual(["rank-3", "rank-4"]);
    expect(first.reasons[0]).toContain("6/6");
  });

  it("describes only the members whose interests occur in the chosen venues", () => {
    const input = request();
    input.preferences.participants[0].preferences.interests = ["咖啡"];
    const catalog = places.map((place) => ({ ...place, tags: ["咖啡"] }));
    const first = createRulePlans({ request: input, places: catalog })[0];
    expect(first.reasons[0]).toContain("1/6");
  });

  it("returns an explicit constraint failure when the sixth member excludes every venue", async () => {
    const input = request();
    input.preferences.participants[5].preferences.avoid = ["咖啡", "展览"];
    const events = await runPlanningAgent(input, { places });
    expect(proposed(events)).toEqual([]);
    expect(events).toContainEqual(expect.objectContaining({ type: "run.failed", code: "NO_VALID_PLAN", constraintCodes: expect.arrayContaining(["AVOID_TAG_MATCHED"]) }));
    expect(() => createRulePlans({ request: input, places })).toThrow(NoValidPlanError);
  });

  it("sends every complete preference with opaque member IDs to the model", async () => {
    const inputs: ModelInput[] = [];
    await runPlanningAgent(request(), { places, model: { next: async (input) => { inputs.push(input); throw new Error("offline"); } } });
    expect(inputs).toHaveLength(1);
    expect(inputs[0].request.preferences.participants.map((person) => person.id)).toEqual(["member-1", "member-2", "member-3", "member-4", "member-5", "member-6"]);
    expect(inputs[0].request.preferences.participants.map((person) => [person.preferences.wish, ...person.preferences.foodTags])).toEqual(Array.from({ length: 6 }, (_, index) => [`wish-${index}`, `food-${index}`]));
    expect(JSON.stringify(inputs)).not.toContain("private-nickname");
  });

  it("reports rule fallback after model proposals and repair fail", async () => {
    let turns = 0;
    const feedback: string[][] = [];
    const duplicate = proposal(places.slice(0, 2));
    const events = await runPlanningAgent(request(), { places, model: { next: async (input) => {
      turns += 1;
      if (input.validationFeedback) feedback.push(input.validationFeedback);
      return turns === 1 ? { type: "tool_call", id: "places", name: "search_places", args: { limit: 50 } }
        : { type: "final", plans: [duplicate, duplicate, duplicate], consensus: { shared: [], conflicts: [], constraints: [] } };
    } } });
    expect(turns).toBe(3);
    expect(feedback[0].join(" ")).toContain("add 24 for each transit leg");
    expect(proposed(events)).toHaveLength(3);
    expect(events).toContainEqual(expect.objectContaining({ type: "run.degraded", fallback: "rule-planner" }));
    expect(new Set(proposed(events).map((plan) => plan.stops.map((stop) => stop.placeId).sort().join(","))).size).toBe(3);
  });

  it("uses support from the later four members when choosing a replacement", async () => {
    const input = request();
    for (const member of input.preferences.participants.slice(1)) member.preferences.interests = ["咖啡"];
    const source = shanghaiPlaces.find((place) => place.category === "exhibition")!;
    const plan = proposal([source]);
    const response = await createReplanHandler({ now })(new Request("http://localhost/replan", { method: "POST", body: JSON.stringify({
      ...input, plan, lockedStopIds: [], rejectedStopId: plan.stops[0].id, reason: "按成员兴趣调整", reasonCode: "CHANGE_PLACE", replanCount: 0,
    }) }));
    expect(response.status).toBe(200);
    const events: AgentEvent[] = (await response.text()).trim().split("\n").map((line) => contracts.AgentEventSchema.parse(JSON.parse(line)));
    expect(proposed(events)[0].stops[0].tags).toContain("咖啡");
    expect(proposed(events)[0].reasons.join(" ")).toContain("5/6");
  });

  it("replans with the same six members, recomputes all costs and keeps their hard exclusions", async () => {
    const input = request();
    input.preferences.participants[5].preferences.avoid = ["展览"];
    const source = shanghaiPlaces.find((place) => place.category === "cafe")!;
    const plan = proposal([source]);
    const response = await createReplanHandler({ now })(new Request("http://localhost/replan", { method: "POST", body: JSON.stringify({
      ...input, plan, lockedStopIds: [], rejectedStopId: plan.stops[0].id, reason: "换一个地点", reasonCode: "CHANGE_PLACE", replanCount: 0,
    }) }));
    expect(response.status).toBe(200);
    const events: AgentEvent[] = (await response.text()).trim().split("\n").map((line) => contracts.AgentEventSchema.parse(JSON.parse(line)));
    const updated = proposed(events)[0];
    expect(updated.stops[0].placeId).not.toBe(source.placeId);
    expect(updated.stops[0].tags).not.toContain("展览");
    const price = shanghaiPlaces.find((place) => place.placeId === updated.stops[0].placeId)!.priceRange.max;
    expect(updated.stops[0].cost).toBe(price * 6);
    expect(updated.totalCost).toBe(Math.round(price * 6 * 1.1 * 100) / 100);
  });
});

describe("model adapter group and outing date boundaries", () => {
  it("instructs the model using the actual party size and sends no nickname IDs over HTTP", async () => {
    let payload: { messages: Array<{ role: string; content: string }> } | undefined;
    const model = createDeepSeekModel({ apiKey: "test-only", fetch: async (_url, init) => {
      payload = JSON.parse(String(init?.body));
      return Response.json({ choices: [{ message: { role: "assistant", content: JSON.stringify({ type: "final", consensus: { shared: [], conflicts: [], constraints: [] }, plans: [] }) } }] });
    } });
    await model.next({ request: request(), toolResults: [] });
    expect(payload!.messages[0].content).toContain("6 participants");
    expect(payload!.messages[0].content).not.toMatch(/for two people|either person's|cover two people/);
    const sent = JSON.parse(payload!.messages[1].content);
    expect(sent.preferences.participants).toHaveLength(6);
    expect(sent.preferences.participants[5].id).toBe("member-6");
    expect(JSON.stringify(payload)).not.toContain("private-nickname");
  });

  it.each(["2026-11-15T13:00:00+08:00", "2026-11-13T14:00:00Z"])("does not normalize ISO times from another Shanghai outing day: %s", async (startTime) => {
    const model = createDeepSeekModel({ apiKey: "test-only", fetch: async () => Response.json({ choices: [{ message: { role: "assistant", content: JSON.stringify({
      type: "final", plans: [{ stops: [{ startTime, endTime: "2026-11-14T14:00:00+08:00" }] }],
    }) } }] }) });
    const result = await model.next({ request: request(), toolResults: [] });
    expect(result.plans[0].stops[0].startTime).toBe(startTime);
    expect(contracts.ItinerarySchema.safeParse(result.plans[0]).success).toBe(false);
  });
});
