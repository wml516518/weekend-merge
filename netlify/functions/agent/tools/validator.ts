import { getParticipants, PlanDateSchema, type Itinerary, type PlanningPreferences, type PlanSetup } from "../../../../src/contracts/agent";

import type { Place } from "./contracts";
import { effectiveWalkingLimitKm, violatesAvoidedStop } from "./preferences";

export type ValidationCode =
  | "BUDGET_EXCEEDED"
  | "OUTSIDE_TIME_RANGE"
  | "PLACE_CLOSED"
  | "WALKING_LIMIT_EXCEEDED"
  | "AVOID_TAG_MATCHED"
  | "DUPLICATE_PLACE"
  | "LOCKED_STOP_CHANGED";

export type ValidationResult = {
  valid: boolean;
  violations: Array<{ code: ValidationCode; message: string; affectedStopIds: string[] }>;
  warnings: Array<{ code: "STALE_PLACE_DATA"; message: string }>;
};

export type ValidatePlanInput = {
  plan: Itinerary;
  setup: PlanSetup;
  preferences: PlanningPreferences;
  places: readonly Place[];
  walkingDistanceKm?: number;
  lockedStopIds: readonly string[];
  originalPlan?: Itinerary;
};

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;
const DAY_MS = 24 * 60 * 60 * 1000;

function minutes(time: string, allowMidnight = false): number {
  if (allowMidnight && time === "24:00") return 1440;
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  return match ? Number(match[1]) * 60 + Number(match[2]) : Number.NaN;
}

function isOpen(place: Place, date: string, startTime: string, endTime: string): boolean {
  const weekday = WEEKDAYS[new Date(`${date}T12:00:00+08:00`).getUTCDay()];
  const intervals = place.weeklyOpeningHours.find((group) => group.days.includes(weekday))?.intervals ?? [];
  const start = minutes(startTime);
  const end = minutes(endTime, true);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
  if (place.lastAdmissionTime && start > minutes(place.lastAdmissionTime)) return false;
  return intervals.some(({ open, close }) => {
    const closing = close === "24:00" ? 1440 : minutes(close);
    return start >= minutes(open) && end <= closing;
  });
}

export function validatePlan(input: ValidatePlanInput): ValidationResult {
  const { plan, setup, preferences, places, lockedStopIds, originalPlan } = input;
  const violations: ValidationResult["violations"] = [];
  const warnings: ValidationResult["warnings"] = [];
  if (!PlanDateSchema.safeParse(setup.date).success) {
    return {
      valid: false,
      violations: [{
        code: "OUTSIDE_TIME_RANGE",
        message: "Plan date is not a real calendar day",
        affectedStopIds: plan.stops.map((stop) => stop.id),
      }],
      warnings,
    };
  }
  const placeById = new Map(places.map((place) => [place.placeId, place]));
  const usedPlaces = new Set<string>();
  const participants = getParticipants(preferences);
  const avoided = [...new Set(participants.flatMap((person) => person.preferences.avoid))];
  const planDateMs = Date.parse(`${setup.date}T00:00:00Z`);
  const rangeStart = minutes(setup.startTime);
  const rangeEnd = minutes(setup.endTime, true);

  const totalCost = Math.max(plan.totalCost, plan.stops.reduce((sum, stop) => sum + stop.cost, 0));
  if (totalCost > setup.budget) {
    violations.push({ code: "BUDGET_EXCEEDED", message: "Plan cost exceeds the budget", affectedStopIds: plan.stops.map((stop) => stop.id) });
  }

  const walkingDistanceKm = input.walkingDistanceKm ?? plan.totalDistanceKm;
  const walkingLimitKm = effectiveWalkingLimitKm(preferences);
  if (!Number.isFinite(walkingDistanceKm) || walkingDistanceKm < 0 || walkingDistanceKm > walkingLimitKm) {
    violations.push({ code: "WALKING_LIMIT_EXCEEDED", message: "Walking distance exceeds a participant's limit", affectedStopIds: plan.stops.map((stop) => stop.id) });
  }

  for (const stop of plan.stops) {
    const start = minutes(stop.startTime);
    const end = minutes(stop.endTime, true);
    if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(rangeStart) ||
      !Number.isFinite(rangeEnd) || start < rangeStart || end > rangeEnd || start >= end) {
      violations.push({ code: "OUTSIDE_TIME_RANGE", message: "Stop falls outside the plan time range", affectedStopIds: [stop.id] });
    }

    if (usedPlaces.has(stop.placeId)) {
      violations.push({ code: "DUPLICATE_PLACE", message: "Place appears more than once", affectedStopIds: [stop.id] });
    }
    usedPlaces.add(stop.placeId);

    const place = placeById.get(stop.placeId);
    if (!place || !isOpen(place, setup.date, stop.startTime, stop.endTime)) {
      violations.push({ code: "PLACE_CLOSED", message: "Place is not verified open for the stop", affectedStopIds: [stop.id] });
    }

    if (violatesAvoidedStop(avoided, [...stop.tags, ...(place?.tags ?? [])], place?.indoor ?? true, stop.startTime)) {
      violations.push({ code: "AVOID_TAG_MATCHED", message: "Stop conflicts with an avoidance preference", affectedStopIds: [stop.id] });
    }

    if (place && Number.isFinite(planDateMs) && planDateMs - Date.parse(`${place.lastVerifiedAt}T00:00:00Z`) > 90 * DAY_MS) {
      warnings.push({ code: "STALE_PLACE_DATA", message: `${place.name} source data is more than 90 days old` });
    }
  }

  for (const lockedId of lockedStopIds) {
    const original = originalPlan?.stops.find((stop) => stop.id === lockedId);
    const current = plan.stops.find((stop) => stop.id === lockedId);
    if (!original || !current || original.placeId !== current.placeId ||
      original.startTime !== current.startTime || original.endTime !== current.endTime || original.cost !== current.cost) {
      violations.push({ code: "LOCKED_STOP_CHANGED", message: "Locked stop was removed or changed", affectedStopIds: [lockedId] });
    }
  }

  return { valid: violations.length === 0, violations, warnings };
}
