import { z } from "zod";

export const AgentStateSchema = z.enum([
  "VALIDATE",
  "ANALYZE",
  "GATHER",
  "PROPOSE",
  "VERIFY",
  "NEGOTIATE",
  "REPLAN",
  "FINALIZE",
]);

const StartTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const EndTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$|^24:00$/);

// Generous protocol ceilings for a local group outing, above the setup budget.
// Every public number must remain finite through JSON serialization.
const MAX_STOP_COST = 10_000;
const MAX_PLAN_COST = 100_000;
const MAX_PLAN_DISTANCE_KM = 1_000;
const MAX_TRANSFERS = 50;
const MAX_TOOL_DURATION_MS = 600_000;

export const InterestSchema = z.enum(["展览", "咖啡", "城市散步", "自然", "电影", "桌游", "夜景", "逛店", "美食"]);
export const ShanghaiAreaSchema = z.enum([
  "徐汇滨江", "徐汇", "黄浦", "静安", "浦东", "虹口", "长宁", "普陀", "杨浦", "闵行", "宝山",
  "松江", "青浦", "嘉定", "奉贤", "金山", "崇明", "静安寺", "人民广场", "徐家汇", "陆家嘴", "中山公园",
]);
export const PlanDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((date) => {
  const timestamp = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === date;
}, "Date must be a real calendar day").refine((date) => [0, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay()), "Date must be Saturday or Sunday");

export const PlanSetupSchema = z.object({
  city: z.literal("上海"),
  date: PlanDateSchema,
  startTime: StartTimeSchema,
  endTime: EndTimeSchema,
  budget: z.number().finite().min(100).max(12_000),
  startingArea: ShanghaiAreaSchema,
}).refine(({ startTime, endTime }) => {
  const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
  const duration = minutes(endTime) - minutes(startTime);
  return duration >= 180 && duration <= 720;
}, { message: "Duration must be 3 to 12 hours", path: ["endTime"] });
export const ReplanReasonCodeSchema = z.enum([
  "CHANGE_PLACE", "TOO_CROWDED", "TOO_EXPENSIVE", "TOO_MUCH_WALKING", "PREFER_INDOOR", "PREFER_OUTDOOR", "CHANGE_ACTIVITY",
]);
export const PublicConstraintCodeSchema = z.enum([
  "BUDGET_EXCEEDED", "OUTSIDE_TIME_RANGE", "PLACE_CLOSED", "WALKING_LIMIT_EXCEEDED", "AVOID_TAG_MATCHED",
  "DUPLICATE_PLACE", "LOCKED_STOP_CHANGED", "INSUFFICIENT_CANDIDATES",
]);
export type PublicConstraintCode = z.infer<typeof PublicConstraintCodeSchema>;
export type ReplanReasonCode = z.infer<typeof ReplanReasonCodeSchema>;

export const PersonPreferencesSchema = z.object({
  interests: z.array(InterestSchema).min(1).max(5),
  pace: z.enum(["轻松", "平衡", "充实"]),
  walkingLimitKm: z.union([
    z.literal(1),
    z.literal(3),
    z.literal(5),
    z.literal(8),
  ]),
  indoorPreference: z.enum(["室内优先", "均可", "户外优先"]),
  foodTags: z.array(z.string().min(1).max(30)).max(10),
  budgetStyle: z.enum(["省钱", "平衡", "体验优先"]),
  avoid: z.array(z.string().min(1).max(30)).max(10),
  wish: z.string().max(80),
});

export const ConsensusSummarySchema = z.object({
  shared: z.array(z.string()),
  conflicts: z.array(z.string()),
  constraints: z.array(z.string()),
});

export const ParticipantSchema = z.object({
  id: z.string().min(1).max(80),
  preferences: PersonPreferencesSchema,
});
export type Participant = z.infer<typeof ParticipantSchema>;

const GroupPreferencesSchema = z.object({
  participants: z.array(ParticipantSchema).min(2).max(6),
  a: z.never().optional(),
  b: z.never().optional(),
}).refine(({ participants }) => new Set(participants.map((person) => person.id)).size === participants.length, {
  message: "Participant IDs must be unique",
  path: ["participants"],
});
const LegacyPreferencesSchema = z.object({
  a: PersonPreferencesSchema, b: PersonPreferencesSchema,
  participants: z.never().optional(),
});
export type PlanningPreferences = z.infer<typeof GroupPreferencesSchema> | z.infer<typeof LegacyPreferencesSchema>;
const PlanPreferencesSchema = z.union([GroupPreferencesSchema, LegacyPreferencesSchema]);

function validateParticipantBudget(request: { preferences: PlanningPreferences; setup: { budget: number } }, context: z.RefinementCtx) {
  const ceiling = request.preferences.participants ? request.preferences.participants.length * 2000 : 2000;
  if (request.setup.budget > ceiling) context.addIssue({
    code: z.ZodIssueCode.custom, path: ["setup", "budget"], message: "Budget exceeds the participant allowance",
  });
}

export const ItineraryStopSchema = z.object({
  id: z.string().min(1),
  placeId: z.string().min(1),
  name: z.string().min(1),
  area: z.string().min(1),
  startTime: StartTimeSchema,
  endTime: EndTimeSchema,
  cost: z.number().finite().nonnegative().max(MAX_STOP_COST),
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
  tags: z.array(z.string()),
  locked: z.boolean().default(false),
});

export const ItinerarySchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  summary: z.string().min(1),
  matchScore: z.number().finite().min(0).max(100),
  totalCost: z.number().finite().nonnegative().max(MAX_PLAN_COST),
  totalDistanceKm: z.number().finite().nonnegative().max(MAX_PLAN_DISTANCE_KM),
  indoorRatio: z.number().finite().min(0).max(100),
  transfers: z.number().finite().int().nonnegative().max(MAX_TRANSFERS),
  stops: z.array(ItineraryStopSchema).min(1),
  reasons: z.array(z.string()).min(1),
});

export const ToolNameSchema = z.enum([
  "get_weather",
  "search_places",
  "estimate_route",
  "calculate_budget",
  "validate_plan",
]);

export const PlanRequestSchema = z.object({
  sessionId: z.string().min(1).max(80),
  mode: z.enum(["live", "demo"]).default("live"),
  setup: PlanSetupSchema,
  preferences: PlanPreferencesSchema,
}).superRefine(validateParticipantBudget);

export const ReplanRequestSchema = z.object({
  sessionId: z.string().min(1).max(80),
  plan: ItinerarySchema,
  lockedStopIds: z.array(z.string()).max(10),
  rejectedStopId: z.string().min(1),
  reason: z.string().min(1).max(160),
  reasonCode: ReplanReasonCodeSchema.optional(),
  replanCount: z.number().finite().int().min(0).max(1),
  setup: PlanSetupSchema,
  preferences: PlanPreferencesSchema,
}).superRefine(validateParticipantBudget);

export function getParticipants(preferences: PlanningPreferences): Participant[] {
  if (preferences.participants) return preferences.participants;
  return [
    { id: "member-1", preferences: preferences.a },
    { id: "member-2", preferences: preferences.b },
  ];
}

export const PlanDiffSchema = z.object({
  replacedStopIds: z.array(z.string()),
  preservedStopIds: z.array(z.string()),
  summary: z.string().min(1),
});

export const PlanResultSchema = z.object({
  runId: z.string().min(1),
  consensus: ConsensusSummarySchema,
  candidateIds: z.array(z.string().min(1)),
  diff: PlanDiffSchema.optional(),
}).superRefine((result, context) => {
  // Initial planning proposes three options; local replan replaces one selected plan.
  const expected = result.diff ? 1 : 3;
  if (result.candidateIds.length !== expected) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["candidateIds"],
      message: result.diff ? "Replan must return one candidate" : "Initial planning must return three candidates" });
  }
});

const RunStartedEventSchema = z.object({
  type: z.literal("run.started"),
  runId: z.string().min(1),
  at: z.string().datetime(),
});

const StepStartedEventSchema = z.object({
  type: z.literal("step.started"),
  step: AgentStateSchema,
  at: z.string().datetime(),
});

const ToolCompletedEventSchema = z.object({
  type: z.literal("tool.completed"),
  tool: ToolNameSchema,
  summary: z.record(z.unknown()),
  durationMs: z.number().finite().int().nonnegative().max(MAX_TOOL_DURATION_MS),
  source: z.string().min(1),
});

const ToolFailedEventSchema = z.object({
  type: z.literal("tool.failed"),
  tool: z.string().min(1),
  code: z.string().min(1),
  retryable: z.boolean(),
});

const PlanProposedEventSchema = z.object({
  type: z.literal("plan.proposed"),
  plan: ItinerarySchema,
});

const RunDegradedEventSchema = z.object({
  type: z.literal("run.degraded"),
  reason: z.string().min(1),
  fallback: z.string().min(1),
});

const RunCompletedEventSchema = z.object({
  type: z.literal("run.completed"),
  result: PlanResultSchema,
});

const RunFailedEventSchema = z.object({
  constraintCodes: z.array(PublicConstraintCodeSchema).max(8).optional(),
  type: z.literal("run.failed"),
  code: z.string().min(1),
  message: z.string().min(1),
});

export const AgentEventSchema = z.discriminatedUnion("type", [
  RunStartedEventSchema,
  StepStartedEventSchema,
  ToolCompletedEventSchema,
  ToolFailedEventSchema,
  PlanProposedEventSchema,
  RunDegradedEventSchema,
  RunCompletedEventSchema,
  RunFailedEventSchema,
]);

export type AgentState = z.infer<typeof AgentStateSchema>;
export type PlanSetup = z.infer<typeof PlanSetupSchema>;
export type PersonPreferences = z.infer<typeof PersonPreferencesSchema>;
export type PlanRequest = z.infer<typeof PlanRequestSchema>;
export type ReplanRequest = z.infer<typeof ReplanRequestSchema>;
export type ConsensusSummary = z.infer<typeof ConsensusSummarySchema>;
export type Itinerary = z.infer<typeof ItinerarySchema>;
export type PlanDiff = z.infer<typeof PlanDiffSchema>;
export type PlanResult = z.infer<typeof PlanResultSchema>;
export type ToolName = z.infer<typeof ToolNameSchema>;
export type AgentEvent = z.infer<typeof AgentEventSchema>;
