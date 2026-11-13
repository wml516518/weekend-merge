import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUpRight,
  Check,
  CheckCheck,
  ChevronDown,
  CloudRain,
  Coffee,
  Footprints,
  Heart,
  Info,
  Leaf,
  LoaderCircle,
  LockKeyhole,
  MapPin,
  RotateCcw,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Sun,
  TrainFront,
  Users,
  Wallet,
  WandSparkles,
} from "lucide-react";
import { ReplanRequestSchema, type AgentEvent, type ReplanReasonCode } from "@/contracts/agent";
import { WeatherEvidenceSchema } from "@/contracts/evidence";
import { dateLabel, Modal, Tag } from "@/components/Ui";
import { RouteMap } from "@/components/RouteMap";
import { usePlanningStore } from "@/state/usePlanningStore";
import { getCandidates, getRunStatus } from "./events";
import { requestAgent } from "./agentClient";

const toolLabels: Record<string, string> = {
  get_weather: "查看周末天气",
  search_places: "筛选合适的好去处",
  estimate_route: "串起顺路的行程",
  calculate_budget: "核算两人花费",
  validate_plan: "检查行程约束",
};
const vetoReasons: { label: string; code: ReplanReasonCode }[] = [
  { label: "不感兴趣", code: "CHANGE_PLACE" },
  { label: "想换一种体验", code: "CHANGE_ACTIVITY" },
  { label: "担心拥挤或排队", code: "TOO_CROWDED" },
  { label: "不符合饮食偏好", code: "CHANGE_PLACE" },
  { label: "其他原因", code: "CHANGE_PLACE" },
];
export function PlanningWorkbench({
  events,
  mode = "demo",
  planError,
  onRetry,
  onEdit,
}: {
  events: AgentEvent[];
  mode?: "demo" | "live";
  planError?: string;
  onRetry?: () => void;
  onEdit?: () => void;
}) {
  const candidates = useMemo(() => getCandidates(events), [events]);
  const status = planError ? { state: "failed" as const, message: planError } : getRunStatus(events);
  const live = mode === "live";
  const store = usePlanningStore();
  const { setup, preferences } = store;
  const [drawer, setDrawer] = useState<"detail" | "trace">("detail");
  const [veto, setVeto] = useState(false);
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [replanning, setReplanning] = useState(false);
  const pendingReplan = useRef<AbortController | null>(null);
  useEffect(() => () => pendingReplan.current?.abort(), []);
  const base =
    candidates.find((p) => p.id === store.activePlanId) ?? candidates[0];
  const plan = base ? (store.revisedPlans[base.id] ?? base) : undefined;
  const completedTools = [
    ...new Map(
      events.filter((e) => e.type === "tool.completed").map((e) => [e.tool, e]),
    ).values(),
  ];
  const failures = events.filter((e) => e.type === "tool.failed");
  const weather = completedTools.find((e) => e.tool === "get_weather");
  const liveWeather = WeatherEvidenceSchema.safeParse(weather?.summary).data;
  const active =
    plan?.stops.find((p) => p.id === store.activeStopId) ?? plan?.stops[0];
  const locked =
    !!active && (active.locked || store.lockedStops.includes(active.id));
  const walkLimit = Math.min(
    preferences.a?.walkingLimitKm ?? 8,
    preferences.b?.walkingLimitKm ?? 8,
  );
  const issues = plan
    ? [
        ...(setup && plan.totalCost > setup.budget
          ? ["方案费用超出当前预算"]
          : []),
        ...(!live && plan.totalDistanceKm > walkLimit ? ["预计步行超出双方上限"] : []),
        ...(setup &&
        plan.stops.some(
          (p) => p.startTime < setup.startTime || p.endTime > setup.endTime,
        )
          ? ["部分活动超出可用时段"]
          : []),
      ]
    : [];
  const isDone =
    events.some((e) => e.type === "run.completed") && status.state !== "failed";
  function closeVeto() {
    pendingReplan.current?.abort();
    setReplanning(false);
    setVeto(false);
  }
  async function replace() {
    if (!base || !plan || !active || pendingReplan.current || locked || !isDone ||
      store.replanCount >= 2 || !reason) return;
    setError("");
    if (!live) {
      if (!store.replaceDemoStop(plan, active.id, reason, note)) {
        setError("当前站点已锁定、已替换或已达到两轮调整上限。");
        return;
      }
      setVeto(false);
      return;
    }
    const input = ReplanRequestSchema.safeParse({
      sessionId: store.sessionId, setup, preferences, plan,
      lockedStopIds: plan.stops.filter((stop) => stop.locked || store.lockedStops.includes(stop.id)).map((stop) => stop.id),
      rejectedStopId: active.id,
      reason: [reason, note.trim()].filter(Boolean).join("，"),
      reasonCode: vetoReasons.find((item) => item.label === reason)?.code,
      replanCount: store.replanCount,
    });
    if (!input.success) {
      setError("当前行程无法提交替换，请重新规划后再试。");
      return;
    }
    const controller = new AbortController();
    pendingReplan.current = controller;
    setReplanning(true);
    try {
      const { events: updates, result } = await requestAgent(input.data, controller.signal);
      const revised = getCandidates(updates)[0];
      const diff = result.diff;
      const replacement = revised?.stops[plan.stops.indexOf(active)];
      if (!revised || !diff || !replacement || replacement.id === active.id ||
        revised.stops.length !== plan.stops.length ||
        diff.replacedStopIds.length !== 1 || diff.replacedStopIds[0] !== active.id ||
        plan.stops.some((stop, index) => stop.id !== active.id && (
          !diff.preservedStopIds.includes(stop.id) || revised.stops[index].id !== stop.id ||
          (input.data.lockedStopIds.includes(stop.id) &&
            JSON.stringify(revised.stops[index]) !== JSON.stringify(stop))
        ))) {
        throw new Error("替换结果不完整，原行程已保留。");
      }
      const latest = usePlanningStore.getState();
      if (controller.signal.aborted || latest.stage !== "workbench" ||
        latest.sessionId !== input.data.sessionId || latest.liveEvents !== store.liveEvents ||
        latest.replanCount !== input.data.replanCount) return;
      store.applyReplan(base.id, revised, {
        planId: base.id, stopId: active.id, replacementStopId: replacement.id,
        before: active.name, after: replacement.name, reason, note, diff,
      });
      setVeto(false);
    } catch (error) {
      if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "替换失败，请重试。");
    } finally {
      pendingReplan.current = null;
      if (!controller.signal.aborted) setReplanning(false);
    }
  }
  const trace = (
    <aside
      className={`trace-panel ${drawer !== "trace" ? "mobile-hidden" : ""}`}
      aria-label="Agent 执行轨迹"
    >
      <div className="trace-header">
        <span className="agent-icon">
          <Sparkles size={17} />
        </span>
        <div>
          <h2>周末规划 Agent</h2>
          <small>
            <span className="live-dot" />
            {status.message}
          </small>
        </div>
        <span className="trace-count">{completedTools.length} 项</span>
      </div>
      <div className="agent-message">
        “把你们各自的喜欢，
        <br />
        放进同一个周末里。”
      </div>
      <div className="tool-events">
        {completedTools.map((event) => (
          <details
            className="tool-event complete"
            key={event.tool}
            data-testid="tool-event"
          >
            <summary>
              <span className="event-dot">
                <Check size={11} />
              </span>
              <span>
                {toolLabels[event.tool] ?? event.tool}
                <small>已完成 · {event.durationMs} ms</small>
              </span>
              <ChevronDown size={12} />
            </summary>
            <div className="event-description">
              <code>{event.tool}</code>
              <dl>
                {Object.entries(event.summary).map(([key, value]) => (
                  <div key={key}>
                    <dt>{key}</dt>
                    <dd>
                      {typeof value === "object"
                        ? JSON.stringify(value)
                        : String(value)}
                    </dd>
                  </div>
                ))}
              </dl>
              <small>来源：{event.source}</small>
            </div>
          </details>
        ))}
      </div>
      {failures.map((e, i) => (
        <div className="inline-error" key={`${e.tool}-${i}`}>
          {e.tool}：{e.code} {e.retryable ? "· 可重试" : "· 当前不可重试"}
        </div>
      ))}
      {weather && (
        <div className="weather-card">
          <div>
            <CloudRain size={27} />
            <b>
              {liveWeather?.temperatureMinC != null && liveWeather.temperatureMaxC != null
                ? `${liveWeather.temperatureMinC}–${liveWeather.temperatureMaxC}°C`
                : !live && typeof weather.summary.temperatureC === "number"
                ? `${weather.summary.temperatureC}°`
                : "天气"}
              <small>
                {liveWeather?.maxPrecipitationProbability != null
                  ? `最高降雨概率 ${liveWeather.maxPrecipitationProbability}%`
                  : live ? "详见工具结果" : String(weather.summary.forecast ?? "详见工具结果")}
              </small>
            </b>
          </div>
          <p>来源：{weather.source} · {live ? "预报随时更新" : "演示天气"}</p>
        </div>
      )}
      {plan && (
        <div className="compromise">
          <h3>
            <Users size={15} />
            这次的折中
          </h3>
          {plan.reasons.map((r) => (
            <p key={r}>{r}</p>
          ))}
        </div>
      )}
      <div className="trace-footnote">
        <Info size={12} />
        <span>
          仅展示工具事件与结果摘要。
          <br />
          {live ? "路线、价格与营业时段请在出发前核对。" : "当前为演示运行。"}
        </span>
      </div>
    </aside>
  );
  return (
    <main className="workbench">
      <div className="workbench-heading">
        <div>
          <div className="eyebrow">YOUR WEEKEND, TOGETHER</div>
          <h1>
            好周末，从一个共识开始<span>。</span>
          </h1>
          <p>
            <MapPin size={13} />
            上海 <i />
            {setup ? dateLabel(setup.date) : "周末演示"}
            <i />
            {setup ? `${setup.startTime}–${setup.endTime}` : "双人计划"}
            <i />
            两人 ¥{setup?.budget ?? 300}
          </p>
        </div>
        <div className="workbench-buttons">
          <button
            className="text-button"
            onClick={onEdit ?? (() => store.goTo("setup"))}
          >
            <SlidersHorizontal size={15} />
            调整偏好
          </button>
          <button
            className="button primary"
            disabled={!plan || !isDone || issues.length > 0 || replanning}
            onClick={() => plan && store.finalize(plan)}
          >
            就是这个，去过周末 <ArrowUpRight size={16} />
          </button>
        </div>
      </div>
      {(status.state === "failed" || status.state === "degraded") && (
        <div className="constraint-warning" role="alert">
          <Info size={18} />
          <div>
            <b>
              {status.state === "failed"
                ? "这次规划未完成"
                : "当前使用降级结果"}
            </b>
            <p>{status.message}</p>
          </div>
          {onRetry && (status.state === "failed" || isDone) && (
            <button className="button secondary" onClick={onRetry}>
              {live ? "重新规划" : "重新运行演示"}
            </button>
          )}
        </div>
      )}
      {!plan ? (
        <div className="planning-empty">
          <LoaderCircle className={status.state === "failed" ? "" : "spin"} />
          <h2>{status.message}</h2>
          <p>工具结果会逐步显示，方案生成后即可查看。</p>
          {trace}
        </div>
      ) : (
        <div className="workbench-grid">
          <aside className="candidate-panel" aria-label="候选方案">
            <div className="panel-title">
              <h2>三个周末提案</h2>
              <span>{String(candidates.length).padStart(2, "0")}</span>
            </div>
            <p className="panel-subtitle">没有标准答案，选一个都心动的。</p>
            <div
              className="candidate-list"
              role="tablist"
              aria-label="切换候选方案"
            >
              {candidates.map((candidate, i) => {
                const p = store.revisedPlans[candidate.id] ?? candidate;
                const Icon = [Leaf, Sun, Coffee][i % 3];
                return (
                  <button
                    role="tab"
                    aria-selected={candidate.id === base?.id}
                    key={candidate.id}
                    className={`candidate ${p.id === plan.id ? "selected" : ""} ${["green", "peach", "lavender"][i % 3]}`}
                    onClick={() => store.selectPlan(candidate.id)}
                  >
                    <div className="candidate-art">
                      <span className="plan-letter">
                        PLAN {String.fromCharCode(65 + i)}
                      </span>
                      <Icon size={51} strokeWidth={1} />
                      <span className="art-lines" />
                    </div>
                    <div className="candidate-body">
                      <div className="candidate-label">
                        {!live && <span>
                          {
                            ["刚刚好的折中", "多一点城市风景", "慢一点也很好"][
                              i % 3
                            ]
                          }
                        </span>}
                        {p.id === plan.id ? (
                          <span className="selection-dot">
                            <Check size={11} />
                          </span>
                        ) : (
                          <span className="empty-dot" />
                        )}
                      </div>
                      <strong className="candidate-title">{p.title}</strong>
                      <p>{p.summary}</p>
                      <div className="candidate-stats">
                        <b>
                          ¥{p.totalCost}
                          <small> / 两人</small>
                        </b>
                        <span>{p.totalDistanceKm} km</span>
                        <span className="match">{p.matchScore}% 合拍</span>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
            <div className="candidate-tip">
              <Sparkles size={17} />
              <p>
                都照顾，也不将就。
                <br />
                <span>每个提案，为两个人各留一点喜欢。</span>
              </p>
            </div>
          </aside>
          <section className="route-panel">
            <div className="route-heading">
              <div>
                <h2>{plan.title}</h2>
                <span>
                  {[...new Set(plan.stops.map((p) => p.area))].join(" · ")} ·{" "}
                  {plan.stops.length} 站，慢慢来
                </span>
              </div>
              <Tag>
                <ShieldCheck size={12} />
                {issues.length ? "需要调整条件" : live ? (isDone ? "已核对约束" : "规划中") : "演示方案"}
              </Tag>
            </div>
            <div className="route-metrics">
              <div>
                <Wallet size={16} />
                <span>
                  <b>¥{plan.totalCost}</b>
                  <small>两人总计</small>
                </span>
              </div>
              <div>
                <Footprints size={16} />
                <span>
                  <b>{plan.totalDistanceKm} km</b>
                  <small>{live ? "预计总路程" : "预计步行"}</small>
                </span>
              </div>
              <div>
                <Coffee size={16} />
                <span>
                  <b>{plan.indoorRatio}%</b>
                  <small>室内活动</small>
                </span>
              </div>
              <div>
                <TrainFront size={16} />
                <span>
                  <b>{plan.transfers} 次</b>
                  <small>{live ? "预计交通段" : "换乘次数"}</small>
                </span>
              </div>
            </div>
            <RouteMap
              plan={plan}
              activeId={active?.id}
              onSelect={(id) => {
                store.selectStop(id);
                setDrawer("detail");
              }}
            />
            <div className="mobile-drawer-tabs">
              <button
                className={drawer === "detail" ? "selected" : ""}
                onClick={() => setDrawer("detail")}
              >
                行程详情
              </button>
              <button
                className={drawer === "trace" ? "selected" : ""}
                onClick={() => setDrawer("trace")}
              >
                Agent 执行轨迹
              </button>
            </div>
            <div
              className={`itinerary-detail ${drawer !== "detail" ? "mobile-hidden" : ""}`}
            >
              <div className="stop-tabs">
                {plan.stops.map((stop, i) => (
                  <button
                    key={stop.id}
                    className={active?.id === stop.id ? "selected" : ""}
                    aria-label={`查看第 ${i + 1} 站 ${stop.name}`}
                    onClick={() => store.selectStop(stop.id)}
                  >
                    <span>{i + 1}</span>
                    {stop.tags[0] ?? "活动"}
                    {(stop.locked || store.lockedStops.includes(stop.id)) && (
                      <LockKeyhole size={11} />
                    )}
                  </button>
                ))}
              </div>
              {active && (
                <div className="stop-detail">
                  <div className="stop-heading">
                    <div>
                      <span className="stop-time">
                        {active.startTime} — {active.endTime}
                      </span>
                      <h3>
                        {active.name}
                        {locked && <LockKeyhole size={15} />}
                      </h3>
                    </div>
                    <b>
                      ¥{active.cost}
                      <small> / 两人</small>
                    </b>
                  </div>
                  <p>
                    {active.area} · {plan.reasons[0]}
                  </p>
                  <div className="stop-tags">
                    {active.tags.map((t) => (
                      <Tag key={t}>{t}</Tag>
                    ))}
                    <span>{live ? "上海地点目录" : "演示地点数据"}</span>
                  </div>
                  {store.changes
                    .filter(
                      (c) => c.planId === base?.id && (c.replacementStopId ?? c.stopId) === active.id,
                    )
                    .map((change) => (
                      <div className="change-notice" key={change.stopId}>
                        <CheckCheck size={15} />
                        <span>
                          <del>{change.before}</del> → {change.after}
                          <br />
                          {change.diff?.summary ?? `保留 ${active.startTime}–${active.endTime}，其他站点保持不变。`}
                          <br />
                          原因：{change.reason}
                          {change.note && ` · ${change.note}`}
                        </span>
                      </div>
                    ))}
                  <div className="stop-actions">
                    <button
                      aria-pressed={store.likedStops.includes(active.id)}
                      className={
                        store.likedStops.includes(active.id) ? "liked" : ""
                      }
                      onClick={() => store.toggleLiked(active.id)}
                    >
                      <Heart size={15} />
                      {store.likedStops.includes(active.id)
                        ? "已喜欢"
                        : "喜欢这一站"}
                    </button>
                    <button
                      disabled={
                        locked ||
                        replanning ||
                        store.replanCount >= 2 ||
                        store.changes.some((c) => (c.replacementStopId ?? c.stopId) === active.id) ||
                        !isDone
                      }
                      onClick={() => {
                        setReason("");
                        setNote("");
                        setError("");
                        setVeto(true);
                      }}
                    >
                      <RotateCcw size={15} />
                      换个地方
                    </button>
                    <button
                      aria-label={`${locked ? "解锁" : "锁定"} ${active.name}`}
                      aria-pressed={locked}
                      className={locked ? "locked" : ""}
                      disabled={active.locked || replanning}
                      onClick={() => store.toggleLocked(active.id)}
                    >
                      <LockKeyhole size={15} />
                      {locked ? "已锁定" : "锁定这一站"}
                    </button>
                  </div>
                  {store.replanCount >= 2 && (
                    <p className="inline-error">
                      已完成两轮调整。如需继续，请调整偏好并重新开始。
                    </p>
                  )}
                </div>
              )}
            </div>
          </section>
          {trace}
        </div>
      )}
      {issues.length > 0 && (
        <div className="constraint-warning" role="alert">
          <Info size={18} />
          <div>
            <b>这套方案暂不满足你的条件</b>
            <p>{issues.join("；")}。可以选择其他方案或明确调整条件。</p>
          </div>
          <button
            className="button secondary"
            onClick={onEdit ?? (() => store.goTo("setup"))}
          >
            调整条件
          </button>
        </div>
      )}
      <div className="workbench-bottom">
        <span>
          <ShieldCheck size={13} />
          {live ? "替换后会重新核对时段、路线和费用。" : "当前为同区域、等费用的局部替换演示。"}
        </span>
        <span>已调整 {store.replanCount} / 2 次</span>
      </div>
      {veto && active && (
        <Modal title="这里，有哪里不合心意？" onClose={closeVeto}>
          <p>替换「{active.name}」，保留其他地点和已锁定安排。</p>
          <div className="veto-reasons">
            {vetoReasons.map(({ label: r }) => (
              <button
                key={r}
                className={reason === r ? "selected" : ""}
                disabled={replanning}
                onClick={() => setReason(r)}
              >
                {r}
                {reason === r && <Check size={13} />}
              </button>
            ))}
          </div>
          <textarea
            aria-label="否决补充说明"
            disabled={replanning}
            maxLength={60}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="也可以补充一句（选填，最多 60 字）"
          />
          <p className="modal-hint">
            <LockKeyhole size={14} />
            {live ? "已锁定站点保持不变，相邻未锁定站点的时间可能调整。" : "演示替换保留原时间、费用和坐标。"}
          </p>
          {error && <p role="alert">{error}</p>}
          <button
            className="button primary"
            disabled={!reason || replanning}
            onClick={replace}
          >
            <WandSparkles size={16} />
            {replanning ? "正在查找替代地点…" : "找一个替代方案"}
          </button>
        </Modal>
      )}
    </main>
  );
}
