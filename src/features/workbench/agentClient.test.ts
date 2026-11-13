import fixture from "../../../tests/fixtures/plan-request.demo.json";
import { PlanRequestSchema } from "@/contracts/agent";
import { createDemoRun } from "@/demo/demoRun";
import { requestAgent } from "./agentClient";

const request = PlanRequestSchema.parse(fixture);

describe("Agent NDJSON client", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("delivers progress before EOF and decodes a candidate split across UTF-8 chunks", async () => {
    const events = createDemoRun({ runId: "chunked" });
    const encoder = new TextEncoder();
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start: (controller) => { stream = controller; } });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, {
      headers: { "Content-Type": "application/x-ndjson; charset=utf-8" },
    })));
    let firstEvent!: () => void;
    const progress = new Promise<void>((resolve) => { firstEvent = resolve; });
    const onEvent = vi.fn(() => firstEvent());
    const result = requestAgent(request, new AbortController().signal, onEvent);
    stream.enqueue(encoder.encode(JSON.stringify(events[0]) + "\n"));
    await progress;
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith(events[0]);
    const tail = encoder.encode(events.slice(1).map((event) => JSON.stringify(event)).join("\n"));
    const split = tail.findIndex((byte) => byte >= 0xe0) + 1;
    stream.enqueue(tail.slice(0, split));
    stream.enqueue(tail.slice(split));
    stream.close();
    expect((await result).events).toEqual(events);
  });

  it("rejects a stream that ends before its terminal event", async () => {
    const events = createDemoRun({ runId: "truncated" }).slice(0, -1);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(events.map((event) => JSON.stringify(event)).join("\n"), {
      headers: { "Content-Type": "application/x-ndjson" },
    })));
    await expect(requestAgent(request, new AbortController().signal)).rejects.toThrow("规划响应不完整");
  });
});
