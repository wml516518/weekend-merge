import { useState, type FormEvent, type SetStateAction } from "react";
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Coffee,
  Footprints,
  Leaf,
  Film,
  Users,
  Sparkles,
  ShoppingBag,
  Heart,
  EyeOff,
  CalendarDays,
  MoveUp,
  MoveDown,
} from "lucide-react";
import {
  InterestSchema,
  PersonPreferencesSchema,
  type PersonPreferences,
  type PlanSetup,
} from "@/contracts/agent";
import { dateLabel, Modal, Tag } from "@/components/Ui";

const interests = InterestSchema.options;
const icons = [
  BookOpen,
  Coffee,
  Footprints,
  Leaf,
  Film,
  Users,
  Sparkles,
  ShoppingBag,
  Heart,
];
export function PreferenceStep({
  person,
  onSubmit,
  onBack,
  initial,
  setup,
  headcount = 2,
  groupControls,
}: {
  person: string;
  onSubmit: (p: PersonPreferences) => void;
  onBack?: () => void;
  initial?: PersonPreferences;
  setup?: PlanSetup;
  headcount?: number;
  groupControls?: {
    busy: boolean;
    onDirty: () => void;
    onSaveDraft: (p: PersonPreferences) => void;
    changed: boolean;
    onSync: () => void;
  };
}) {
  const [draft, setDraftState] = useState<PersonPreferences>(
    initial ?? {
      interests: [],
      pace: "轻松",
      walkingLimitKm: 3,
      indoorPreference: "室内优先",
      foodTags: [],
      budgetStyle: "平衡",
      avoid: [],
      wish: "",
    },
  );
  function setDraft(value: SetStateAction<PersonPreferences>) {
    groupControls?.onDirty();
    setDraftState(value);
  }
  const [backConfirm, setBackConfirm] = useState(false);
  const toggleInterest = (value: PersonPreferences["interests"][number]) =>
    setDraft((old) => ({
      ...old,
      interests: old.interests.includes(value)
        ? old.interests.filter((item) => item !== value)
        : old.interests.length >= 5
          ? old.interests
          : [...old.interests, value],
    }));
  const toggleTextPreference = (key: "foodTags" | "avoid", value: string) =>
    setDraft((old) => ({
      ...old,
      [key]: old[key].includes(value)
        ? old[key].filter((item) => item !== value)
        : [...old[key], value],
    }));
  function submit(e: FormEvent) {
    e.preventDefault();
    const parsed = PersonPreferencesSchema.safeParse(draft);
    if (parsed.success) onSubmit(parsed.data);
  }
  function move(i: number, delta: number) {
    const items = [...draft.interests];
    [items[i], items[i + delta]] = [items[i + delta], items[i]];
    setDraft({ ...draft, interests: items });
  }
  return (
    <main className="wizard-page">
      <aside className="wizard-intro">
        <Tag>
          <EyeOff size={13} />
          {groupControls ? "独立填写 · 仅本人可见" : "独立填写 · 提交后隐藏"}
        </Tag>
        <h1 aria-label={`${person} 的周末偏好`}>
          你好，{person}。<br />
          这个周末，你想怎么过？
        </h1>
        <p>
          先听见自己的期待，再找到
          {groupControls ? `${headcount} 个人` : "两个人"}的交集。
          <br />
          你的答案暂时只属于你。
        </p>
        <div className={`person-art person-${person === "B" ? "b" : "a"}`}>
          <span>{person}</span>
          <Leaf size={80} />
        </div>
        {setup && (
          <div className="context-note">
            <CalendarDays size={16} />
            {dateLabel(setup.date)}
            <br />
            <span>
              {setup.startTime} — {setup.endTime} · {headcount} 人 ¥
              {setup.budget}
            </span>
          </div>
        )}
      </aside>
      <form className="preferences-card" onSubmit={submit}>
        {groupControls?.changed && (
          <div className="group-notice" role="status">
            服务器草稿已更新。你的编辑已保留，请同步后再保存。
            <button
              className="text-button"
              type="button"
              onClick={groupControls.onSync}
            >
              同步服务器草稿
            </button>
          </div>
        )}
        <fieldset className="plain-fieldset">
          <legend className="section-label">
            01 / 想做些什么 <small>选 1–5 项，按心动程度排序</small>
          </legend>
          <div className="interest-grid">
            {interests.map((name, i) => {
              const Icon = icons[i];
              return (
                <label
                  key={name}
                  className={`interest ${draft.interests.includes(name) ? "selected" : ""}`}
                >
                  <input
                    className="sr-only"
                    type="checkbox"
                    checked={draft.interests.includes(name)}
                    onChange={() => toggleInterest(name)}
                    aria-label={name}
                  />
                  <span className="interest-icon">
                    <Icon />
                  </span>
                  {name}
                  {draft.interests.includes(name) && (
                    <b>{draft.interests.indexOf(name) + 1}</b>
                  )}
                </label>
              );
            })}
          </div>
        </fieldset>
        {draft.interests.length > 1 && (
          <div className="rank-list">
            {draft.interests.map((name, i) => (
              <div key={name}>
                <span>
                  {i + 1}. {name}
                </span>
                <button
                  type="button"
                  aria-label={`上移${name}`}
                  disabled={i === 0}
                  onClick={() => move(i, -1)}
                >
                  <MoveUp size={12} />
                </button>
                <button
                  type="button"
                  aria-label={`下移${name}`}
                  disabled={i === draft.interests.length - 1}
                  onClick={() => move(i, 1)}
                >
                  <MoveDown size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="pref-columns">
          {(
            [
              {
                key: "pace",
                title: "活动节奏",
                options: ["轻松", "平衡", "充实"],
              },
              {
                key: "indoorPreference",
                title: "室内外",
                options: ["室内优先", "均可", "户外优先"],
              },
              {
                key: "budgetStyle",
                title: "预算倾向",
                options: ["省钱", "平衡", "体验优先"],
              },
            ] as const
          ).map((group) => (
            <fieldset className="field plain-fieldset" key={group.key}>
              <legend>{group.title}</legend>
              <div className="segmented">
                {group.options.map((value) => (
                  <button
                    type="button"
                    key={value}
                    aria-pressed={draft[group.key] === value}
                    className={draft[group.key] === value ? "selected" : ""}
                    onClick={() => setDraft({ ...draft, [group.key]: value })}
                  >
                    {value}
                  </button>
                ))}
              </div>
            </fieldset>
          ))}
          <fieldset className="field plain-fieldset">
            <legend>步行上限</legend>
            <div className="segmented">
              {([1, 3, 5, 8] as const).map((value) => (
                <button
                  type="button"
                  key={value}
                  aria-pressed={draft.walkingLimitKm === value}
                  className={draft.walkingLimitKm === value ? "selected" : ""}
                  onClick={() => setDraft({ ...draft, walkingLimitKm: value })}
                >
                  {value} 公里
                </button>
              ))}
            </div>
          </fieldset>
        </div>
        <fieldset className="field plain-fieldset">
          <legend>
            饮食偏好 <small>可多选</small>
          </legend>
          <div className="chips">
            {["清淡", "素食", "不吃海鲜", "本帮菜", "不限"].map((value) => (
              <label
                className={`check-chip ${draft.foodTags.includes(value) ? "selected" : ""}`}
                key={value}
              >
                <input
                  className="sr-only"
                  type="checkbox"
                  checked={draft.foodTags.includes(value)}
                  onChange={() => toggleTextPreference("foodTags", value)}
                />
                {value}
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset className="field plain-fieldset">
          <legend>这些，请帮我避开</legend>
          <div className="chips">
            {[
              "排队",
              "拥挤",
              "长距离步行",
              "早起",
              "辛辣",
              "酒吧",
              "户外日晒",
            ].map((value) => (
              <label
                className={`check-chip ${draft.avoid.includes(value) ? "selected avoid" : ""}`}
                key={value}
              >
                <input
                  className="sr-only"
                  type="checkbox"
                  checked={draft.avoid.includes(value)}
                  onChange={() => toggleTextPreference("avoid", value)}
                />
                {value}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="field">
          <label htmlFor={`wish-${person}`}>一句话愿望（可选）</label>
          <textarea
            id={`wish-${person}`}
            maxLength={80}
            value={draft.wish}
            placeholder="比如：想找一个能安静聊天的地方……"
            onChange={(e) => setDraft({ ...draft, wish: e.target.value })}
          />
          <small className="wish-counter">{draft.wish.length}/80</small>
        </div>
        <div className="wizard-actions">
          {onBack ? (
            <button
              className="text-button"
              type="button"
              onClick={() =>
                !groupControls && person === "B"
                  ? setBackConfirm(true)
                  : onBack()
              }
            >
              <ArrowLeft size={15} />
              {groupControls ? "返回大厅" : "上一步"}
            </button>
          ) : (
            <span />
          )}
          {groupControls && (
            <button
              className="button secondary"
              type="button"
              disabled={
                !draft.interests.length ||
                groupControls.busy ||
                groupControls.changed
              }
              onClick={() => groupControls.onSaveDraft(draft)}
            >
              保存我的草稿
            </button>
          )}
          <button
            className="button primary"
            type="submit"
            disabled={
              !draft.interests.length ||
              groupControls?.busy ||
              groupControls?.changed
            }
            aria-label={
              groupControls
                ? "提交我的偏好"
                : person === "A"
                  ? "隐藏答案"
                  : "保存并揭晓共识"
            }
          >
            {groupControls
              ? "提交我的偏好"
              : person === "A"
                ? "保存，交给另一位"
                : "保存，看看我们的交集"}
            <ArrowRight size={16} />
          </button>
        </div>
      </form>
      {backConfirm && (
        <Modal title="请确认设备已交还 A" onClose={() => setBackConfirm(false)}>
          <p>返回后会显示 A 的偏好。请先交还设备，B 尚未提交的内容不会保存。</p>
          <button className="button primary" type="button" onClick={onBack}>
            已交还 A，继续
          </button>
          <button
            className="button secondary"
            type="button"
            onClick={() => setBackConfirm(false)}
          >
            继续填写 B 的期待
          </button>
        </Modal>
      )}
    </main>
  );
}
