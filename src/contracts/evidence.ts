import { z } from "zod";
import { PublicConstraintCodeSchema } from "./agent";

const number = z.number().finite();
const count = number.int().nonnegative();
export const WeatherEvidenceSchema = z.object({
  source: z.enum(["open-meteo", "qweather"]), reference: z.literal("上海"),
  attributions: z.array(z.string()).optional(),
  interval: z.object({ start: z.string().datetime({ offset: true }), end: z.string().datetime({ offset: true }) }),
  hourlyCount: count, temperatureMinC: number.nullable(), temperatureMaxC: number.nullable(),
  maxPrecipitationProbability: number.min(0).max(100).nullable(),
});
export const PlacesEvidenceSchema = z.object({
  source: z.literal("curated-shanghai-catalog"), matchedCount: count,
  selectedPlaces: z.array(z.object({ placeId: z.string(), name: z.string(), lastVerifiedAt: z.string() })),
});
export const RouteEvidenceSchema = z.object({
  candidateCount: count, minDistanceKm: number.nonnegative(), maxDistanceKm: number.nonnegative(),
  minDurationMinutes: count, maxDurationMinutes: count,
  minWalkingDistanceKm: number.nonnegative(), maxWalkingDistanceKm: number.nonnegative(), estimated: z.literal(true),
});
export const BudgetEvidenceSchema = z.object({
  candidateCount: count, minTotal: number.nonnegative(), maxTotal: number.nonnegative(), budgetLimit: number.nonnegative(), withinBudgetCount: count,
});
export const ValidationEvidenceSchema = z.object({
  validCandidateCount: count, invalidCandidateCount: count,
  candidates: z.array(z.object({ candidateId: z.string(), violationCodes: z.array(PublicConstraintCodeSchema),
    warningCodes: z.array(z.literal("STALE_PLACE_DATA")) })),
});
