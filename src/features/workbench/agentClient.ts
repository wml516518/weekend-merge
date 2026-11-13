import {
  AgentEventSchema,
  type AgentEvent,
  type PlanRequest,
  type ReplanRequest,
} from "@/contracts/agent";

const errorMessages: Record<string, string> = {
  INVALID_REQUEST: "规划条件有误，请检查日期、时段或偏好后重试。",
  RATE_LIMITED: "规划请求过于频繁，请稍后再试。",
  LOCKED_STOP_CONFLICT: "这一站已锁定，请解锁后再替换。",
  NO_VALID_REPLAN: "没有找到满足当前条件的替代地点，原行程已保留。",
  NO_VALID_PLAN: "当前条件下未找到三套可行方案，可以调整条件后重试。",
  UNSUPPORTED_REPLAN_REASON: "请选择支持的替换理由后重试。",
};

export function agentErrorMessage(code: string) {
  return Object.hasOwn(errorMessages, code)
    ? errorMessages[code]
    : "服务暂时无法完成请求，请重试。";
}

type Completed = Extract<AgentEvent, { type: "run.completed" }>;

export async function requestAgent(
  request: PlanRequest | ReplanRequest,
  signal: AbortSignal,
  onEvent?: (event: AgentEvent) => void,
) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const timeout = setTimeout(abort, 65_000);
  try {
    return await readAgentResponse(request, controller.signal, onEvent);
  } catch (error) {
    if (controller.signal.aborted && !signal.aborted) {
      throw new Error("规划服务响应超时，请重试。");
    }
    if (error instanceof TypeError) throw new Error("无法连接规划服务，请检查网络后重试。");
    throw error;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", abort);
  }
}

async function readAgentResponse(
  request: PlanRequest | ReplanRequest,
  signal: AbortSignal,
  onEvent?: (event: AgentEvent) => void,
) {
  const replan = "rejectedStopId" in request;
  const response = await fetch(`/.netlify/functions/${replan ? "replan" : "plan"}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" },
    body: JSON.stringify(request),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(agentErrorMessage(body?.error?.code ?? (response.status === 429 ? "RATE_LIMITED" : "")));
  }
  if (!response.headers.get("Content-Type")?.toLowerCase().startsWith("application/x-ndjson") || !response.body) {
    throw new Error("规划接口未返回事件流，本地请通过 npm run dev 或 netlify dev 启动后重试。");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const events: AgentEvent[] = [];
  const candidates = new Set<string>();
  let startedId: string | undefined;
  let completed: Completed | undefined;
  let pending = "";
  let reachedEnd = false;
  const invalid = () => new Error("规划响应不完整，请重试。");

  function readLine(line: string) {
    if (!line.trim()) return;
    let value: unknown;
    try { value = JSON.parse(line); } catch { throw invalid(); }
    const parsed = AgentEventSchema.safeParse(value);
    if (!parsed.success || completed) throw invalid();
    const event = parsed.data;
    if (event.type === "run.started") {
      if (startedId) throw invalid();
      startedId = event.runId;
    } else if (!startedId) throw invalid();
    if (event.type === "run.failed") throw new Error(agentErrorMessage(event.code));
    if (event.type === "plan.proposed") candidates.add(event.plan.id);
    if (event.type === "run.completed") {
      const { runId, candidateIds, diff } = event.result;
      if (runId !== startedId || Boolean(diff) !== replan ||
        candidates.size !== candidateIds.length ||
        new Set(candidateIds).size !== candidateIds.length ||
        candidateIds.some((id) => !candidates.has(id))) throw invalid();
      completed = event;
    }
    events.push(event);
    // A result is actionable only after the whole stream has been validated.
    if (event.type !== "run.completed") onEvent?.(event);
  }

  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) {
        reachedEnd = true;
        readLine(pending + decoder.decode());
        break;
      }
      pending += decoder.decode(chunk.value, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) readLine(line);
    }
  } finally {
    if (!reachedEnd) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  if (!completed) throw invalid();
  return { events, result: completed.result };
}
