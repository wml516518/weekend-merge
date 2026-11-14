import { createHash } from "node:crypto";
import { getParticipants, ItinerarySchema, ReplanRequestSchema, type AgentEvent, type Itinerary, type ReplanRequest } from "../../src/contracts/agent";
import { analyzeConsensus } from "./agent/fallbacks/consensus";
import { acceptsFeedback, feedbackDescriptions, parseReplanFeedback, type ReplanFeedback } from "./agent/replanFeedback";
import { validateRequestDate } from "./agent/requestProtection";
import { budgetEvidence, routeEvidence, validationEvidence } from "./agent/evidence";
import { jsonError, ndjson, parseJsonRequest } from "./agent/http";
import { calculateBudget } from "./agent/tools/budget";
import type { CalculateBudgetInput, EstimateRouteOutput, Place } from "./agent/tools/contracts";
import { searchPlaces, shanghaiPlaces } from "./agent/tools/places";
import { expandedAvoidTags, interestCoverage, interestCoverageReason, interestMatchesTags, violatesAvoidedStop } from "./agent/tools/preferences";
import { estimateRoute } from "./agent/tools/route";
import { validatePlan } from "./agent/tools/validator";

const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
const clock = (value: number) => `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;

function routeFor(places: readonly Place[]): EstimateRouteOutput {
  return places.length > 1 ? estimateRoute({ stops: [...places], mode: "mixed" })
    : { legs: [], totalDistanceKm: 0, totalDurationMinutes: 0, estimated: true };
}

function openAt(place: Place, date: string, start: number, end: number): boolean {
  const endDate = end === 1440 ? new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10) : date;
  return searchPlaces({ openBetween: { start: `${date}T${clock(start)}:00+08:00`,
    end: `${endDate}T${end === 1440 ? "00:00" : clock(end)}:00+08:00` } }, [place]).places.length === 1;
}

// Only the rejected stop and unlocked immediate neighbors may move in time.
// Every other stop is an immutable scheduling anchor, including a locked neighbor.
function schedule(request: ReplanRequest, stops: Itinerary["stops"], places: Place[], affected: Set<number>, route: EstimateRouteOutput): Itinerary["stops"] | undefined {
  const avoided = [...new Set(getParticipants(request.preferences).flatMap((person) => person.preferences.avoid))];
  const durations = stops.map((stop) => minutes(stop.endTime) - minutes(stop.startTime));
  if (durations.some((duration) => duration <= 0)) return undefined;
  const result = [...stops];
  const failed = new Set<string>();
  function visit(index: number, previousEnd: number): boolean {
    if (index === stops.length) return true;
    const earliest = Math.max(minutes(request.setup.startTime), previousEnd + (route.legs[index - 1]?.durationMinutes ?? 0));
    let latest = minutes(request.setup.endTime) - durations[index];
    // Bound this movable segment by the next preserved stop and reserve all travel/dwell.
    let reserve = durations[index];
    for (let next = index + 1; next < stops.length; next += 1) {
      reserve += route.legs[next - 1].durationMinutes;
      if (!affected.has(next)) { latest = Math.min(latest, minutes(stops[next].startTime) - reserve); break; }
      reserve += durations[next];
    }
    const key = `${index}:${previousEnd}`;
    if (failed.has(key)) return false;
    const original = minutes(stops[index].startTime);
    const candidates = affected.has(index)
      ? [...new Set([original, earliest, ...Array.from({ length: Math.max(0, Math.floor((latest - Math.ceil(earliest / 15) * 15) / 15) + 1) }, (_, offset) => Math.ceil(earliest / 15) * 15 + offset * 15)])]
      : [original];
    for (const start of candidates) {
      const end = start + durations[index];
      if (start < earliest || start > latest || end > 1440 ||
        !openAt(places[index], request.setup.date, start, end) ||
        violatesAvoidedStop(avoided, [...stops[index].tags, ...places[index].tags], places[index].indoor, clock(start))) continue;
      result[index] = affected.has(index) && start !== original ? { ...stops[index], startTime: clock(start), endTime: clock(end) } : stops[index];
      if (visit(index + 1, end)) return true;
    }
    failed.add(key);
    return false;
  }
  return visit(0, minutes(request.setup.startTime)) ? result : undefined;
}

function replan(request: ReplanRequest, rejectedIndex: number, lockedIds: Set<string>, feedback: ReplanFeedback): Itinerary | undefined {
  const placeById = new Map(shanghaiPlaces.map((place) => [place.placeId, place]));
  const originals = request.plan.stops.map((stop) => placeById.get(stop.placeId));
  if (originals.some((place) => !place)) return undefined;
  const existingIds = new Set(request.plan.stops.map((stop) => stop.placeId));
  const existingStopIds = new Set(request.plan.stops.map((stop) => stop.id));
  const participants = getParticipants(request.preferences);
  const participantCount = participants.length;
  const avoided = [...new Set(participants.flatMap((person) => person.preferences.avoid))];
  const interestSupport = new Map<string, number>();
  for (const person of participants) {
    for (const interest of new Set(person.preferences.interests)) interestSupport.set(interest, (interestSupport.get(interest) ?? 0) + 1);
  }
  for (const interest of feedback.desired) if (!interestSupport.has(interest)) interestSupport.set(interest, 1);
  const interests = [...interestSupport.keys()]
    .filter((interest) => !feedback.negative.some((negative) => negative === interest));
  const shared = analyzeConsensus(request).shared.filter((interest) => !feedback.negative.some((negative) => negative === interest));
  const neighbors = [originals[rejectedIndex - 1], originals[rejectedIndex + 1]].filter((place): place is Place => !!place);
  const score = (place: Place) => {
    const hits = interests.filter((interest) => interestMatchesTags(interest, place.tags))
      .reduce((sum, interest) => sum + (interestSupport.get(interest) ?? 0), 0);
    const rank = interestCoverage(participants, [place]).rank;
    const sharedHits = shared.filter((interest) => interestMatchesTags(interest, place.tags)).length;
    const distance = neighbors.reduce((sum, neighbor) => sum + routeFor([place, neighbor]).totalDistanceKm, 0);
    const suitability = participants.map((participant) => participant.preferences).reduce((sum, person) => sum +
      (person.indoorPreference === "室内优先" ? (place.indoor ? 1 : -1) : person.indoorPreference === "户外优先" ? (place.indoor ? -1 : 1) : 0), 0);
    return sharedHits * 8 + hits * 4 + rank * 0.1 - distance * 2 + suitability * 3 - place.priceRange.max * 0.02;
  };
  const alternatives = searchPlaces({ excludedTags: expandedAvoidTags(avoided), limit: 50 }).places
    .filter((place) => !existingIds.has(place.placeId) && acceptsFeedback(place, originals[rejectedIndex]!, feedback))
    .sort((a, b) => {
      if (feedback.code === "TOO_EXPENSIVE" && a.priceRange.max !== b.priceRange.max) return a.priceRange.max - b.priceRange.max;
      if (feedback.code === "TOO_MUCH_WALKING") {
        const distance = (place: Place) => neighbors.reduce((sum, neighbor) => sum + routeFor([place, neighbor]).totalDistanceKm, 0);
        const delta = distance(a) - distance(b);
        if (delta) return delta;
      }
      return score(b) - score(a) || a.placeId.localeCompare(b.placeId);
    });
  const affected = new Set([rejectedIndex - 1, rejectedIndex, rejectedIndex + 1]
    .filter((index) => index >= 0 && index < originals.length && !lockedIds.has(request.plan.stops[index].id)));
  for (const alternative of alternatives) {
    const venues = originals.map((place, index) => index === rejectedIndex ? alternative : place!) as Place[];
    const replacementBase = `${request.rejectedStopId}-replacement-${alternative.placeId}`;
    let replacementId = replacementBase;
    for (let suffix = 1; existingStopIds.has(replacementId); suffix += 1) replacementId = `${replacementBase}-${suffix}`;
    const stops = request.plan.stops.map((stop, index) => index === rejectedIndex ? {
      ...stop, id: replacementId, placeId: alternative.placeId,
      name: alternative.name, area: alternative.area, cost: alternative.priceRange.max * participantCount,
      latitude: alternative.latitude, longitude: alternative.longitude, tags: alternative.tags, locked: false,
    } : stop);
    const route = routeFor(venues);
    const scheduled = schedule(request, stops, venues, affected, route);
    if (!scheduled) continue;
    const items: CalculateBudgetInput["items"] = venues.map((place) => ({ category: place.category, label: place.name, unitPrice: place.priceRange.max, quantity: participantCount }));
    for (const leg of route.legs) if (leg.mode === "transit") items.push({ category: "transport", label: "交通预算", unitPrice: 4, quantity: participantCount });
    const budget = calculateBudget({ items, budgetLimit: request.setup.budget, bufferRate: 0.1 });
    const sharedHits = venues.reduce((sum, place) => sum + shared.filter((interest) => interestMatchesTags(interest, place.tags)).length, 0);
    const interestHits = venues.reduce((sum, place) => sum + interests.filter((interest) => interestMatchesTags(interest, place.tags)).length, 0);
    const plan = ItinerarySchema.parse({ ...request.plan,
      id: `${request.plan.id}-replan-${request.replanCount + 1}`, stops: scheduled,
      title: `${alternative.name}与周末行程`,
      reasons: [feedbackDescriptions[feedback.code], interestCoverageReason(participants, venues), `行程包含${scheduled.map((stop) => stop.name).join("、")}`, "已重新核对时间、路线与预算"],
      summary: scheduled.map((stop) => stop.name).join("、"),
      matchScore: Math.max(0, Math.min(100, 60 + sharedHits * 12 + interestHits * 5)),
      totalCost: budget.total, totalDistanceKm: route.totalDistanceKm,
      indoorRatio: venues.filter((place) => place.indoor).length / venues.length * 100,
      transfers: route.legs.filter((leg) => leg.mode === "transit").length,
    });
    const validation = validatePlan({ plan, setup: request.setup, preferences: request.preferences,
      places: shanghaiPlaces, originalPlan: request.plan, lockedStopIds: [...lockedIds],
      walkingDistanceKm: route.legs.filter((leg) => leg.mode === "walking").reduce((sum, leg) => sum + leg.distanceKm, 0),
    });
    if (validation.valid) return plan;
  }
  return undefined;
}

export function createReplanHandler(dependencies: { now?: () => Date } = {}) {
  return async function handler(request: Request): Promise<Response> {
    if (request.method !== "POST") return jsonError(405, "METHOD_NOT_ALLOWED", "Use POST to replan.");
    const parsed = await parseJsonRequest(request, ReplanRequestSchema);
    if ("response" in parsed) return parsed.response;
    const body = parsed.data;
    const now = dependencies.now ?? (() => new Date());
    const dateError = validateRequestDate(body.setup.date, now());
    if (dateError) return dateError;
    const feedback = parseReplanFeedback(body);
    if (!feedback) return jsonError(400, "UNSUPPORTED_REPLAN_REASON", "Choose a supported replacement reason.", "reason");
    const stopIds = body.plan.stops.map((stop) => stop.id);
    if (new Set(stopIds).size !== stopIds.length || !stopIds.includes(body.rejectedStopId) || body.lockedStopIds.some((id) => !stopIds.includes(id))) {
      return jsonError(400, "INVALID_REQUEST", "Stop identities must be unique and refer to the current plan.");
    }
    const lockedIds = new Set([...body.lockedStopIds, ...body.plan.stops.filter((stop) => stop.locked).map((stop) => stop.id)]);
    if (lockedIds.has(body.rejectedStopId)) return jsonError(409, "LOCKED_STOP_CONFLICT", "Unlock the rejected stop before replacing it.", "rejectedStopId");
    try {
      const started = now().getTime();
      const plan = replan(body, stopIds.indexOf(body.rejectedStopId), lockedIds, feedback);
      if (!plan) return jsonError(422, "NO_VALID_REPLAN", "No local replacement satisfies the preserved stops and constraints.");
      const runId = `replan-${createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 16)}`;
      const at = new Date(started).toISOString();
      const events: AgentEvent[] = [{ type: "run.started", runId, at }, { type: "step.started", step: "REPLAN", at }];
      const venues = plan.stops.map((stop) => shanghaiPlaces.find((place) => place.placeId === stop.placeId)!);
      const route = routeFor(venues);
      const validation = validatePlan({ plan, setup: body.setup, preferences: body.preferences, places: shanghaiPlaces,
        originalPlan: body.plan, lockedStopIds: [...lockedIds],
        walkingDistanceKm: route.legs.filter((leg) => leg.mode === "walking").reduce((sum, leg) => sum + leg.distanceKm, 0) });
      for (const [tool, summary] of [
        ["estimate_route", routeEvidence([route])],
        ["calculate_budget", budgetEvidence([{ subtotal: plan.totalCost, buffer: 0, total: plan.totalCost,
          withinBudget: plan.totalCost <= body.setup.budget, breakdown: {} }], body.setup.budget)],
        ["validate_plan", validationEvidence([{ candidateId: plan.id, validation }])],
      ] as const) events.push({ type: "tool.completed", tool, summary, durationMs: Math.max(0, now().getTime() - started), source: "local" });
      events.push({ type: "step.started", step: "VERIFY", at }, { type: "plan.proposed", plan }, { type: "run.completed", result: {
        runId, consensus: analyzeConsensus(body), candidateIds: [plan.id],
        diff: { replacedStopIds: [body.rejectedStopId], preservedStopIds: stopIds.filter((id) => id !== body.rejectedStopId), summary: "已替换否决地点，仅在需要时调整相邻未锁定地点的时间，并重新核对路线和预算。" },
      } });
      return ndjson(events);
    } catch {
      return jsonError(422, "NO_VALID_REPLAN", "No local replacement satisfies the preserved stops and constraints.");
    }
  };
}
export default createReplanHandler();
