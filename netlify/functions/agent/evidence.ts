import { PublicConstraintCodeSchema, type PlanRequest, type ToolName } from "../../../src/contracts/agent";
import { BudgetEvidenceSchema, PlacesEvidenceSchema, RouteEvidenceSchema, ValidationEvidenceSchema, WeatherEvidenceSchema } from "../../../src/contracts/evidence";
import { CalculateBudgetOutputSchema, EstimateRouteOutputSchema, SearchPlacesOutputSchema, type CalculateBudgetOutput, type EstimateRouteOutput, type Place } from "./tools/contracts";
import { weatherScopeForRequest } from "./tools/registry";
import type { ValidationResult } from "./tools/validator";
import type { WeatherOutput } from "./tools/weather";

const minimum = (values: number[]) => values.length ? Math.min(...values) : 0;
const maximum = (values: number[]) => values.length ? Math.max(...values) : 0;
export const routeEvidence = (routes: EstimateRouteOutput[]) => RouteEvidenceSchema.parse({
  candidateCount: routes.length, estimated: true,
  minDistanceKm: minimum(routes.map((route) => route.totalDistanceKm)), maxDistanceKm: maximum(routes.map((route) => route.totalDistanceKm)),
  minDurationMinutes: minimum(routes.map((route) => route.totalDurationMinutes)), maxDurationMinutes: maximum(routes.map((route) => route.totalDurationMinutes)),
  minWalkingDistanceKm: minimum(routes.map(walkingDistance)), maxWalkingDistanceKm: maximum(routes.map(walkingDistance)),
});
export const walkingDistance = (route: EstimateRouteOutput) => route.legs.filter((leg) => leg.mode === "walking").reduce((sum, leg) => sum + leg.distanceKm, 0);
export const budgetEvidence = (budgets: CalculateBudgetOutput[], budgetLimit: number) => BudgetEvidenceSchema.parse({
  candidateCount: budgets.length, minTotal: minimum(budgets.map((budget) => budget.total)), maxTotal: maximum(budgets.map((budget) => budget.total)),
  budgetLimit, withinBudgetCount: budgets.filter((budget) => budget.total <= budgetLimit).length,
});
export type CandidateValidation = { candidateId: string; validation: ValidationResult };
export const validationEvidence = (rows: CandidateValidation[]) => ValidationEvidenceSchema.parse({
  validCandidateCount: rows.filter(({ validation }) => validation.valid).length,
  invalidCandidateCount: rows.filter(({ validation }) => !validation.valid).length,
  candidates: rows.map(({ candidateId, validation }) => ({ candidateId,
    violationCodes: [...new Set(validation.violations.flatMap(({ code }) => {
      const parsed = PublicConstraintCodeSchema.safeParse(code); return parsed.success ? [parsed.data] : [];
    }))],
    warningCodes: validation.warnings.some(({ code }) => code === "STALE_PLACE_DATA") ? ["STALE_PLACE_DATA"] : [],
  })),
});
export function placesEvidence(selected: readonly Place[]) {
  return PlacesEvidenceSchema.parse({ source: "curated-shanghai-catalog", matchedCount: selected.length,
    selectedPlaces: selected.map(({ placeId, name, lastVerifiedAt }) => ({ placeId, name, lastVerifiedAt })),
  });
}

export function toolEvidence(tool: ToolName, output: unknown, request: PlanRequest, places: readonly Place[], candidateId: string): Record<string, unknown> {
  switch (tool) {
    case "get_weather": {
      const weather = output as WeatherOutput;
      const scope = weatherScopeForRequest(request);
      const temperatures = weather.hourly.map((hour) => hour.temperatureC);
      const rain = weather.hourly.map((hour) => hour.precipitationProbability);
      return WeatherEvidenceSchema.parse({ source: weather.source, ...(weather.attributions ? { attributions: weather.attributions } : {}), reference: "上海", interval: { start: scope.start, end: scope.end },
        hourlyCount: weather.hourly.length, temperatureMinC: temperatures.length ? minimum(temperatures) : null,
        temperatureMaxC: temperatures.length ? maximum(temperatures) : null, maxPrecipitationProbability: rain.length ? maximum(rain) : null,
      });
    }
    case "search_places": {
      const selected = new Set(SearchPlacesOutputSchema.parse(output).places.map((place) => place.placeId));
      return placesEvidence(places.filter((place) => selected.has(place.placeId)));
    }
    case "estimate_route": return routeEvidence([EstimateRouteOutputSchema.parse(output)]);
    case "calculate_budget": return budgetEvidence([CalculateBudgetOutputSchema.parse(output)], request.setup.budget);
    case "validate_plan": return validationEvidence([{ candidateId, validation: output as ValidationResult }]);
  }
}
