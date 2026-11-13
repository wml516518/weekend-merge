import type { AgentEvent, AgentState, Itinerary } from "@/contracts/agent";

const stepMessages: Partial<Record<AgentState, string>> = {
  VALIDATE: "正在核对规划条件",
  ANALYZE: "正在寻找双方的共同偏好",
  GATHER: "正在查询地点与出行信息",
  PROPOSE: "正在组合候选行程",
  VERIFY: "正在核对路线、时段与预算",
};

/** Deduplicate replayed proposals; keep the latest candidate payload for each ID. */
export function getCandidates(events: AgentEvent[]): Itinerary[] {
  const map = new Map<string, Itinerary>();
  for (const event of events)
    if (event.type === "plan.proposed") map.set(event.plan.id, event.plan);
  return [...map.values()];
}
export function getRunStatus(events: AgentEvent[]) {
  const terminal = [...events]
    .reverse()
    .find((e) => e.type === "run.failed" || e.type === "run.completed");
  if (terminal?.type === "run.failed")
    return { state: "failed" as const, message: terminal.message };
  const degraded = events.find((e) => e.type === "run.degraded");
  if (degraded?.type === "run.degraded")
    return {
      state: "degraded" as const,
      message: terminal
        ? "已使用本地地点和规则生成方案。"
        : "正在切换到规则规划。",
    };
  if (terminal?.type === "run.completed")
    return { state: "completed" as const, message: "这一轮，规划完成" };
  if (getCandidates(events).length)
    return { state: "partial" as const, message: "已有方案，正在继续规划" };
  const step = [...events].reverse().find((event) => event.type === "step.started");
  return {
    state: events.length ? ("running" as const) : ("queued" as const),
    message: step ? stepMessages[step.step] ?? "正在为你们寻找交集"
      : events.length ? "正在为你们寻找交集" : "已提交，等待规划",
  };
}
