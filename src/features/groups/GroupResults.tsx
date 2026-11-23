import { useState } from "react";
import {
  Check,
  Clock3,
  Footprints,
  LockKeyhole,
  Sparkles,
  UsersRound,
  WalletCards,
} from "lucide-react";
import type { GroupView } from "@/contracts/groups";
import { RouteMap } from "@/components/RouteMap";
import { Modal } from "@/components/Ui";
import { FinalItinerary } from "@/features/final/FinalItinerary";
import { groupClient } from "./client";

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
    <p className="group-catalog-note">
      地点来自静态上海精选目录，营业时间与票价须出发前核实；路线、步行距离和费用为估算，非实时导航。
    </p>
  );
  if (group.state === "finalized" && final)
    return (
      <section className="group-results">
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
          weather={group.weather}
        />
      </section>
    );
  return (
    <section className="group-results" aria-label="共同规划结果">
      {(group.state === "queued" || group.state === "running") && (
        <section className="group-consensus" role="status">
          <span className="group-kicker"><Sparkles size={14} /> 共同规划中</span>
          <h2>{group.state === "queued" ? "期待已到齐，等待开始" : "正在为大家安排这个周末"}</h2>
          <p>规划完成后会在这里展示候选方案，过程与工具依据可在 Agent 轨迹中查看。</p>
        </section>
      )}
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
          <span className="group-kicker"><Sparkles size={14} /> 共识摘要</span>
          <h2>大家的兴趣支持</h2>
          <p>依据本轮已提交的偏好生成；成员兴趣覆盖见各方案说明。</p>
          <div className="group-consensus-chips">
            {summary.interestSupport?.length ? (
              summary.interestSupport.map(({ interest, count, total }) => (
                <p key={interest}>{interest} · {count}/{total} 人支持</p>
              ))
            ) : summary.shared.length ? (
              summary.shared.map((s) => (
                <p key={s}>
                  {s} · {group.members.length}/{group.members.length} 人共同支持
                </p>
              ))
            ) : (
              <p>没有全员共同兴趣，将分别照顾大家的期待。</p>
            )}
          </div>
          {(summary.conflicts.length > 0 || summary.constraints.length > 0) && (
            <div className="group-consensus-notes">
              {summary.conflicts.map((s) => (
                <p key={s}>需要照顾：{s}</p>
              ))}
              {summary.constraints.map((s) => (
                <p key={s}>共同条件：{s}</p>
              ))}
            </div>
          )}
        </section>
      )}
      {group.candidates.length > 0 && (
        <>
          <div className="group-section-heading">
            <div>
              <span className="group-kicker"><Sparkles size={14} /> 候选方案</span>
              <h2>三个周末提案</h2>
            </div>
            <span className="group-attempt">已调整 {group.replanCount} / 2 次</span>
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
                <div className="group-plan-metrics">
                  <span><WalletCards size={15} />{group.members.length} 人 ¥{plan.totalCost}</span>
                  <span><Footprints size={15} />预计 {plan.totalDistanceKm} km</span>
                  <span><UsersRound size={15} />人均 ¥{Math.round((plan.totalCost / group.members.length) * 100) / 100}</span>
                  <span><Clock3 size={15} />室内 {plan.indoorRatio}%</span>
                </div>
                <ul>
                  {plan.reasons.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
                {group.canManage && (
                  <button
                    className="button secondary"
                    disabled={!editable}
                    onClick={async () => {
                      const saved = await mutate(() =>
                        groupClient.select(group.id, {
                          version: group.stateVersion,
                          planId: plan.id,
                          lockedStopIds: [],
                        }),
                      );
                      if (saved && window.matchMedia?.("(max-width: 1100px)").matches) {
                        requestAnimationFrame(() => document.getElementById(`group-selected-${group.id}`)?.scrollIntoView({
                          behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
                          block: "start",
                        }));
                      }
                    }}
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
        <section id={`group-selected-${group.id}`} className="group-selected">
          <div className="group-selected-heading">
            <span className="group-icon-box"><Check size={19} /></span>
            <div>
              <small>当前共同选择</small>
              <h2>已选择：{selected.title}</h2>
            </div>
          </div>
          <div className="group-itinerary">
            <div>
              {selected.stops.map((stop) => (
                <article className="group-stop" key={stop.id}>
                  <span className="group-stop-dot" aria-hidden="true" />
                  <small>
                    {stop.startTime}–{stop.endTime} · {stop.area}
                  </small>
                  <h3>{stop.name}</h3>
                  <p>
                    {group.members.length} 人 ¥{stop.cost} ·{" "}
                    {stop.tags.join(" / ")}
                  </p>
                  {group.lockedStopIds.includes(stop.id) && (
                    <span className="group-locked-tag"><LockKeyhole size={13} />已锁定</span>
                  )}
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
                        className="text-button group-change-place"
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
                        换个地方：{stop.name}
                      </button>
                    </div>
                  )}
                </article>
              ))}
            </div>
            <RouteMap plan={selected} />
          </div>
          {group.canManage && rejectedStopId && (
            <Modal title={`换个地方：${selected.stops.find((stop) => stop.id === rejectedStopId)?.name ?? "当前站点"}`} onClose={() => setRejected("")}>
            <p>只调整这一站，保留已锁定的安排。请告诉我们想换个地方的原因。</p>
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
            </Modal>
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
