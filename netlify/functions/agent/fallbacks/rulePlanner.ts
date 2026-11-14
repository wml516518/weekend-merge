import { ItinerarySchema, type Itinerary, type PlanRequest } from "../../../../src/contracts/agent";
import { calculateBudget } from "../tools/budget";
import { PlaceListSchema, type Place, type EstimateRouteOutput, type CalculateBudgetInput } from "../tools/contracts";
import { searchPlaces } from "../tools/places";
import { effectiveWalkingLimitKm, expandedAvoidTags, interestMatchesTags, violatesAvoidedStop } from "../tools/preferences";
import { estimateRoute } from "../tools/route";
import { validatePlan, type ValidationCode } from "../tools/validator";
import type { WeatherOutput } from "../tools/weather";
import { analyzeConsensus } from "./consensus";

export type RulePlanContext = {
  request: PlanRequest;
  places: readonly Place[];
  weather?: WeatherOutput;
  preferredPlaceIds?: readonly string[];
};

export type RulePlanConstraintCode = ValidationCode | "INSUFFICIENT_CANDIDATES";

export class NoValidPlanError extends Error {
  readonly code = "NO_VALID_PLAN" as const;

  constructor(public readonly violatedConstraintCodes: RulePlanConstraintCode[]) {
    super("NO_VALID_PLAN");
    this.name = "NoValidPlanError";
  }
}

const durations: Record<Place["category"], number> = {
  exhibition: 75,
  bookstore: 45,
  cafe: 45,
  dinner: 75,
  park: 45,
  "night-view": 45,
};
const BUFFER_RATE = 0.1;
// A planning allowance of 4 yuan per person per transit leg, not a quoted fare.
const TRANSIT_ALLOWANCE_PER_PERSON = 4;
const MAX_COMBINATIONS_PER_STRATEGY = 20;

type Pair = { places: [Place, Place]; route: EstimateRouteOutput; sharedHits: number; interestHits: number; cost: number };

function minutes(time: string): number {
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
}

function clock(total: number): string {
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function nextQuarterHour(minute: number): number {
  return Math.ceil(minute / 15) * 15;
}

function earliestAlignedFinish(pair: Pair, start: number): number {
  const firstEnd = start + durations[pair.places[0].category];
  const secondStart = nextQuarterHour(firstEnd + pair.route.legs[0].durationMinutes);
  return secondStart + durations[pair.places[1].category];
}

function openAt(place: Place, date: string, start: number, end: number): boolean {
  if (end > 1440) return false;
  const endDate = end === 1440
    ? new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)
    : date;
  return searchPlaces({
    openBetween: {
      start: `${date}T${clock(start)}:00+08:00`,
      end: `${endDate}T${end === 1440 ? "00:00" : clock(end)}:00+08:00`,
    },
    limit: 50,
  }, [place]).places.length === 1;
}

function schedule(pair: Pair, request: PlanRequest, avoided: readonly string[]): Array<{ start: number; end: number }> | undefined {
  const rangeStart = minutes(request.setup.startTime);
  const rangeEnd = minutes(request.setup.endTime);
  if (rangeStart >= rangeEnd) return undefined;

  const [first, second] = pair.places;
  for (let firstStart = rangeStart; firstStart + durations[first.category] <= rangeEnd; firstStart += 15) {
    const firstEnd = firstStart + durations[first.category];
    if (!openAt(first, request.setup.date, firstStart, firstEnd) ||
      violatesAvoidedStop(avoided, first.tags, first.indoor, clock(firstStart))) continue;
    const earliestSecond = firstEnd + pair.route.legs[0].durationMinutes;
    for (let secondStart = nextQuarterHour(earliestSecond); secondStart + durations[second.category] <= rangeEnd; secondStart += 15) {
      const secondEnd = secondStart + durations[second.category];
      if (openAt(second, request.setup.date, secondStart, secondEnd) &&
        !violatesAvoidedStop(avoided, second.tags, second.indoor, clock(secondStart))) {
        return [{ start: firstStart, end: firstEnd }, { start: secondStart, end: secondEnd }];
      }
    }
  }
  return undefined;
}

function pairCost(pair: [Place, Place], route: EstimateRouteOutput, budgetLimit: number): number {
  const items: CalculateBudgetInput["items"] = pair.map((place) => ({
    category: place.category,
    label: place.name,
    unitPrice: place.priceRange.max,
    quantity: 2,
  }));
  for (const leg of route.legs) {
    if (leg.mode === "transit") {
      items.push({ category: "transport", label: "交通预算", unitPrice: TRANSIT_ALLOWANCE_PER_PERSON, quantity: 2 });
    }
  }
  return calculateBudget({ items, budgetLimit, bufferRate: BUFFER_RATE }).total;
}

function comparePairs(strategy: number, a: Pair, b: Pair, startingArea: string,
  preferredPlaceIds: ReadonlySet<string>): number {
  const firstArea = (pair: Pair) => pair.places[0].area === startingArea ? 1 : 0;
  const preference = (pair: Pair) => pair.places.filter((place) => preferredPlaceIds.has(place.placeId)).length;
  const key = (pair: Pair) => pair.places.map((place) => place.placeId).join(",");
  if (preference(b) !== preference(a)) return preference(b) - preference(a);
  if (strategy === 0) {
    return b.sharedHits - a.sharedHits || b.interestHits - a.interestHits ||
      firstArea(b) - firstArea(a) || a.route.totalDistanceKm - b.route.totalDistanceKm || key(a).localeCompare(key(b));
  }
  if (strategy === 1) {
    return a.route.totalDistanceKm - b.route.totalDistanceKm || firstArea(b) - firstArea(a) ||
      b.interestHits - a.interestHits || key(a).localeCompare(key(b));
  }
  return a.cost - b.cost || firstArea(b) - firstArea(a) ||
    b.interestHits - a.interestHits || key(a).localeCompare(key(b));
}

function pairKey(pair: Pair): string {
  return pair.places.map((place) => place.placeId).sort().join(",");
}

export function createRulePlans(context: RulePlanContext): Itinerary[] {
  const { request, weather } = context;
  const catalog = PlaceListSchema.parse(context.places);
  const avoided = [...new Set([...request.preferences.a.avoid, ...request.preferences.b.avoid])];
  const searchable = searchPlaces({ excludedTags: expandedAvoidTags(avoided), limit: 50 }, catalog).places;
  const shared = analyzeConsensus(request).shared;
  const interests = [...new Set([...request.preferences.a.interests, ...request.preferences.b.interests])];
  const preferredPlaceIds = new Set(context.preferredPlaceIds ?? []);
  const rainLikely = weather?.hourly.some((hour) => hour.precipitationProbability >= 50) ?? false;
  const pairs: Pair[] = [];

  for (const first of searchable) {
    for (const second of searchable) {
      if (first.placeId === second.placeId) continue;
      const route = estimateRoute({ stops: [first, second], mode: "mixed" });
      const walkingKm = route.legs.filter((leg) => leg.mode === "walking")
        .reduce((sum, leg) => sum + leg.distanceKm, 0);
      if (walkingKm > effectiveWalkingLimitKm(request.preferences)) continue;
      const places: [Place, Place] = [first, second];
      pairs.push({
        places,
        route,
        sharedHits: places.reduce((sum, place) => sum + shared.filter((interest) => interestMatchesTags(interest, place.tags)).length, 0),
        interestHits: places.reduce((sum, place) => sum + interests.filter((interest) => interestMatchesTags(interest, place.tags)).length + (rainLikely && place.indoor ? 1 : 0), 0),
        cost: pairCost(places, route, request.setup.budget),
      });
    }
  }

  const titles = ["共同兴趣优先", "移动最少", "预算余量优先"] as const;
  const reasons = ["优先安排双方共同感兴趣的地点", "优先减少地点间移动", "优先保留预算余量"] as const;
  const plans: Itinerary[] = [];
  const usedPairs = new Set<string>();
  const violations = new Set<RulePlanConstraintCode>();
  if (searchable.length < 2) {
    violations.add("INSUFFICIENT_CANDIDATES");
    if (searchable.length < catalog.length) violations.add("AVOID_TAG_MATCHED");
  }
  else if (pairs.length === 0) violations.add("WALKING_LIMIT_EXCEEDED");

  for (const [strategy, title] of titles.entries()) {
    const ranked = [...pairs].sort((a, b) => comparePairs(strategy, a, b, request.setup.startingArea, preferredPlaceIds));
    let selected = false;
    for (const pair of ranked.slice(0, MAX_COMBINATIONS_PER_STRATEGY)) {
      const signature = pairKey(pair);
      if (usedPairs.has(signature)) continue;
      if (pair.cost > request.setup.budget) {
        violations.add("BUDGET_EXCEEDED");
        continue;
      }
      const times = schedule(pair, request, avoided);
      if (!times) {
        if (earliestAlignedFinish(pair, minutes(request.setup.startTime)) > minutes(request.setup.endTime)) {
          violations.add("OUTSIDE_TIME_RANGE");
        } else if (schedule(pair, request, [])) {
          violations.add("AVOID_TAG_MATCHED");
        } else {
          violations.add("PLACE_CLOSED");
        }
        continue;
      }
      const stops = pair.places.map((place, index) => ({
        id: `${request.sessionId}-rule-${strategy + 1}-stop-${index + 1}`,
        placeId: place.placeId,
        name: place.name,
        area: place.area,
        startTime: clock(times[index].start),
        endTime: clock(times[index].end),
        cost: place.priceRange.max * 2,
        latitude: place.latitude,
        longitude: place.longitude,
        tags: place.tags,
        locked: false,
      }));
      const plan = ItinerarySchema.parse({
        id: `${request.sessionId}-rule-${strategy + 1}`,
        title,
        summary: `${pair.places[0].name}、${pair.places[1].name}`,
        matchScore: Math.min(100, 60 + pair.sharedHits * 12 + pair.interestHits * 5),
        totalCost: pair.cost,
        totalDistanceKm: pair.route.totalDistanceKm,
        indoorRatio: pair.places.filter((place) => place.indoor).length * 50,
        transfers: pair.route.legs.filter((leg) => leg.mode === "transit").length,
        stops,
        reasons: [reasons[strategy], ...(rainLikely && pair.places.every((place) => place.indoor) ? ["预报有降雨可能，安排室内地点"] : [])],
      });
      const walkingDistanceKm = pair.route.legs.filter((leg) => leg.mode === "walking")
        .reduce((sum, leg) => sum + leg.distanceKm, 0);
      const result = validatePlan({
        plan, setup: request.setup, preferences: request.preferences, places: catalog,
        walkingDistanceKm, lockedStopIds: [],
      });
      if (!result.valid) {
        result.violations.forEach((violation) => violations.add(violation.code));
        continue;
      }
      plans.push(plan);
      usedPairs.add(signature);
      selected = true;
      break;
    }
    if (!selected) {
      if (ranked.every((pair) => usedPairs.has(pairKey(pair)))) {
        violations.add("INSUFFICIENT_CANDIDATES");
      }
      throw new NoValidPlanError([...violations]);
    }
  }

  return plans;
}
