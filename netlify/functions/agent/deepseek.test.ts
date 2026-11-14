import { describe, expect, it, vi } from "vitest";

import type { PlanRequest } from "../../../src/contracts/agent";
import { createDeepSeekModel } from "./deepseek";

const request: PlanRequest = {
  sessionId: "deepseek-test", mode: "live",
  setup: { city: "上海", date: "2026-11-14", startTime: "11:00", endTime: "18:00", budget: 300, startingArea: "徐汇滨江" },
  preferences: {
    a: { interests: ["展览"], pace: "轻松", walkingLimitKm: 3, indoorPreference: "均可", foodTags: [], budgetStyle: "平衡", avoid: [], wish: "private wish" },
    b: { interests: ["咖啡"], pace: "平衡", walkingLimitKm: 5, indoorPreference: "均可", foodTags: [], budgetStyle: "平衡", avoid: [], wish: "" },
  },
};

function apiResponse(message: Record<string, unknown>, finishReason = "stop") {
  return new Response(JSON.stringify({
    id: "chatcmpl-test", object: "chat.completion", created: 1, model: "deepseek-flash",
    choices: [{ index: 0, finish_reason: finishReason, message: { role: "assistant", content: null, ...message } }],
  }), { status: 200, headers: { "content-type": "application/json" } });
}

describe("DeepSeek server adapter", () => {
  it("declares only whitelisted tools and returns tool calls before requesting final JSON", async () => {
    const requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      requests.push({
        url: String(input), headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      if (requests.length === 1) return apiResponse({ tool_calls: [
        { id: "call-places", type: "function", function: { name: "search_places", arguments: '{"limit":4}' } },
        { id: "call-weather", type: "function", function: { name: "get_weather", arguments: '{"latitude":31.17,"longitude":121.46}' } },
      ] }, "tool_calls");
      return apiResponse({ content: '{"type":"final","consensus":{"shared":[],"conflicts":[],"constraints":[]},"plans":[]}' });
    };
    const model = createDeepSeekModel({ apiKey: "test-only", model: "deepseek-flash", fetch: fetcher });

    expect(await model.next({ request, toolResults: [] })).toEqual({ type: "tool_calls", calls: [
      { id: "internal-1-1", wireId: "call-places", name: "search_places", args: { limit: 4 } },
      { id: "internal-1-2", wireId: "call-weather", name: "get_weather", args: { latitude: 31.17, longitude: 121.46 } },
    ] });
    expect(await model.next({ request, toolResults: [
      { id: "internal-1-1", wireId: "call-places", name: "search_places", output: { places: [] } },
      { id: "internal-1-2", wireId: "call-weather", name: "get_weather", output: { hourly: [] } },
    ] })).toEqual({ type: "final", consensus: { shared: [], conflicts: [], constraints: [] }, plans: [] });

    expect(requests).toHaveLength(2);
    expect(requests[0].url).toBe("https://api.deepseek.com/chat/completions");
    expect(requests[0].headers.get("authorization")).toBe("Bearer test-only");
    expect(requests[0].body).toMatchObject({
      model: "deepseek-flash", stream: false, tool_choice: "auto", thinking: { type: "disabled" },
    });
    const tools = requests[0].body.tools as Array<{ function: { name: string } }>;
    expect(tools.map((tool) => tool.function.name)).toEqual([
      "get_weather", "search_places", "estimate_route", "calculate_budget", "validate_plan",
    ]);
    expect(JSON.stringify(tools.find((tool) => tool.function.name === "validate_plan"))).not.toMatch(/places|originalPlan|preferences/);
    expect(requests[1].body).toMatchObject({
      model: "deepseek-flash", stream: false, thinking: { type: "disabled" },
      response_format: { type: "json_object" },
    });
    expect(requests[1].body.tools).toBeUndefined();
    expect(JSON.stringify(requests[0].body.messages)).toContain("combined setup budget is a hard limit");
    expect(requests[1].body.messages).toEqual([
      expect.objectContaining({ role: "system" }),
      expect.objectContaining({ role: "user" }),
      expect.objectContaining({ role: "assistant", tool_calls: expect.any(Array) }),
      { role: "tool", tool_call_id: "call-places", content: JSON.stringify({ places: [] }) },
      { role: "tool", tool_call_id: "call-weather", content: JSON.stringify({ hourly: [] }) },
    ]);
  });

  it("reads an immediate JSON final", async () => {
    const model = createDeepSeekModel({ apiKey: "test-only", fetch: async () => apiResponse({
      content: '{"type":"final","consensus":{"shared":[],"conflicts":[],"constraints":[]},"plans":[]}',
    }) });
    expect(await model.next({ request, toolResults: [] })).toEqual({
      type: "final", consensus: { shared: [], conflicts: [], constraints: [] }, plans: [],
    });
  });

  it("normalizes DeepSeek JSON mode's json_object discriminator", async () => {
    const model = createDeepSeekModel({ apiKey: "test-only", fetch: async () => apiResponse({
      content: '{"type":"json_object","consensus":{"shared":[],"conflicts":[],"constraints":[]},"plans":[]}',
    }) });
    expect(await model.next({ request, toolResults: [] })).toEqual({
      type: "final", consensus: { shared: [], conflicts: [], constraints: [] }, plans: [],
    });
  });

  it("normalizes model-provided ISO stop times to the HH:MM itinerary contract", async () => {
    const model = createDeepSeekModel({ apiKey: "test-only", fetch: async () => apiResponse({
      content: JSON.stringify({
        type: "final",
        consensus: { shared: [], conflicts: [], constraints: [] },
        plans: [{
          id: "plan-a",
          stops: [
            { placeId: "west-bund", startTime: "2026-11-14T13:30:00+08:00", endTime: "2026-11-14T15:00:00+08:00" },
            { placeId: "cafe", startTime: "2026-11-14T05:30:00Z", endTime: "2026-11-14T07:00:00Z" },
          ],
        }],
      }),
    }) });

    expect(await model.next({ request, toolResults: [] })).toMatchObject({
      type: "final",
      plans: [{
        stops: [
          { startTime: "13:30", endTime: "15:00" },
          { startTime: "13:30", endTime: "15:00" },
        ],
      }],
    });
  });

  it("reuses the tool conversation for one validation repair request", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const fetcher: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push(body);
      if (requests.length === 1) return apiResponse({ tool_calls: [
        { id: "call-places", type: "function", function: { name: "search_places", arguments: '{"limit":4}' } },
      ] }, "tool_calls");
      return apiResponse({ content: '{"type":"final","consensus":{"shared":[],"conflicts":[],"constraints":[]},"plans":[]}' });
    };
    const model = createDeepSeekModel({ apiKey: "test-only", fetch: fetcher });
    await model.next({ request, toolResults: [] });
    await model.next({ request, toolResults: [
      { id: "internal-1-1", wireId: "call-places", name: "search_places", output: { places: [] } },
    ] });
    await expect(model.next({
      request,
      toolResults: [{ id: "internal-1-1", wireId: "call-places", name: "search_places", output: { places: [] } }],
      validationFeedback: ["The previous final failed verification."],
    })).resolves.toMatchObject({ type: "final" });

    expect(requests).toHaveLength(3);
    expect(requests[2].messages).toEqual([
      expect.objectContaining({ role: "system" }),
      expect.objectContaining({ role: "user" }),
      expect.objectContaining({ role: "assistant", tool_calls: expect.any(Array) }),
      { role: "tool", tool_call_id: "call-places", content: JSON.stringify({ places: [] }) },
      expect.objectContaining({ role: "assistant", content: expect.stringContaining('"type":"final"') }),
      expect.objectContaining({ role: "user", content: expect.stringContaining("The previous final failed verification.") }),
    ]);
    expect(requests[2].tools).toBeUndefined();
  });

  it.each([
    ["HTTP failure", async () => new Response("upstream secret body", { status: 429 })],
    ["malformed response", async () => apiResponse({ content: "not-json" })],
    ["malformed tool arguments", async () => apiResponse({ tool_calls: [
      { id: "bad-call", type: "function", function: { name: "search_places", arguments: "{" } },
    ] }, "tool_calls")],
  ])("maps %s to a sanitized MODEL_UNAVAILABLE error without logging", async (_name, fetcher) => {
    const errorLog = vi.spyOn(console, "error");
    const model = createDeepSeekModel({ apiKey: "private-key", fetch: fetcher });
    await expect(model.next({ request, toolResults: [] })).rejects.toMatchObject({
      code: "MODEL_UNAVAILABLE", message: "MODEL_UNAVAILABLE",
    });
    expect(errorLog).not.toHaveBeenCalled();
    errorLog.mockRestore();
  });
});
