import { useState } from "react";
import type { AgentEvent } from "@/contracts/agent";
import type { GroupView } from "@/contracts/groups";
import { RouteMap } from "@/components/RouteMap";
import { FinalItinerary } from "@/features/final/FinalItinerary";
import { groupClient } from "./client";

const stepNames: Record<string, string> = {
  VALIDATE: "核对共同条件",
  ANALYZE: "分析成员兴趣支持",
  GATHER: "查询地点与出行资料",
  PROPOSE: "组合三个方案",
  VERIFY: "核对预算和路线",
  REPLAN: "调整选中方案",
  FINALIZE: "完成规划",
};
function eventText(event: AgentEvent) {
  switch (event.type) {
    case "run.started":
      return "本次规划已开始";
    case "step.started":
      return stepNames[event.step] ?? event.step;
    case "tool.completed":
      return `${event.tool} · 来源 ${event.source} · ${event.durationMs} ms`;
    case "tool.failed":
      return `${event.tool} 查询未完成 · ${event.code}`;
    case "run.degraded":
      return `当前使用降级结果 · ${event.fallback} · ${event.reason}`;
    case "plan.proposed":
      return `已生成提案：${event.plan.title}`;
    case "run.completed":
      return "本次规划已完成";
    case "run.failed":
      return `规划失败：${event.message}`;
  }
}
export type GroupMutation = (
  operation: () => Promise<GroupView>,
) => Promise<boolean>;
export function GroupResults({
  group,
  busy,
  mutate,
}: {
  group: GroupView;
  busy: boolean;
  mutate: GroupMutation;
}) {
  const [reason, setReason] = useState("");
  const [rejectedStopId, setRejected] = useState("");
  const selected = group.candidates.find((p) => p.id === group.selectedPlanId);
  const final = group.candidates.find((p) => p.id === group.finalPlanId);
  const consensus =
    group.job?.result?.consensus ??
    [...(group.job?.events ?? [])]
      .reverse()
      .find((e) => e.event.type === "run.completed")?.event;
  const summary =
    consensus && "type" in consensus && consensus.type === "run.completed"
      ? consensus.result.consensus
      : consensus && "shared" in consensus
        ? consensus
        : undefined;
  const editable = group.canManage && group.state === "ready" && !busy;
  const catalogDisclosure = (
    <p>
      地点来自静态上海精选目录，营业时间与票价须出发前核实；路线、步行距离和费用为估算，非实时导航。
    </p>
  );
  const events = group.job && (
    <section className="group-events" aria-label="持久规划事件">
      <h2>一起等一个好周末</h2>
      <p>
        第 {group.job.attempt} 次尝试 ·{" "}
        {group.job.kind === "replan" ? "局部调整" : "完整规划"}
      </p>
      <ol>
        {group.job.events.map(({ sequence, event }) => (
          <li key={sequence}>
            {eventText(event)}
            {event.type === "tool.completed" && (
              <details>
                <summary>查看工具依据</summary>
                <pre>{JSON.stringify(event.summary, null, 2)}</pre>
              </details>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
  if (group.state === "finalized" && final)
    return (
      <section className="group-results">
        {events}
        {catalogDisclosure}
        <FinalItinerary
          plan={{
            ...final,
            stops: final.stops.map((s) => ({
              ...s,
              locked: group.lockedStopIds.includes(s.id),
            })),
          }}
          setup={group.setup}
          live
          participantCount={group.members.length}
        />
      </section>
    );
  return (
    <section className="group-results" aria-label="共同规划结果">
      {events}
      {group.state === "failed" && (
        <div className="group-notice" role="status">
          <p>
            本次规划失败（{group.job?.error ?? "请查看事件"}）。
            {group.candidates.length > 0
              ? "原有三个方案已保留；重试成功后才能选择或确认。"
              : "请发起人重试，或开启新一轮。"}
          </p>
          {group.canManage && (
            <button
              className="button primary"
              disabled={busy}
              onClick={() => mutate(() => groupClient.retry(group.id))}
            >
              重试本次规划
            </button>
          )}
        </div>
      )}
      {summary && (
        <section className="group-consensus">
          <h2>大家的兴趣交集</h2>
          <p>依据本轮已提交的偏好生成；成员兴趣覆盖见各方案说明。</p>
          {summary.shared.length ? (
            summary.shared.map((s) => (
              <p key={s}>
                {s} · {group.members.length}/{group.members.length} 人共同支持
              </p>
            ))
          ) : (
            <p>没有全员共同兴趣，将分别照顾大家的期待。</p>
          )}
          {summary.conflicts.map((s) => (
            <p key={s}>需要照顾：{s}</p>
          ))}
          {summary.constraints.map((s) => (
            <p key={s}>共同条件：{s}</p>
          ))}
        </section>
      )}
      {group.candidates.length > 0 && (
        <>
          <div className="group-section-heading">
            <h2>三个周末提案</h2>
            <span>已调整 {group.replanCount} / 2 次</span>
          </div>
          {catalogDisclosure}
          <div className="group-candidates">
            {group.candidates.map((plan) => (
              <article
                className={`group-candidate ${plan.id === selected?.id ? "selected" : ""}`}
                key={plan.id}
                aria-label={`候选方案 ${plan.title}`}
              >
                <small>
                  {plan.id === selected?.id ? "共同选中的方案" : "候选方案"}
                </small>
                <h3>{plan.title}</h3>
                <p>{plan.summary}</p>
                <p>
                  {group.members.length} 人总计 ¥{plan.totalCost} · 人均 ¥
                  {Math.round((plan.totalCost / group.members.length) * 100) /
                    100}
                </p>
                <p>
                  预计 {plan.totalDistanceKm} km · 室内 {plan.indoorRatio}%
                </p>
                <ul>
                  {plan.reasons.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
                {group.canManage && (
                  <button
                    className="button secondary"
                    disabled={!editable}
                    onClick={() =>
                      mutate(() =>
                        groupClient.select(group.id, {
                          version: group.stateVersion,
                          planId: plan.id,
                          lockedStopIds: [],
                        }),
                      )
                    }
                  >
                    选择方案 {plan.title}
                  </button>
                )}
              </article>
            ))}
          </div>
        </>
      )}
      {selected && (
        <section className="group-selected">
          <h2>已选择：{selected.title}</h2>
          <div className="group-itinerary">
            <div>
              {selected.stops.map((stop) => (
                <article className="group-stop" key={stop.id}>
                  <small>
                    {stop.startTime}–{stop.endTime} · {stop.area}
                  </small>
                  <h3>{stop.name}</h3>
                  <p>
                    {group.members.length} 人 ¥{stop.cost} ·{" "}
                    {stop.tags.join(" / ")}
                  </p>
                  {group.lockedStopIds.includes(stop.id) && <p>已锁定</p>}
                  {group.canManage && (
                    <div className="group-actions">
                      <button
                        className="text-button"
                        disabled={!editable}
                        onClick={() =>
                          mutate(() =>
                            groupClient.select(group.id, {
                              version: group.stateVersion,
                              planId: selected.id,
                              lockedStopIds: group.lockedStopIds.includes(
                                stop.id,
                              )
                                ? group.lockedStopIds.filter(
                                    (s) => s !== stop.id,
                                  )
                                : [...group.lockedStopIds, stop.id],
                            }),
                          )
                        }
                      >
                        {group.lockedStopIds.includes(stop.id)
                          ? "解锁"
                          : "锁定"}{" "}
                        {stop.name}
                      </button>
                      <button
                        className="text-button"
                        disabled={
                          !editable ||
                          group.replanCount >= 2 ||
                          group.lockedStopIds.includes(stop.id)
                        }
                        onClick={() => {
                          setRejected(stop.id);
                          setReason("");
                        }}
                      >
                        换个地方 {stop.name}
                      </button>
                    </div>
                  )}
                </article>
              ))}
            </div>
            <RouteMap plan={selected} />
          </div>
          {group.canManage && rejectedStopId && (
            <form
              className="group-replan"
              onSubmit={async (e) => {
                e.preventDefault();
                if (
                  reason.trim() &&
                  (await mutate(() =>
                    groupClient.replan(group.id, {
                      version: group.stateVersion,
                      rejectedStopId,
                      reason: reason.trim(),
                    }),
                  ))
                )
                  setRejected("");
              }}
            >
              <label>
                调整原因
                <textarea
                  required
                  maxLength={160}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              </label>
              <small>{reason.length}/160 · 局部调整最多两次</small>
              <button
                className="button primary"
                disabled={
                  !editable ||
                  !reason.trim() ||
                  group.replanCount >= 2 ||
                  group.lockedStopIds.includes(rejectedStopId)
                }
              >
                提交局部调整
              </button>
              <button
                className="text-button"
                type="button"
                onClick={() => setRejected("")}
              >
                取消调整
              </button>
            </form>
          )}
          {group.canManage && (
            <button
              className="button primary"
              disabled={!editable}
              onClick={() =>
                mutate(() =>
                  groupClient.finalize(group.id, {
                    version: group.stateVersion,
                    planId: selected.id,
                  }),
                )
              }
            >
              确认最终行程
            </button>
          )}
        </section>
      )}
    </section>
  );
}
