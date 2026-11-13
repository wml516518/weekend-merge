import {
  ArrowRight,
  Heart,
  LockKeyhole,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Check,
  WandSparkles,
} from "lucide-react";
import { Tag } from "@/components/Ui";
import { usePlanningStore } from "@/state/usePlanningStore";

export function ConsensusStep({ onPlan }: { onPlan: () => void }) {
  const { setup, preferences, goTo } = usePlanningStore();
  const { a, b } = preferences;
  const common = a?.interests.filter((i) => b?.interests.includes(i)) ?? [];
  const avoids = [...new Set([...(a?.avoid ?? []), ...(b?.avoid ?? [])])];
  const food = [...new Set([...(a?.foodTags ?? []), ...(b?.foodTags ?? [])])];
  return (
    <main className="consensus-page">
      <div className="center-heading">
        <Tag>
          <Sparkles size={14} />
          两份期待，正在靠近
        </Tag>
        <h1>原来，我们的周末有这些交集。</h1>
        <p>保留各自的小坚持，也为对方留一点空间。</p>
      </div>
      <div className="consensus-grid">
        <section>
          <div className="consensus-icon">
            <Heart />
          </div>
          <span className="eyebrow">THE COMMON GROUND</span>
          <h2>一起喜欢的事</h2>
          <div className="chips">
            {common.length ? (
              common.map((x) => <Tag key={x}>{x}</Tag>)
            ) : (
              <Tag>一起探索新的体验</Tag>
            )}
          </div>
          <p>
            {common.length
              ? "从这些共同期待开始，让两个人都能享受这一天。"
              : "兴趣不同也没关系，为两个人各留一段专属时间。"}
          </p>
        </section>
        <section>
          <div className="consensus-icon peach">
            <SlidersHorizontal />
          </div>
          <span className="eyebrow">A LITTLE GIVE & TAKE</span>
          <h2>可以商量的小不同</h2>
          <div className="person-row">
            <b>A</b>
            <span>
              {a?.interests.filter((x) => !common.includes(x)).join("、") ||
                "和你想得一样"}
            </span>
          </div>
          <div className="person-row">
            <b>B</b>
            <span>
              {b?.interests.filter((x) => !common.includes(x)).join("、") ||
                "和你想得一样"}
            </span>
          </div>
          <p>把不同兴趣串在同一条路上，减少为了迁就而奔波。</p>
        </section>
        <section>
          <div className="consensus-icon">
            <ShieldCheck />
          </div>
          <span className="eyebrow">OUR NON-NEGOTIABLES</span>
          <h2>说好了，就不妥协</h2>
          <ul className="constraint-list">
            <li>
              <Check size={14} />
              总预算不超过 ¥{setup?.budget ?? 300}
            </li>
            <li>
              <Check size={14} />
              {setup?.startTime}–{setup?.endTime}，步行 ≤{" "}
              {Math.min(a?.walkingLimitKm ?? 3, b?.walkingLimitKm ?? 3)} 公里
            </li>
            <li>
              <Check size={14} />
              避开：{avoids.join("、") || "无额外雷区"}
            </li>
            <li>
              <Check size={14} />
              饮食：{food.join("、") || "无特殊要求"}
            </li>
          </ul>
        </section>
      </div>
      <div className="consensus-actions">
        <span>
          <LockKeyhole size={14} />
          开始规划后，双方的条件将用于生成候选行程
        </span>
        <button className="button primary" onClick={onPlan}>
          <WandSparkles size={17} />
          开始规划 <ArrowRight size={16} />
        </button>
        <div className="edit-prefs">
          <button onClick={() => goTo("person-a")}>修改 A 的偏好</button>
          <span>·</span>
          <button onClick={() => goTo("person-b")}>修改 B 的偏好</button>
        </div>
      </div>
    </main>
  );
}
