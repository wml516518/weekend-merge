import { useEffect, useId, useState } from "react";
import { Check, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, WandSparkles } from "lucide-react";
import type { AgentEvent } from "@/contracts/agent";
import type { GroupView } from "@/contracts/groups";

const stepNames: Record<string, string> = {
  VALIDATE: "核对共同条件", ANALYZE: "分析成员兴趣支持", GATHER: "查询地点与出行资料",
  PROPOSE: "组合三个方案", VERIFY: "核对预算和路线", REPLAN: "调整选中方案", FINALIZE: "完成规划",
};
function eventText(event: AgentEvent) {
  switch (event.type) {
    case "run.started": return "本次规划已开始";
    case "step.started": return stepNames[event.step] ?? event.step;
    case "tool.completed": return `${event.tool} · 来源 ${event.source} · ${event.durationMs} ms`;
    case "tool.failed": return `${event.tool} 查询未完成 · ${event.code}`;
    case "run.degraded": return `当前使用降级结果 · ${event.fallback} · ${event.reason}`;
    case "plan.proposed": return `已生成提案：${event.plan.title}`;
    case "run.completed": return "本次规划已完成";
    case "run.failed": return `规划失败：${event.message}`;
  }
}

export function GroupTrace({ group }: { group: GroupView }) {
  const [expanded, setExpanded] = useState(false);
  const [desktopExpanded, setDesktopExpanded] = useState(true);
  const [isDesktop, setIsDesktop] = useState(() => window.matchMedia?.("(min-width: 1101px)").matches ?? true);
  useEffect(() => {
    const media = window.matchMedia?.("(min-width: 1101px)");
    if (!media) return;
    const update = () => setIsDesktop(media.matches);
    update();
    media.addEventListener?.("change", update);
    return () => media.removeEventListener?.("change", update);
  }, []);
  const visible = isDesktop ? desktopExpanded : expanded;
  const toggleLabel = `${visible ? "收起" : "展开"} Agent 轨迹`;
  const ToggleIcon = isDesktop ? (visible ? ChevronRight : ChevronLeft) : (visible ? ChevronUp : ChevronDown);
  const contentId = useId();
  if (!group.job) return null;
  return (
    <aside className={`group-trace-sidebar${expanded ? " is-expanded" : ""}${isDesktop && !desktopExpanded ? " is-desktop-collapsed" : ""}`} aria-label="Agent 轨迹侧栏">
      <button
        type="button"
        className="group-trace-toggle"
        title={toggleLabel}
        aria-label={toggleLabel}
        aria-expanded={visible}
        aria-controls={contentId}
        onClick={() => isDesktop ? setDesktopExpanded(!desktopExpanded) : setExpanded(!expanded)}
      >
        <ToggleIcon size={20} aria-hidden="true" />
      </button>
      <section className="group-events" aria-label="持久规划事件">
        <div className="group-trace-heading">
          <span className="group-kicker"><WandSparkles size={15} /> 规划过程</span>
          <h2>Agent 轨迹</h2>
          <p>查看规划进度与工具依据</p>
          <span className="group-attempt">第 {group.job.attempt} 次 · {group.job.kind === "replan" ? "局部调整" : "完整规划"}</span>
        </div>
        <div className="group-trace-content" id={contentId}>
          {group.job.events.length === 0 ? <p className="group-muted">任务已保存，等待规划事件…</p> : <ol>
            {group.job.events.map(({ sequence, event }) => (
              <li key={sequence}>
                <span className="group-event-dot"><Check size={12} /></span>
                <div><p>{eventText(event)}</p>{event.type === "tool.completed" && <details><summary>查看工具依据</summary><pre>{JSON.stringify(event.summary, null, 2)}</pre></details>}</div>
              </li>
            ))}
          </ol>}
        </div>
      </section>
    </aside>
  );
}
