import { describe, expect, it } from "vitest";

import { ItinerarySchema, type PlanRequest } from "../../../../src/contracts/agent";
import { shanghaiPlaces } from "../tools/places";
import { estimateRoute } from "../tools/route";
import { interestMatchesTags } from "../tools/preferences";
import { validatePlan } from "../tools/validator";
import { analyzeConsensus } from "./consensus";
import { NoValidPlanError, createRulePlans } from "./rulePlanner";

const request: PlanRequest = {
  sessionId: "fallback-test",
  mode: "demo",
  setup: {
    city: "上海", date: "2026-11-14", startTime: "11:00", endTime: "18:00",
    budget: 300, startingArea: "徐汇滨江",
  },
  preferences: {
    a: {
      interests: ["展览", "咖啡"], pace: "轻松", walkingLimitKm: 3,
      indoorPreference: "室内优先", foodTags: [], budgetStyle: "平衡",
      avoid: ["排队"], wish: "",
    },
    b: {
      interests: ["展览", "逛店"], pace: "充实", walkingLimitKm: 5,
      indoorPreference: "户外优先", foodTags: [], budgetStyle: "省钱",
      avoid: [], wish: "",
    },
  },
};

describe("deterministic fallback", () => {
  it("finds shared interests and all hard constraints", () => {
    const consensus = analyzeConsensus(request);
    expect(consensus.shared).toEqual(["展览"]);
    expect(consensus.conflicts).toEqual(expect.arrayContaining([
      expect.stringContaining("节奏"),
      expect.stringContaining("室内外"),
      expect.stringContaining("步行"),
    ]));
    expect(consensus.constraints).toEqual(expect.arrayContaining([
      "总预算 300 元", "步行上限 3 公里", "活动时间 11:00-18:00", "避开：排队",
    ]));
  });

  it("reports the effective walking cap when long walks are avoided", () => {
    const modified = { ...request, preferences: {
      a: { ...request.preferences.a, avoid: ["长距离步行"] },
      b: request.preferences.b,
    } };
    expect(analyzeConsensus(modified).constraints).toContain("步行上限 1 公里");
  });

  it("produces three distinct, schema-valid plans from curated venues", () => {
    const plans = createRulePlans({ request, places: shanghaiPlaces });
    expect(plans.map((plan) => plan.title)).toEqual(["共同兴趣优先", "移动最少", "预算余量优先"]);
    expect(new Set(plans.map((plan) => plan.id)).size).toBe(3);
    expect(new Set(plans.map((plan) => plan.stops.map((stop) => stop.placeId).sort().join(","))).size).toBe(3);

    for (const plan of plans) {
      expect(ItinerarySchema.safeParse(plan).success).toBe(true);
      const places = plan.stops.map((stop) => shanghaiPlaces.find((place) => place.placeId === stop.placeId)!);
      expect(places.every(Boolean)).toBe(true);
      const route = estimateRoute({ stops: places, mode: "mixed" });
      expect(validatePlan({
        plan, setup: request.setup, preferences: request.preferences, places: shanghaiPlaces,
        walkingDistanceKm: route.legs.filter((leg) => leg.mode === "walking")
          .reduce((sum, leg) => sum + leg.distanceKm, 0),
        lockedStopIds: [],
      }).valid).toBe(true);
      expect(plan.totalCost).toBeGreaterThanOrEqual(places.reduce((sum, place) => sum + 2 * place.priceRange.max, 0));
      expect(plan.summary).not.toMatch(/天气|降雨|晴天/);
    }
  });

  it("allows each route leg enough time and includes estimated transit for two", () => {
    const plans = createRulePlans({ request, places: shanghaiPlaces });
    for (const plan of plans) {
      const places = plan.stops.map((stop) => shanghaiPlaces.find((place) => place.placeId === stop.placeId)!);
      const route = estimateRoute({ stops: places, mode: "mixed" });
      for (const [index, leg] of route.legs.entries()) {
        const end = plan.stops[index].endTime;
        const start = plan.stops[index + 1].startTime;
        const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
        expect(minutes(start) - minutes(end)).toBeGreaterThanOrEqual(leg.durationMinutes);
      }
      const transitLegs = route.legs.filter((leg) => leg.mode === "transit").length;
      expect(plan.totalCost).toBeGreaterThanOrEqual(
        places.reduce((sum, place) => sum + 2 * place.priceRange.max, 0) + transitLegs * 8,
      );
    }
  });

  it("gives each named strategy its corresponding advantage", () => {
    const [shared, movement, headroom] = createRulePlans({ request, places: shanghaiPlaces });
    const sharedHits = (plan: typeof shared) => plan.stops.reduce((sum, stop) =>
      sum + stop.tags.filter((tag) => tag === "展览").length, 0);
    expect(sharedHits(shared)).toBeGreaterThanOrEqual(sharedHits(movement));
    expect(sharedHits(shared)).toBeGreaterThanOrEqual(sharedHits(headroom));
    expect(movement.totalDistanceKm).toBeLessThan(shared.totalDistanceKm);
    expect(movement.totalDistanceKm).toBeLessThan(headroom.totalDistanceKm);
    expect(headroom.totalCost).toBeLessThan(shared.totalCost);
    expect(headroom.totalCost).toBeLessThanOrEqual(10);
  });

  it("scores shared UI interests through catalog tags", () => {
    const interestRequest = { ...request, preferences: {
      a: { ...request.preferences.a, interests: ["逛店"] },
      b: { ...request.preferences.b, interests: ["逛店"] },
    } };
    const [shared] = createRulePlans({ request: interestRequest, places: shanghaiPlaces });
    expect(shared.stops.some((stop) => interestMatchesTags("逛店", stop.tags))).toBe(true);
  });

  it("reports insufficient distinct combinations when only two venues are available", () => {
    const places = shanghaiPlaces.filter((place) =>
      ["shanghai-book-city", "manner-xuhui-riverside"].includes(place.placeId));
    expect(() => createRulePlans({ request, places })).toThrowError(NoValidPlanError);
    try {
      createRulePlans({ request, places });
    } catch (error) {
      expect(error).toMatchObject({
        code: "NO_VALID_PLAN",
        violatedConstraintCodes: expect.arrayContaining(["INSUFFICIENT_CANDIDATES"]),
      });
    }
  });

  it("schedules and validates a stop ending at midnight", () => {
    const allDays = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;
    const places = [
      {
        ...shanghaiPlaces[5], placeId: "late-cafe", weeklyOpeningHours: [{
          days: [...allDays], intervals: [{ open: "21:00", close: "22:00" }],
        }],
      },
      {
        ...shanghaiPlaces[3], placeId: "early-bookstore", weeklyOpeningHours: [{
          days: [...allDays], intervals: [{ open: "21:00", close: "22:00" }],
        }],
      },
      {
        ...shanghaiPlaces[9], placeId: "late-park", weeklyOpeningHours: [{
          days: [...allDays], intervals: [{ open: "23:15", close: "24:00" }],
        }],
      },
      {
        ...shanghaiPlaces[12], placeId: "late-view", weeklyOpeningHours: [{
          days: [...allDays], intervals: [{ open: "23:15", close: "24:00" }],
        }],
      },
    ];
    const midnightRequest = { ...request, setup: { ...request.setup, startTime: "21:00", endTime: "24:00" } };
    const plans = createRulePlans({ request: midnightRequest, places });
    expect(plans).toHaveLength(3);
    expect(plans.some((plan) => plan.stops.some((stop) => stop.endTime === "24:00"))).toBe(true);
    for (const plan of plans) {
      expect(validatePlan({ plan, setup: midnightRequest.setup, preferences: request.preferences,
        places, lockedStopIds: [], walkingDistanceKm: 0 }).valid).toBe(true);
    }
  });

  it("uses semantic avoidance when selecting and scheduling venues", () => {
    const semanticRequest = { ...request, preferences: {
      a: { ...request.preferences.a, avoid: ["拥挤", "长距离步行", "早起", "户外日晒"] },
      b: request.preferences.b,
    }, setup: { ...request.setup, startTime: "09:00", endTime: "21:00" } };
    const plans = createRulePlans({ request: semanticRequest, places: shanghaiPlaces });
    for (const plan of plans) {
      expect(plan.stops.every((stop) => !stop.tags.includes("排队") && stop.startTime >= "10:00")).toBe(true);
      expect(plan.stops.every((stop) => {
        const place = shanghaiPlaces.find((item) => item.placeId === stop.placeId)!;
        return place.indoor || stop.startTime >= "18:00";
      })).toBe(true);
      const route = estimateRoute({ stops: plan.stops, mode: "mixed" });
      expect(route.legs.filter((leg) => leg.mode === "walking").reduce((sum, leg) => sum + leg.distanceKm, 0)).toBeLessThanOrEqual(1);
    }
  });

  it("reports observed no-plan causes without guessing from an unrelated avoid label", () => {
    expect.assertions(2);
    try {
      createRulePlans({ request: { ...request, preferences: { ...request.preferences,
        a: { ...request.preferences.a, avoid: ["酒吧"] } } }, places: [] });
    } catch (error) {
      expect(error).toMatchObject({ code: "NO_VALID_PLAN", violatedConstraintCodes: ["INSUFFICIENT_CANDIDATES"] });
    }
    const shortRequest = { ...request, setup: { ...request.setup, startTime: "11:00", endTime: "11:30" } };
    const alwaysOpen = shanghaiPlaces.filter((place) =>
      ["shanghai-book-city", "manner-xuhui-riverside", "fuxing-park"].includes(place.placeId));
    try {
      createRulePlans({ request: shortRequest, places: alwaysOpen });
    } catch (error) {
      expect(error).toMatchObject({ code: "NO_VALID_PLAN", violatedConstraintCodes: ["OUTSIDE_TIME_RANGE"] });
    }
  });

  it("reports time exhaustion when quarter-hour alignment pushes the second stop past setup end", () => {
    const days = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;
    const alwaysOpen = shanghaiPlaces.slice(3, 6).map((place, index) => ({
      ...place,
      latitude: 31.2 + index * 0.00001,
      longitude: 121.4,
      weeklyOpeningHours: [{ days: [...days], intervals: [{ open: "00:00", close: "24:00" }] }],
    }));
    expect(estimateRoute({ stops: alwaysOpen.slice(0, 2), mode: "mixed" }).legs[0].durationMinutes).toBe(1);
    const alignedRequest = { ...request, setup: { ...request.setup, startTime: "11:00", endTime: "12:32" } };
    expect(() => createRulePlans({ request: alignedRequest, places: alwaysOpen })).toThrowError(NoValidPlanError);
    try {
      createRulePlans({ request: alignedRequest, places: alwaysOpen });
    } catch (error) {
      expect(error).toMatchObject({
        code: "NO_VALID_PLAN",
        violatedConstraintCodes: ["OUTSIDE_TIME_RANGE"],
      });
    }
  });

  it("throws a typed error when avoidance excludes every venue", () => {
    const impossible = {
      ...request,
      preferences: {
        ...request.preferences,
        a: { ...request.preferences.a, avoid: ["展览", "艺术", "当代艺术", "历史", "文物", "书店", "阅读", "文化", "江景", "咖啡", "烘焙", "休息", "晚餐", "本帮菜", "传统", "公园", "散步", "绿地", "夜景"] },
      },
    };
    expect(() => createRulePlans({ request: impossible, places: shanghaiPlaces }))
      .toThrow(NoValidPlanError);
    try {
      createRulePlans({ request: impossible, places: shanghaiPlaces });
    } catch (error) {
      expect(error).toMatchObject({ code: "NO_VALID_PLAN" });
    }
  });
});
