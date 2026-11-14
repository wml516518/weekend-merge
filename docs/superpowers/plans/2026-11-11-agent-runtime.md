# Weekend Merge Agent Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the demo-only Netlify Function with a bounded, observable planning Agent that uses five deterministic tools, optional Gemini Function Calling, rule fallback, and locked-stop local replanning.

**Architecture:** Shared Zod contracts define every request, tool input/output, event, and model result. A server-only orchestrator owns the state machine and tool limits; Gemini may select registered tools and compose plans, but deterministic code recalculates and validates facts before emitting candidates. Both `plan` and `replan` return the existing NDJSON event protocol and degrade to a clearly marked rule planner when Gemini or weather is unavailable.

**Tech Stack:** TypeScript, Zod, Vitest, Netlify Functions, `@google/genai`, Open-Meteo, repository-owned Shanghai place data.

**Spec:** `docs/PRD.md`

## Global Constraints

- Initial planning uses at most 2 model requests and 6 tool calls.
- Each replan uses at most 1 model request, and a session permits at most 2 replans.
- API keys remain server-side and never use a `VITE_` prefix.
- Model output is always parsed with Zod before use.
- The model cannot invent weather, places, prices, routes, or opening hours.
- Demo/rule mode remains functional without network access or API keys.
- Every response event validates with `AgentEventSchema`.
- No public Nominatim autocomplete or systematic POI search is used.

---

### Task 1: Planning and Replanning Contracts

**Files:**
- Modify: `src/contracts/agent.ts`
- Modify: `src/contracts/agent.test.ts`

**Interfaces:**
- Consumes: existing `PlanSetupSchema`, `PersonPreferencesSchema`, `ItinerarySchema`, and `AgentEventSchema`.
- Produces: `PlanRequestSchema`, `ReplanRequestSchema`, `PlanResultSchema`, `PlanDiffSchema`, `ToolNameSchema`, and inferred TypeScript types.

- [ ] **Step 1: Write failing contract tests**

Add cases that parse a complete live planning request and reject a third replan:

```ts
const preferences = {
  interests: ["展览", "咖啡"],
  pace: "平衡",
  walkingLimitKm: 3,
  indoorPreference: "均可",
  foodTags: ["本帮菜"],
  budgetStyle: "平衡",
  avoid: ["排队"],
  wish: "想看一个展览",
} as const;

expect(PlanRequestSchema.parse({
  sessionId: "session-001",
  mode: "live",
  setup: {
    city: "上海",
    date: "2026-11-14",
    startTime: "13:00",
    endTime: "20:00",
    budget: 300,
    startingArea: "徐汇",
  },
  preferences: { a: preferences, b: preferences },
}).mode).toBe("live");

expect(ReplanRequestSchema.safeParse({
  sessionId: "session-001",
  plan: validItinerary,
  lockedStopIds: [validItinerary.stops[2].id],
  rejectedStopId: validItinerary.stops[0].id,
  reason: "不想排队",
  replanCount: 2,
  setup: validSetup,
  preferences: { a: preferences, b: preferences },
}).success).toBe(false);
```

- [ ] **Step 2: Run the contract test and confirm failure**

Run: `npm test -- --run src/contracts/agent.test.ts`

Expected: FAIL because `PlanRequestSchema` and `ReplanRequestSchema` are not exported.

- [ ] **Step 3: Add schemas and types**

Implement the request and diff contracts with these exact fields:

```ts
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
  preferences: z.object({ a: PersonPreferencesSchema, b: PersonPreferencesSchema }),
});

export const ReplanRequestSchema = z.object({
  sessionId: z.string().min(1).max(80),
  plan: ItinerarySchema,
  lockedStopIds: z.array(z.string()).max(10),
  rejectedStopId: z.string().min(1),
  reason: z.string().min(1).max(160),
  replanCount: z.number().int().min(0).max(1),
  setup: PlanSetupSchema,
  preferences: z.object({ a: PersonPreferencesSchema, b: PersonPreferencesSchema }),
});

export const PlanDiffSchema = z.object({
  replacedStopIds: z.array(z.string()),
  preservedStopIds: z.array(z.string()),
  summary: z.string().min(1),
});
```

Extend the completion payload with optional `diff: PlanDiffSchema` so the same event union supports plan and replan without duplicating the frontend protocol.

- [ ] **Step 4: Run the contract tests**

Run: `npm test -- --run src/contracts/agent.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/contracts/agent.ts src/contracts/agent.test.ts
git commit -m "feat: define live agent request contracts"
```

### Task 2: Curated Places and Deterministic Tools

**Files:**
- Create: `data/places.shanghai.json`
- Create: `netlify/functions/agent/tools/contracts.ts`
- Create: `netlify/functions/agent/tools/places.ts`
- Create: `netlify/functions/agent/tools/route.ts`
- Create: `netlify/functions/agent/tools/budget.ts`
- Create: `netlify/functions/agent/tools/tools.test.ts`
- Modify: `tsconfig.functions.json`

**Interfaces:**
- Consumes: `PlanSetup`, `PersonPreferences`, and repository JSON data.
- Produces: `searchPlaces(input, places)`, `estimateRoute(input)`, `calculateBudget(input)`, plus Zod schemas for all inputs and outputs.

- [ ] **Step 1: Write failing tool tests**

Cover filtering, route estimation, and budget arithmetic:

```ts
expect(searchPlaces({
  requiredTags: ["展览"],
  excludedTags: ["排队"],
  maxPricePerPerson: 100,
  indoorPreference: "indoor",
  areas: ["徐汇滨江"],
  openBetween: { start: "2026-11-14T13:00:00+08:00", end: "2026-11-14T18:00:00+08:00" },
  limit: 5,
}, fixturePlaces).places.map((place) => place.placeId)).toEqual(["west-bund-museum"]);

expect(estimateRoute({
  stops: [
    { placeId: "a", latitude: 31.2, longitude: 121.4 },
    { placeId: "b", latitude: 31.21, longitude: 121.41 },
  ],
  mode: "mixed",
}).estimated).toBe(true);

expect(calculateBudget({
  items: [{ category: "food", label: "晚餐", unitPrice: 100, quantity: 2 }],
  budgetLimit: 230,
  bufferRate: 0.1,
})).toMatchObject({ subtotal: 200, buffer: 20, total: 220, withinBudget: true });
```

- [ ] **Step 2: Run the tool test and confirm failure**

Run: `npm test -- --run netlify/functions/agent/tools/tools.test.ts`

Expected: FAIL because the tool modules do not exist.

- [ ] **Step 3: Add tool schemas and implementations**

Use Zod at every boundary. Route distance uses the Haversine formula; legs at or below 1.2 km are walking legs at 4.5 km/h, longer legs are transit legs at 18 km/h plus an 8-minute transfer buffer. Round public distances and currency to two decimals.

```ts
export function calculateBudget(input: CalculateBudgetInput): CalculateBudgetOutput {
  const subtotal = input.items.reduce(
    (sum, item) => sum + item.unitPrice * item.quantity,
    0,
  );
  const buffer = roundMoney(subtotal * input.bufferRate);
  const total = roundMoney(subtotal + buffer);
  return {
    subtotal: roundMoney(subtotal),
    buffer,
    total,
    withinBudget: total <= input.budgetLimit,
    breakdown: sumByCategory(input.items),
  };
}
```

Seed `places.shanghai.json` with at least 12 reviewable Shanghai venues across exhibition, bookstore, cafe, dinner, park, and night-view categories. Every record must include coordinates, price range, weekly opening hours, `sourceUrl`, and `lastVerifiedAt: "2026-11-11"`.

- [ ] **Step 4: Enable JSON imports in Functions TypeScript**

Add `"resolveJsonModule": true` to `tsconfig.functions.json` and include `data/**/*.json`.

- [ ] **Step 5: Run tool tests and the Functions type check**

Run: `npm test -- --run netlify/functions/agent/tools/tools.test.ts && npx tsc --noEmit -p tsconfig.functions.json`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add data/places.shanghai.json netlify/functions/agent/tools tsconfig.functions.json
git commit -m "feat: add deterministic planning tools"
```

### Task 3: Weather Tool and Plan Validator

**Files:**
- Create: `netlify/functions/agent/tools/weather.ts`
- Create: `netlify/functions/agent/tools/validator.ts`
- Create: `netlify/functions/agent/tools/weather.test.ts`
- Create: `netlify/functions/agent/tools/validator.test.ts`

**Interfaces:**
- Consumes: injectable `fetch`, `Itinerary`, `PlanSetup`, preferences, place records, and locked stop IDs.
- Produces: `createWeatherTool({ fetch, now })` and `validatePlan(input)`.

- [ ] **Step 1: Write failing weather and validation tests**

```ts
const fetchStub = vi.fn().mockResolvedValue(Response.json({
  hourly: {
    time: ["2026-11-14T13:00"],
    temperature_2m: [17],
    precipitation_probability: [65],
    weather_code: [61],
  },
}));
const weather = createWeatherTool({ fetch: fetchStub, now: () => new Date("2026-11-11T00:00:00Z") });
expect((await weather(validWeatherInput)).source).toBe("open-meteo");

expect(validatePlan({
  plan: overBudgetPlan,
  setup: { ...validSetup, budget: 200 },
  preferences: validPreferences,
  places: fixturePlaces,
  lockedStopIds: [],
  originalPlan: undefined,
}).violations.map((item) => item.code)).toContain("BUDGET_EXCEEDED");
```

Also assert cache reuse within 30 minutes, timeout behavior through an aborted fetch, duplicate place detection, time-range overflow, walking-limit overflow, and locked-stop mutation.

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `npm test -- --run netlify/functions/agent/tools/weather.test.ts netlify/functions/agent/tools/validator.test.ts`

Expected: FAIL because both modules are absent.

- [ ] **Step 3: Implement the weather client**

Build the Open-Meteo URL with `hourly=temperature_2m,precipitation_probability,weather_code`, `timezone=Asia/Shanghai`, and the request date. Use `AbortSignal.timeout(4000)`, validate response arrays, and cache by rounded coordinates plus date for 30 minutes. Throw `AgentToolError("WEATHER_UNAVAILABLE", true)` rather than fabricating weather.

- [ ] **Step 4: Implement deterministic validation**

Return `valid`, `violations`, and `warnings`. Check these codes exactly: `BUDGET_EXCEEDED`, `OUTSIDE_TIME_RANGE`, `PLACE_CLOSED`, `WALKING_LIMIT_EXCEEDED`, `AVOID_TAG_MATCHED`, `DUPLICATE_PLACE`, `LOCKED_STOP_CHANGED`, and `STALE_PLACE_DATA`. Compare locked stops by ID, place ID, times, and cost against `originalPlan`.

- [ ] **Step 5: Run focused tests**

Run: `npm test -- --run netlify/functions/agent/tools/weather.test.ts netlify/functions/agent/tools/validator.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add netlify/functions/agent/tools/weather.ts netlify/functions/agent/tools/validator.ts netlify/functions/agent/tools/weather.test.ts netlify/functions/agent/tools/validator.test.ts
git commit -m "feat: add weather and plan validation tools"
```

### Task 4: Consensus and Rule Planner

**Files:**
- Create: `netlify/functions/agent/fallbacks/consensus.ts`
- Create: `netlify/functions/agent/fallbacks/rulePlanner.ts`
- Create: `netlify/functions/agent/fallbacks/rulePlanner.test.ts`

**Interfaces:**
- Consumes: validated planning request, place-search results, optional weather, route and budget tools.
- Produces: `analyzeConsensus(request)` and `createRulePlans(context): Itinerary[]` with exactly three schema-valid candidates.

- [ ] **Step 1: Write the failing fallback scenario test**

```ts
const consensus = analyzeConsensus(validRequest);
expect(consensus.shared).toContain("展览");
expect(consensus.constraints).toContain("总预算 300 元");

const plans = createRulePlans(ruleContext);
expect(plans).toHaveLength(3);
expect(new Set(plans.map((plan) => plan.id)).size).toBe(3);
for (const plan of plans) {
  expect(ItinerarySchema.safeParse(plan).success).toBe(true);
  expect(validatePlan({ ...validationContext, plan }).valid).toBe(true);
}
```

- [ ] **Step 2: Run the fallback test and confirm failure**

Run: `npm test -- --run netlify/functions/agent/fallbacks/rulePlanner.test.ts`

Expected: FAIL because the consensus and rule planner modules are absent.

- [ ] **Step 3: Implement deterministic consensus**

Shared interests are the intersection of A and B interests. Conflicts describe pace, indoor preference, and walking-limit mismatches. Constraints always include budget, the lower walking limit, the activity time range, and the union of avoidance tags.

- [ ] **Step 4: Implement three rule-plan strategies**

Create candidates named `共同兴趣优先`, `移动最少`, and `预算余量优先`. Select only repository places, build times from typical duration plus estimated travel, calculate cost for two people plus route transport, then validate. If a strategy cannot produce a valid plan, rotate through the next ranked place combination; after 20 combinations, throw `NO_VALID_PLAN` with the violated constraint codes.

- [ ] **Step 5: Run the fallback test**

Run: `npm test -- --run netlify/functions/agent/fallbacks/rulePlanner.test.ts`

Expected: PASS with three distinct valid candidates.

- [ ] **Step 6: Commit**

```bash
git add netlify/functions/agent/fallbacks
git commit -m "feat: add deterministic rule planner"
```

### Task 5: Gemini Adapter and Controlled Orchestrator

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `netlify/functions/agent/model.ts`
- Create: `netlify/functions/agent/gemini.ts`
- Create: `netlify/functions/agent/orchestrator.ts`
- Create: `netlify/functions/agent/orchestrator.test.ts`

**Interfaces:**
- Consumes: `PlanRequest`, tool registry, rule planner, optional `AgentModel`.
- Produces: `runPlanningAgent(request, dependencies): Promise<AgentEvent[]>` and `createGeminiModel(config): AgentModel`.

- [ ] **Step 1: Install the official server SDK**

Run: `npm install @google/genai`

Expected: `package.json` and `package-lock.json` contain `@google/genai`; no browser code imports it.

- [ ] **Step 2: Write failing orchestrator scenarios**

Use an injected scripted model, clock, and tools:

```ts
const events = await runPlanningAgent(validRequest, {
  model: scriptedModel([
    { type: "tool_call", id: "call-1", name: "get_weather", args: validWeatherInput },
    { type: "final", consensus: validConsensus, plans: validPlans },
  ]),
  tools: fakeTools,
  now: () => new Date("2026-11-11T00:00:00Z"),
});
expect(events.filter((event) => event.type === "tool.completed")).toHaveLength(5);
expect(events.filter((event) => event.type === "plan.proposed")).toHaveLength(3);
expect(events.at(-1)?.type).toBe("run.completed");
```

Add tests proving: a seventh tool call fails with `TOOL_LIMIT_EXCEEDED`; an invalid final result emits `run.degraded` and uses rule plans without a third model request; missing model immediately uses rule plans; every proposed plan is re-costed and re-routed before validation.

- [ ] **Step 3: Run the orchestrator test and confirm failure**

Run: `npm test -- --run netlify/functions/agent/orchestrator.test.ts`

Expected: FAIL because the Agent model interface and orchestrator do not exist.

- [ ] **Step 4: Define the model boundary**

```ts
export type ModelTurn =
  | { type: "tool_call"; id: string; name: ToolName; args: unknown }
  | { type: "final"; consensus: ConsensusSummary; plans: Itinerary[] };

export interface AgentModel {
  next(input: {
    request: PlanRequest;
    toolResults: Array<{ id: string; name: ToolName; output: unknown }>;
    validationFeedback?: string[];
  }): Promise<ModelTurn>;
}
```

The Gemini adapter declares only registered tool schemas, requests JSON-compatible final output, passes function results back with the original call IDs, and maps SDK/network errors to `MODEL_UNAVAILABLE` without logging prompts or keys.

- [ ] **Step 5: Implement the state machine**

Emit `VALIDATE`, `ANALYZE`, `GATHER`, `PROPOSE`, and `VERIFY` step events in order. Enforce three model turns (initial tool selection, final proposal, optional validation repair) and eight tool executions. Always run route, budget, and validation in application code even when the model did not request them. A valid second-turn model result emits three candidates; a schema-valid but semantically invalid final can request one repair, after which the constrained planner may use model-selected venues. Unrepairable model or tool failures emit `run.degraded` and call `createRulePlans`.

- [ ] **Step 6: Run orchestrator tests and the full suite**

Run: `npm test -- --run netlify/functions/agent/orchestrator.test.ts && npm test -- --run`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json netlify/functions/agent/model.ts netlify/functions/agent/gemini.ts netlify/functions/agent/orchestrator.ts netlify/functions/agent/orchestrator.test.ts
git commit -m "feat: orchestrate Gemini planning with fallback"
```

### Task 6: Plan and Replan Netlify Functions

**Files:**
- Modify: `netlify/functions/plan.ts`
- Modify: `netlify/functions/plan.test.ts`
- Create: `netlify/functions/replan.ts`
- Create: `netlify/functions/replan.test.ts`
- Create: `netlify/functions/agent/http.ts`
- Create: `tests/fixtures/plan-request.demo.json`

**Interfaces:**
- Consumes: request schemas, `runPlanningAgent`, and deterministic local replanning.
- Produces: POST-only NDJSON endpoints with JSON errors for malformed input.

- [ ] **Step 1: Write failing endpoint tests**

Test these exact outcomes:

```ts
expect((await handler(new Request(url, { method: "GET" }))).status).toBe(405);
expect((await handler(postJson(url, { sessionId: "missing-fields" }))).status).toBe(400);

const demoResponse = await handler(postJson(url, { ...validRequest, mode: "demo" }));
expect(parseNdjson(demoResponse).at(-1)?.type).toBe("run.completed");

const lockedResponse = await replanHandler(postJson(replanUrl, lockedConflictRequest));
expect(lockedResponse.status).toBe(409);
expect(await lockedResponse.json()).toMatchObject({ error: { code: "LOCKED_STOP_CONFLICT" } });
```

Also assert a successful replan preserves all locked stops byte-for-byte, changes only the rejected stop and adjacent timing, returns `diff`, and rejects `replanCount: 2`.

Create `tests/fixtures/plan-request.demo.json` from the same valid request object with `mode: "demo"`; it becomes the committed smoke-test payload used by local and deployed verification.

- [ ] **Step 2: Run endpoint tests and confirm failure**

Run: `npm test -- --run netlify/functions/plan.test.ts netlify/functions/replan.test.ts`

Expected: FAIL because the plan request is still demo-only and `replan.ts` is absent.

- [ ] **Step 3: Implement shared HTTP helpers**

Create `jsonError(status, code, message, field?, retryable?)` and `ndjson(events)`. Validate every event with `AgentEventSchema.parse` before serialization. Set `Content-Type: application/x-ndjson; charset=utf-8` and `Cache-Control: no-store`.

- [ ] **Step 4: Replace the plan stub**

Parse `PlanRequestSchema`. In demo mode call `createDemoRun`; in live mode create the weather/place/tool registry and instantiate Gemini only when both `GEMINI_API_KEY` and `GEMINI_MODEL` are non-empty. Missing configuration must produce a `run.degraded` event and valid rule plans.

- [ ] **Step 5: Implement local replan**

Reject a rejected stop that is also locked. Calculate the affected index set as the rejected stop plus its immediate predecessor and successor, excluding locked stops. Rank alternative places by preference match, distance from preserved neighbors, indoor suitability, and price. Rebuild only affected times, then rerun route, budget, and validation. Emit `REPLAN`, tool events, one `plan.proposed`, and `run.completed` with `diff`.

- [ ] **Step 6: Run endpoint tests and production build**

Run: `npm test -- --run netlify/functions/plan.test.ts netlify/functions/replan.test.ts && npm run build`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add netlify/functions/plan.ts netlify/functions/plan.test.ts netlify/functions/replan.ts netlify/functions/replan.test.ts netlify/functions/agent/http.ts
git commit -m "feat: expose planning and replan functions"
```

### Task 7: Agent Documentation and Verification

**Files:**
- Modify: `README.md`
- Modify: `.env.example`
- Create: `docs/ARCHITECTURE.md`
- Create: `docs/DEMO.md`

**Interfaces:**
- Consumes: final endpoint behavior and environment names.
- Produces: contributor-facing architecture, local setup, curl examples, failure-mode demo steps, and deployment prerequisites.

- [ ] **Step 1: Update README status and server configuration**

Document `GEMINI_API_KEY`, `GEMINI_MODEL`, demo mode, live mode, the five tools, the two endpoints, and the exact commands `npm test -- --run` and `npm run build`. Do not describe any external service as unlimited or permanently free.

- [ ] **Step 2: Add architecture and demo documents**

`docs/ARCHITECTURE.md` must show the state transition sequence, model/code responsibility boundary, six-call/two-turn limits, and degradation paths. `docs/DEMO.md` must include fixed JSON requests for plan, no-key fallback, rejected-stop replan, and locked-stop conflict.

- [ ] **Step 3: Verify secrets and stale claims**

Run: `rg -n "GEMINI_API_KEY=.+|VITE_.*KEY|真实 Agent 将在|未来替换" . --glob '!node_modules/**' --glob '!package-lock.json'`

Expected: no committed key values and no README statements claiming the Agent is still a future stub.

- [ ] **Step 4: Run final Agent verification**

Run: `npm test -- --run && npm run build && git diff --check`

Expected: all tests pass, production build succeeds, and no whitespace errors are reported.

- [ ] **Step 5: Commit**

```bash
git add README.md .env.example docs/ARCHITECTURE.md docs/DEMO.md
git commit -m "docs: document agent runtime and demo"
```

