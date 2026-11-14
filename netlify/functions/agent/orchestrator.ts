import { randomUUID } from "node:crypto";
import { z } from "zod";

import { getParticipants, ItinerarySchema, PlanRequestSchema, ToolNameSchema, type AgentEvent, type Itinerary, type PlanRequest } from "../../../src/contracts/agent";
import { budgetEvidence, placesEvidence, routeEvidence, toolEvidence, validationEvidence, type CandidateValidation } from "./evidence";
import type { CalculateBudgetOutput, EstimateRouteOutput } from "./tools/contracts";
import { encodeAgentEvent } from "./http";
import { analyzeConsensus } from "./fallbacks/consensus";
import { createRulePlans, NoValidPlanError } from "./fallbacks/rulePlanner";
import { ModelFinalSchema, type AgentModel, type ModelInput } from "./model";
import { PlaceListSchema, type Place } from "./tools/contracts";
import { shanghaiPlaces } from "./tools/places";
import { interestCoverage, interestCoverageReason } from "./tools/preferences";
import { parsePlaceSearchInput } from "./tools/placeSearchInput";
import { createAgentTools, toolInputSchemas, weatherScopeForRequest, type AgentTools } from "./tools/registry";
import { AgentToolError, type WeatherOutput } from "./tools/weather";

const CallSchema = z.object({ id: z.string().min(1), wireId: z.string().min(1).optional(), name: z.string().min(1), args: z.unknown() });
const CallsSchema = z.union([
  CallSchema.extend({ type: z.literal("tool_call") }).transform((call) => [call]),
  z.object({ type: z.literal("tool_calls"), calls: z.array(CallSchema).min(1) }).transform(({ calls }) => calls),
]);

class PlanningError extends Error {
  constructor(readonly code: string, readonly feedback: string[] = []) { super(code); }
}

const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));

function repairFeedback(plans: Itinerary[] | undefined, request: PlanRequest): string[] {
  const participantCount = getParticipants(request.preferences).length;
  const signatures = (plans ?? []).map(plan =>
    [...new Set(plan.stops.map(stop => stop.placeId))].sort().join(","));
  const duplicates = signatures.filter((signature, index) => signatures.indexOf(signature) !== index);
  return [
    "The previous final JSON failed server-side semantic verification.",
    "Return exactly three plans with different unordered placeId sets; reordering a plan does not make it distinct.",
    ...(duplicates.length ? [`Duplicate placeId sets to replace: ${[...new Set(duplicates)].join(" | ")}`] : []),
    "Use only placeId values returned by search_places and exclude venues whose tags match the original avoid lists.",
    `The combined budget limit is ${request.setup.budget}. For each plan, sum each venue's maximum per-person price times ${participantCount}, add ${participantCount * 4} for each transit leg, apply a 10% buffer, and replace venues if the result is over budget.`,
    "Server rejection details below use mandatory catalog maximum prices. Do not invent discounts or free sections. Change the actual placeId combination for an over-budget plan; changing only totalCost or reasons cannot fix it.",
    `This group has ${participantCount} participants in total; the ${request.setup.budget} yuan limit applies to all participants together. Plans are distinct venue combinations, not per-person budgets.`,
    "Ensure every stop is open, inside the outing range, has realistic travel time between stops, and stays within the stricter walking cap.",
  ];
}

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
  const normalizedPreferences = { participants: getParticipants(request.preferences) };
  const requestForModel = { ...request, preferences: { participants: normalizedPreferences.participants.map((person, index) => ({
    id: `member-${index + 1}`, preferences: person.preferences,
  })) } };
  const places = PlaceListSchema.safeParse(dependencies.places ?? shanghaiPlaces);
  if (!places.success) {
    emit({ type: "run.failed", code: "INVALID_CATALOG", message: "Place catalog is invalid" });
    return events;
  }
  const tools = dependencies.tools ?? createAgentTools({
    request: { ...request, preferences: normalizedPreferences }, places: places.data, now: dependencies.now,
  });
  const consensus = analyzeConsensus(requestForModel);
  let weather: WeatherOutput | undefined;
  let fallbackReason: string | undefined;
  let useModelGuidedPlanner = false;
  let finalResponseRequested = false;
  let repairAttempted = false;
  let final: z.infer<typeof ModelFinalSchema> | undefined;
  const modelToolResults: ModelInput["toolResults"] = [];
  step("ANALYZE");
  step("GATHER");

  if (!dependencies.model) fallbackReason = "MODEL_UNAVAILABLE";
  else {
    try {
      let turn: unknown = await dependencies.model.next({ request: requestForModel, toolResults: [] });
      if (!ModelFinalSchema.safeParse(turn).success) {
        const parsedCalls = CallsSchema.safeParse(turn);
        if (!parsedCalls.success) throw new PlanningError("INVALID_MODEL_RESULT");
        const ids = new Set<string>();
        for (const [index, call] of parsedCalls.data.entries()) {
          let code: string | undefined;
          const name = ToolNameSchema.safeParse(call.name);
          let args: unknown;
          if (index >= 8) code = "TOOL_LIMIT_EXCEEDED";
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
            modelToolResults.push({ id: call.id, ...(call.wireId ? { wireId: call.wireId } : {}), name: tool, output });
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
        finalResponseRequested = true;
        turn = await dependencies.model.next({ request: requestForModel, toolResults: modelToolResults });
      }
      const candidate = ModelFinalSchema.safeParse(turn);
      if (!candidate.success) throw new PlanningError("INVALID_MODEL_RESULT");
      final = candidate.data;
    } catch (error) {
      if (deliveryFailed) throw error;
      fallbackReason = error instanceof PlanningError ? error.code : "MODEL_UNAVAILABLE";
      if (finalResponseRequested && dependencies.model && modelToolResults.length > 0) {
        repairAttempted = true;
        try {
          const repairedTurn = await dependencies.model.next({
            request: requestForModel,
            toolResults: modelToolResults,
            validationFeedback: repairFeedback(undefined, request),
          });
          const repaired = ModelFinalSchema.safeParse(repairedTurn);
          if (repaired.success) final = repaired.data;
          else fallbackReason = "INVALID_MODEL_RESULT";
        } catch {
          fallbackReason = "INVALID_MODEL_RESULT";
        }
      }
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
    const participantCount = normalizedPreferences.participants.length;
    if (proposals.length !== 3 || new Set(proposals.map((plan) => plan.id)).size !== 3 ||
      new Set(proposals.map((plan) => plan.stops.map((stop) => stop.placeId).sort().join(","))).size !== 3) {
      throw new PlanningError("INVALID_MODEL_RESULT");
    }
    const verified: Itinerary[] = [];
    const failures: string[] = [];
    for (const [candidateIndex, proposal] of proposals.entries()) {
      const venues = proposal.stops.map((stop) => {
        const place = placeById.get(stop.placeId);
        if (!place) throw new PlanningError("INVALID_MODEL_RESULT");
        return place;
      });
      const planId = fromModel ? `${runId}-candidate-${candidateIndex + 1}` : proposal.id;
      const stops = proposal.stops.map((stop, index) => ({ ...stop,
        id: fromModel ? `${planId}-stop-${index + 1}` : stop.id,
        name: venues[index].name, area: venues[index].area, cost: venues[index].priceRange.max * participantCount,
        latitude: venues[index].latitude, longitude: venues[index].longitude, tags: venues[index].tags, locked: false,
      }));
      const route = await tools.estimate_route(toolInputSchemas.estimate_route.parse({ stops, mode: "mixed" }));
      const items = venues.map((place) => ({ category: place.category as string, label: place.name, unitPrice: place.priceRange.max, quantity: participantCount }));
      for (const leg of route.legs) {
        if (leg.mode === "transit") items.push({ category: "transport", label: "交通预算", unitPrice: 4, quantity: participantCount });
      }
      const budget = await tools.calculate_budget(toolInputSchemas.calculate_budget.parse({ items, budgetLimit: request.setup.budget, bufferRate: 0.1 }));
      const coverage = interestCoverage(normalizedPreferences.participants, venues);
      const plan = ItinerarySchema.parse({ ...proposal,
        ...(fromModel ? {
          id: planId, title: `方案 ${candidateIndex + 1}`, summary: venues.map((venue) => venue.name).join("、"),
          matchScore: Math.round(60 + 40 * coverage.support / (participantCount * venues.length)),
          reasons: [
            interestCoverageReason(normalizedPreferences.participants, venues),
            "已核对地点、时间、路线和预算",
          ],
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
        failures.push(JSON.stringify({
          candidate: candidateIndex + 1, budgetLimit: request.setup.budget, totalCost: budget.total,
          venues: venues.map(place => ({ placeId: place.placeId, maxPricePerPerson: place.priceRange.max, quantity: participantCount })),
          violations: validations.at(-1)!.validation.violations.map(violation => ({ code: violation.code,
            placeIds: stops.filter(stop => violation.affectedStopIds.includes(stop.id)).map(stop => stop.placeId),
          })),
          travelLegs: route.legs.map((leg, index) => ({ fromPlaceId: leg.fromPlaceId, toPlaceId: leg.toPlaceId,
            mode: leg.mode, requiredMinutes: leg.durationMinutes,
            availableMinutes: minutes(stops[index + 1].startTime) - minutes(stops[index].endTime),
          })),
        }));
        continue;
      }
      verified.push(plan);
    }
    if (failures.length) throw new PlanningError("INVALID_MODEL_RESULT", failures);
    return verified;
  }

  let verified: Itinerary[] | undefined;
  if (final) {
    try {
      verified = await verify(final.plans, true);
    } catch (error) {
      if (deliveryFailed) throw error;
      const initialFailure = error instanceof PlanningError ? error.code : "INVALID_MODEL_RESULT";
      if (repairAttempted) {
        fallbackReason = initialFailure;
        useModelGuidedPlanner = true;
      } else if (!dependencies.model || modelToolResults.length === 0) {
        fallbackReason = initialFailure;
      } else {
        repairAttempted = true;
        try {
          const repairedTurn = await dependencies.model.next({
            request: requestForModel,
            toolResults: modelToolResults,
            validationFeedback: [...repairFeedback(final.plans, request), ...(error instanceof PlanningError ? error.feedback : [])],
          });
          const repaired = ModelFinalSchema.safeParse(repairedTurn);
          if (!repaired.success) throw new PlanningError("INVALID_MODEL_RESULT");
          final = repaired.data;
          verified = await verify(final.plans, true);
        } catch (repairError) {
          if (deliveryFailed) throw repairError;
          fallbackReason = repairError instanceof PlanningError ? repairError.code : "INVALID_MODEL_RESULT";
          useModelGuidedPlanner = Boolean(final);
        }
      }
    }
  }
  if (!verified) {
    emit({ type: "run.degraded", reason: fallbackReason ?? "INVALID_MODEL_RESULT", fallback: "rule-planner" });
    try {
      verified = await verify(createRulePlans({
        request,
        places: places.data,
        weather,
        ...(useModelGuidedPlanner && final
          ? { preferredPlaceIds: [...new Set(final.plans.flatMap(plan => plan.stops.map(stop => stop.placeId)))] }
          : {}),
      }));
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
