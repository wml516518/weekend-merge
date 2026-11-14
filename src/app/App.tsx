import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  CheckCheck,
  CircleHelp,
  EyeOff,
  Leaf,
  LockKeyhole,
  ShieldCheck,
} from "lucide-react";
import { createDemoRun } from "@/demo/demoRun";
import { PreferenceStep } from "@/features/wizard/PreferenceStep";
import { SetupStep } from "@/features/wizard/SetupStep";
import { ConsensusStep } from "@/features/wizard/ConsensusStep";
import { PlanningWorkbench } from "@/features/workbench/PlanningWorkbench";
import { FinalItinerary } from "@/features/final/FinalItinerary";
import { decodeShare } from "@/features/final/share";
import { usePlanningStore } from "@/state/usePlanningStore";
import { Modal, nextWeekend, Tag } from "@/components/Ui";
import { GroupApp } from "@/features/groups/GroupApp";

export function App() {
  const [hash, setHash] = useState(() => location.hash);
  useEffect(() => {
    const read = () => setHash(location.hash);
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);
  return hash === "#demo" || hash.startsWith("#share=") ? (
    <LegacyApp
      key={hash === "#demo" ? "demo" : "share"}
      explicitDemo={hash === "#demo"}
    />
  ) : (
    <GroupApp />
  );
}
function LegacyApp({ explicitDemo }: { explicitDemo: boolean }) {
  const store = usePlanningStore();
  const { stage, setup, preferences } = store;
  const [modal, setModal] = useState<"help" | "reset" | null>(null);
  const demoEvents = useMemo(
    () =>
      createDemoRun({
        runId:
          store.mode === "demo"
            ? (store.sessionId ?? "portfolio-demo-0")
            : "portfolio-demo-0",
      }),
    [store.mode, store.sessionId],
  );
  const [visibleEvents, setVisibleEvents] = useState(demoEvents.length);
  const events = demoEvents.slice(0, visibleEvents);
  const [shared, setShared] = useState<ReturnType<typeof decodeShare>>(null);
  const [shareError, setShareError] = useState("");
  const demoStarted = useRef(false);
  useEffect(() => {
    if (explicitDemo && !demoStarted.current) {
      demoStarted.current = true;
      demo();
    }
  }, [explicitDemo]);
  useEffect(() => {
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
  }, [stage]);
  useEffect(() => {
    const read = () => {
      try {
        setShared(decodeShare(location.hash));
        setShareError("");
      } catch (e) {
        setShared(null);
        setShareError(e instanceof Error ? e.message : "分享快照无法读取。");
      }
    };
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);
  useEffect(() => {
    if (
      stage !== "workbench" ||
      store.mode !== "demo" ||
      visibleEvents >= demoEvents.length
    )
      return;
    const timer = setTimeout(() => setVisibleEvents((n) => n + 1), 280);
    return () => clearTimeout(timer);
  }, [stage, store.mode, visibleEvents, demoEvents.length]);
  function playDemo() {
    store.openWorkbench("demo", globalThis.crypto.randomUUID());
    setVisibleEvents(1);
  }
  function demo() {
    store.reset();
    store.saveSetup({
      city: "上海",
      date: nextWeekend(),
      startTime: "13:00",
      endTime: "21:00",
      budget: 300,
      startingArea: "静安寺",
    });
    store.savePreferences("a", {
      interests: ["展览", "咖啡", "美食"],
      pace: "轻松",
      walkingLimitKm: 3,
      indoorPreference: "室内优先",
      foodTags: ["清淡"],
      budgetStyle: "平衡",
      avoid: ["长距离步行"],
      wish: "想看一个安静的展览，再慢慢喝杯咖啡。",
    });
    store.savePreferences("b", {
      interests: ["城市散步", "夜景", "咖啡", "美食"],
      pace: "平衡",
      walkingLimitKm: 5,
      indoorPreference: "均可",
      foodTags: ["本帮菜"],
      budgetStyle: "平衡",
      avoid: ["排队"],
      wish: "想看看街道和夜景，不用赶时间。",
    });
    playDemo();
  }
  const current =
    stage === "setup"
      ? 0
      : ["person-a", "person-b", "handoff"].includes(stage)
        ? 1
        : stage === "consensus"
          ? 2
          : stage === "workbench"
            ? 3
            : 4;
  return (
    <div className="app-shell">
      <header className="header">
        <button
          className="brand"
          aria-label="Weekend Merge 周末共识局"
          onClick={() => setModal("reset")}
        >
          <span className="brand-mark">
            <Leaf size={21} />
            <span />
          </span>
          <span>
            weekend<span className="brand-light">merge</span>
            <small>周末共识局</small>
          </span>
        </button>
        <nav className="top-nav" aria-label="应用导航">
          <span className="nav-active">我们的周末</span>
          <button onClick={() => setModal("help")}>
            它如何帮你 <ArrowUpRight size={14} />
          </button>
        </nav>
        <div className="header-right">
          <span className="demo-pill">
            <span />
            {shared
              ? "只读分享"
              : stage === "workbench" || stage === "final"
                ? store.mode === "live"
                  ? "实时规划"
                  : "演示模式"
                : "上海 · 双人计划"}
          </span>
          <button
            className="icon-button"
            aria-label="使用帮助"
            onClick={() => setModal("help")}
          >
            <CircleHelp size={20} />
          </button>
          <div className="avatar-pair">
            <span>A</span>
            <span>B</span>
          </div>
        </div>
      </header>
      {shareError ? (
        <main className="handoff">
          <h1>这份分享暂时打不开</h1>
          <p role="alert">{shareError}</p>
          <button
            className="button primary"
            onClick={() => {
              location.hash = "";
              store.reset();
            }}
          >
            创建自己的周末计划
          </button>
        </main>
      ) : shared ? (
        <FinalItinerary
          plan={shared.plan}
          setup={shared.setup}
          participantCount={shared.participantCount}
          readOnly
        />
      ) : (
        <>
          <nav
            className={`stepbar ${stage === "workbench" ? "compact" : ""}`}
            aria-label="规划进度"
          >
            <div className="stepbar-inner">
              {[
                "创建计划",
                "各自的期待",
                "共识揭晓",
                "一起选方案",
                "出发吧",
              ].map((name, i) => (
                <div className="step-group" key={name}>
                  <div
                    className={`step ${i === current ? "current" : ""} ${i < current ? "done" : ""}`}
                    aria-current={i === current ? "step" : undefined}
                  >
                    <span>
                      {i < current ? (
                        <Check size={12} />
                      ) : (
                        String(i + 1).padStart(2, "0")
                      )}
                    </span>
                    <label>{name}</label>
                  </div>
                  {i < 4 && (
                    <div className={`step-line ${i < current ? "done" : ""}`} />
                  )}
                </div>
              ))}
              <span className="saved-indicator">
                <CheckCheck size={14} />
                自动保存在此设备
              </span>
            </div>
          </nav>
          {stage === "setup" && (
            <SetupStep
              onSubmit={store.saveSetup}
              onDemo={demo}
              initial={setup}
            />
          )}{" "}
          {stage === "person-a" && (
            <PreferenceStep
              key="a"
              person="A"
              setup={setup}
              initial={preferences.a}
              onSubmit={(p) => store.savePreferences("a", p)}
              onBack={() => store.goTo("setup")}
            />
          )}{" "}
          {stage === "handoff" && (
            <main className="handoff">
              <div className="handoff-symbol">
                <span>A</span>
                <span>
                  <LockKeyhole size={26} />
                </span>
                <span>B</span>
              </div>
              <Tag>
                <ShieldCheck size={14} />A 的偏好已保存
              </Tag>
              <h1>现在，把设备交给 B。</h1>
              <p>
                A 的答案已经收好。
                <br />
                接下来，留一点空间给另一份期待。
              </p>
              <button className="button primary" onClick={store.handoffToB}>
                我是 B，开始填写 <ArrowRight size={17} />
              </button>
              <small>
                <EyeOff size={14} />
                不展示 A 的答案，也不预设 B 的选择
              </small>
            </main>
          )}{" "}
          {stage === "person-b" && (
            <PreferenceStep
              key="b"
              person="B"
              setup={setup}
              initial={preferences.b}
              onSubmit={(p) => store.savePreferences("b", p)}
              onBack={() => store.goTo("person-a")}
            />
          )}{" "}
          {stage === "consensus" && <ConsensusStep onPlan={playDemo} />}{" "}
          {stage === "workbench" && (
            <PlanningWorkbench
              key={store.sessionId}
              events={events}
              mode="demo"
              onRetry={playDemo}
              onEdit={() => setModal("reset")}
            />
          )}{" "}
          {stage === "final" && store.finalPlan && (
            <FinalItinerary
              plan={store.finalPlan}
              setup={setup}
              onBack={() => store.goTo("workbench")}
            />
          )}
        </>
      )}
      <footer className="footer">
        <span>
          weekendmerge <span>/ 让“都可以”变成“一起去”。</span>
        </span>
        <span>MADE FOR TWO, NOT FOR COMPROMISE.</span>
      </footer>
      {modal && (
        <Modal
          title={
            modal === "help" ? "少一点纠结，多一点一起。" : "重新准备一个周末？"
          }
          onClose={() => setModal(null)}
        >
          {modal === "help" ? (
            <>
              <p>分别写下期待，发现共同偏好，再从三个提案里选出喜欢的一份。</p>
              <ol>
                <li>设置时间、预算和碰面商圈。</li>
                <li>A / B 独立填写，通过遮罩完成设备交接。</li>
                <li>查看共识、地图和 Agent 工具结果。</li>
                <li>锁定喜欢的安排，最多替换两站。</li>
                <li>确认行程，导出 PNG 或只读分享链接。</li>
              </ol>
              <div className="help-note">
                实时规划会将双方填写的条件提交给规划服务。偏好保存在当前浏览器，分享快照只包含最终行程与公共条件。
              </div>
              <button className="button primary" onClick={() => setModal(null)}>
                明白了
              </button>
            </>
          ) : (
            <>
              <p>
                回到创建页后可修改条件；提交新条件将清空当前的锁定、点赞和替换记录。
              </p>
              <button
                className="button primary"
                onClick={() => {
                  location.hash = "";
                  store.goTo("setup");
                  setModal(null);
                }}
              >
                回到创建计划 <ArrowRight size={16} />
              </button>
              <button
                className="button secondary"
                onClick={() => setModal(null)}
              >
                保留当前计划
              </button>
            </>
          )}
        </Modal>
      )}
    </div>
  );
}
