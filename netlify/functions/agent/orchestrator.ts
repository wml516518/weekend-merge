import { randomUUID } from "node:crypto";
import { z } from "zod";

import { ItinerarySchema, PlanRequestSchema, ToolNameSchema, type AgentEvent, type Itinerary, type PlanRequest } from "../../../src/contracts/agent";
import { budgetEvidence, placesEvidence, routeEvidence, toolEvidence, validationEvidence, type CandidateValidation } from "./evidence";
import type { CalculateBudgetOutput, EstimateRouteOutput } from "./tools/contracts";
import { encodeAgentEvent } from "./http";
import { analyzeConsensus } from "./fallbacks/consensus";
import { createRulePlans, NoValidPlanError } from "./fallbacks/rulePlanner";
import { ModelFinalSchema, type AgentModel, type ModelInput } from "./model";
import { PlaceListSchema, type Place } from "./tools/contracts";
import { shanghaiPlaces } from "./tools/places";
import { interestMatchesTags } from "./tools/preferences";
import { parsePlaceSearchInput } from "./tools/placeSearchInput";
import { createAgentTools, toolInputSchemas, weatherScopeForRequest, type AgentTools } from "./tools/registry";
import { AgentToolError, type WeatherOutput } from "./tools/weather";

const CallSchema = z.object({ id: z.string().min(1), wireId: z.string().min(1).optional(), name: z.string().min(1), args: z.unknown() });
const CallsSchema = z.union([
  CallSchema.extend({ type: z.literal("tool_call") }).transform((call) => [call]),
  z.object({ type: z.literal("tool_calls"), calls: z.array(CallSchema).min(1) }).transform(({ calls }) => calls),
]);

class PlanningError extends Error {
  constructor(readonly code: string) { super(code); }
}

const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));

export async function runPlanningAgent(input: PlanRequest, dependencies: {
  model?: AgentModel;
  onEvent?: (event: AgentEvent) => void;
  tools?: AgentTools;
  places?: readonly Place[];
  now?: () => Date;
} = {}): Promise<AgentEvent[]> {
  const now = dependencies.now ?? (() => new Date());
  const events: AgentEvent[] = [];
  let deliveryFailed = false;
  const emit = (original: AgentEvent) => {
    if (deliveryFailed) throw new Error("Event delivery failed");
    const { event } = encodeAgentEvent(original);
    events.push(event);
    try { dependencies.onEvent?.(event); }
    catch (error) { deliveryFailed = true; throw error; }
  };
  const step = (name: "VALIDATE" | "ANALYZE" | "GATHER" | "PROPOSE" | "VERIFY") => emit({ type: "step.started", step: name, at: now().toISOString() });
  const runId = `plan-${now().getTime()}-${randomUUID()}`;
  emit({ type: "run.started", runId, at: now().toISOString() });
  step("VALIDATE");
  const parsed = PlanRequestSchema.safeParse(input);
  if (!parsed.success) {
    emit({ type: "run.failed", code: "INVALID_REQUEST", message: "Planning request is invalid" });
    return events;
  }
  const request = parsed.data;
  const places = PlaceListSchema.safeParse(dependencies.places ?? shanghaiPlaces);
  if (!places.success) {
    emit({ type: "run.failed", code: "INVALID_CATALOG", message: "Place catalog is invalid" });
    return events;
  }
  const tools = dependencies.tools ?? createAgentTools({ request, places: places.data, now: dependencies.now });
  const consensus = analyzeConsensus(request);
  let weather: WeatherOutput | undefined;
  let fallbackReason: string | undefined;
  let final: z.infer<typeof ModelFinalSchema> | undefined;
  step("ANALYZE");
  step("GATHER");

  if (!dependencies.model) fallbackReason = "MODEL_UNAVAILABLE";
  else {
    try {
      let turn: unknown = await dependencies.model.next({ request, toolResults: [] });
      if (!ModelFinalSchema.safeParse(turn).success) {
        const parsedCalls = CallsSchema.safeParse(turn);
        if (!parsedCalls.success) throw new PlanningError("INVALID_MODEL_RESULT");
        const results: ModelInput["toolResults"] = [];
        const ids = new Set<string>();
        for (const [index, call] of parsedCalls.data.entries()) {
          let code: string | undefined;
          const name = ToolNameSchema.safeParse(call.name);
          let args: unknown;
          if (index >= 6) code = "TOOL_LIMIT_EXCEEDED";
          else if (!name.success) code = "UNKNOWN_TOOL";
          else if (ids.has(call.id)) code = "DUPLICATE_TOOL_CALL_ID";
          else {
            try {
              args = name.data === "get_weather" ? weatherScopeForRequest(request)
                : name.data === "search_places" ? parsePlaceSearchInput(call.args, request.setup.date)
                : toolInputSchemas[name.data].parse(call.args);
            } catch { code = "INVALID_TOOL_ARGUMENTS"; }
          }
          if (code || !name.success) {
            emit({ type: "tool.failed", tool: name.success ? name.data : "unknown", code: code ?? "UNKNOWN_TOOL", retryable: false });
            throw new PlanningError(code ?? "UNKNOWN_TOOL");
          }
          ids.add(call.id);
          const tool = name.data;
          const started = now().getTime();
          try {
            // Parse even injected tools' inputs; no dynamic property outside the whitelist.
            const execute = tools[tool] as (input: unknown) => unknown | Promise<unknown>;
            const output = await execute(args);
            results.push({ id: call.id, ...(call.wireId ? { wireId: call.wireId } : {}), name: tool, output });
            if (tool === "get_weather") weather = output as WeatherOutput;
            emit({ type: "tool.completed", tool, summary: toolEvidence(tool, output, request, places.data, `tool-candidate-${index + 1}`), durationMs: Math.max(0, Math.round(now().getTime() - started)), source: tool === "get_weather" ? (output as WeatherOutput).source : tool === "search_places" ? "curated-shanghai-catalog" : "local" });
          } catch (error) {
            if (deliveryFailed) throw error;
            const weatherUnavailable = error instanceof AgentToolError && error.code === "WEATHER_UNAVAILABLE";
            const code = weatherUnavailable ? "WEATHER_UNAVAILABLE" : "TOOL_UNAVAILABLE";
            emit({ type: "tool.failed", tool, code, retryable: weatherUnavailable && error.retryable });
            throw new PlanningError(code);
          }
        }
        // This is the only second request. A second tool batch is never executed.
        turn = await dependencies.model.next({ request, toolResults: results });
      }
      const candidate = ModelFinalSchema.safeParse(turn);
      if (!candidate.success) throw new PlanningError("INVALID_MODEL_RESULT");
      final = candidate.data;
    } catch (error) {
      if (deliveryFailed) throw error;
      fallbackReason = error instanceof PlanningError ? error.code : "MODEL_UNAVAILABLE";
    }
  }

  step("PROPOSE");
  step("VERIFY");
  const placeById = new Map(places.data.map((place) => [place.placeId, place]));

  const routes: EstimateRouteOutput[] = [];
  const budgets: CalculateBudgetOutput[] = [];
  const validations: CandidateValidation[] = [];
  const verificationStarted = now().getTime();
  function emitVerification() {
    for (const [tool, summary] of [
      ["estimate_route", routeEvidence(routes)], ["calculate_budget", budgetEvidence(budgets, request.setup.budget)],
      ["validate_plan", validationEvidence(validations)],
    ] as const) emit({ type: "tool.completed", tool, summary,
      durationMs: Math.max(0, Math.round(now().getTime() - verificationStarted)), source: "local" });
  }

  async function verify(proposals: Itinerary[], fromModel = false): Promise<Itinerary[]> {
    if (proposals.length !== 3 || new Set(proposals.map((plan) => plan.id)).size !== 3 ||
      new Set(proposals.map((plan) => plan.stops.map((stop) => stop.placeId).sort().join(","))).size !== 3) {
      throw new PlanningError("INVALID_MODEL_RESULT");
    }
    const verified: Itinerary[] = [];
    for (const [candidateIndex, proposal] of proposals.entries()) {
      const venues = proposal.stops.map((stop) => {
        const place = placeById.get(stop.placeId);
        if (!place) throw new PlanningError("INVALID_MODEL_RESULT");
        return place;
      });
      const planId = fromModel ? `${runId}-candidate-${candidateIndex + 1}` : proposal.id;
      const stops = proposal.stops.map((stop, index) => ({ ...stop,
        id: fromModel ? `${planId}-stop-${index + 1}` : stop.id,
        name: venues[index].name, area: venues[index].area, cost: venues[index].priceRange.max * 2,
        latitude: venues[index].latitude, longitude: venues[index].longitude, tags: venues[index].tags, locked: false,
      }));
      const route = await tools.estimate_route(toolInputSchemas.estimate_route.parse({ stops, mode: "mixed" }));
      const items = venues.map((place) => ({ category: place.category as string, label: place.name, unitPrice: place.priceRange.max, quantity: 2 }));
      for (const leg of route.legs) {
        if (leg.mode === "transit") items.push({ category: "transport", label: "交通预算", unitPrice: 4, quantity: 2 });
      }
      const budget = await tools.calculate_budget(toolInputSchemas.calculate_budget.parse({ items, budgetLimit: request.setup.budget, bufferRate: 0.1 }));
      const interests = [...new Set([...request.preferences.a.interests, ...request.preferences.b.interests])];
      const sharedHits = venues.reduce((sum, venue) => sum + consensus.shared.filter((interest) => interestMatchesTags(interest, venue.tags)).length, 0);
      const interestHits = venues.reduce((sum, venue) => sum + interests.filter((interest) => interestMatchesTags(interest, venue.tags)).length, 0);
      const plan = ItinerarySchema.parse({ ...proposal,
        ...(fromModel ? {
          id: planId, title: `方案 ${candidateIndex + 1}`, summary: venues.map((venue) => venue.name).join("、"),
          matchScore: Math.min(100, 60 + sharedHits * 12 + interestHits * 5),
          reasons: ["已核对地点、时间、路线和预算"],
        } : {}),
        stops, totalCost: budget.total, totalDistanceKm: route.totalDistanceKm,
        indoorRatio: venues.filter((place) => place.indoor).length / venues.length * 100,
        transfers: route.legs.filter((leg) => leg.mode === "transit").length,
      });
      const validation = await tools.validate_plan(toolInputSchemas.validate_plan.parse({ plan,
        walkingDistanceKm: route.legs.filter((leg) => leg.mode === "walking").reduce((sum, leg) => sum + leg.distanceKm, 0),
      }));
      routes.push(route);
      budgets.push(budget);
      const insufficientTravelTime = route.legs.some((leg, index) =>
        minutes(plan.stops[index + 1].startTime) - minutes(plan.stops[index].endTime) < leg.durationMinutes);
      validations.push({ candidateId: plan.id, validation: insufficientTravelTime ? { ...validation, valid: false,
        violations: [...validation.violations, { code: "OUTSIDE_TIME_RANGE", message: "Insufficient travel time", affectedStopIds: [] }],
      } : validation });
      // validatePlan checks opening and hard constraints; also reserve actual leg travel time.
      if (!validation.valid || insufficientTravelTime) {
        throw new PlanningError("INVALID_MODEL_RESULT");
      }
      verified.push(plan);
    }
    return verified;
  }

  let verified: Itinerary[] | undefined;
  if (final) {
    try { verified = await verify(final.plans, true); }
    catch (error) { if (deliveryFailed) throw error; fallbackReason = "INVALID_MODEL_RESULT"; }
  }
  if (!verified) {
    emit({ type: "run.degraded", reason: fallbackReason ?? "INVALID_MODEL_RESULT", fallback: "rule-planner" });
    try {
      verified = await verify(createRulePlans({ request, places: places.data, weather }));
    } catch (error) {
      if (deliveryFailed) throw error;
      emitVerification();
      emit({ type: "run.failed", code: error instanceof NoValidPlanError ? error.code : "NO_VALID_PLAN", message: "No three verified plans satisfy the request",
        ...(error instanceof NoValidPlanError ? { constraintCodes: error.violatedConstraintCodes } : {}),
      });
      return events;
    }
  }
  // Mandatory application verification is separate from model-requested calls.
  if (!events.some((event) => event.type === "tool.completed" && event.tool === "search_places")) {
    const selected = new Set(verified.flatMap((plan) => plan.stops.map((stop) => stop.placeId)));
    emit({ type: "tool.completed", tool: "search_places", summary: placesEvidence(places.data.filter((place) => selected.has(place.placeId))),
      durationMs: 0, source: "curated-shanghai-catalog" });
  }
  emitVerification();
  for (const plan of verified) emit({ type: "plan.proposed", plan });
  emit({ type: "run.completed", result: { runId, consensus, candidateIds: verified.map((plan) => plan.id) } });
  return events;
}
