import { useState, type FormEvent } from "react";
import {
  PlanSetupSchema,
  ShanghaiAreaSchema,
  type PlanSetup,
} from "@/contracts/agent";
import { nextWeekend, shanghaiToday } from "@/components/Ui";

export function GroupCreate({
  onSubmit,
  busy,
  initial,
  minimumCount = 2,
}: {
  onSubmit: (value: {
    name: string;
    nickname: string;
    targetCount: number;
    setup: PlanSetup;
  }) => Promise<void>;
  busy: boolean;
  initial?: { setup: PlanSetup; targetCount: number };
  minimumCount?: number;
}) {
  const [targetCount, setCount] = useState(initial?.targetCount ?? 2);
  const [setup, setSetup] = useState<PlanSetup>(
    initial?.setup ?? {
      city: "上海",
      date: nextWeekend(),
      startTime: "13:00",
      endTime: "20:00",
      budget: 300,
      startingArea: "徐汇",
    },
  );
  const [name, setName] = useState("");
  const [nickname, setNickname] = useState("");
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    const parsed = PlanSetupSchema.safeParse(setup);
    if (!parsed.success || setup.budget > targetCount * 2000) {
      setError(
        "请选择周六或周日，活动时长 3–12 小时，总预算不超过每人 ¥2000。",
      );
      return;
    }
    setError("");
    await onSubmit({
      name: name.trim(),
      nickname: nickname.trim(),
      targetCount,
      setup: parsed.data,
    });
  }
  return (
    <form className="group-create" onSubmit={submit}>
      <h2>{initial ? "开启新一轮收集" : "约好共同的时间"}</h2>
      {!initial && (
        <>
          <label>
            计划名称
            <input
              required
              maxLength={40}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label>
            我的昵称
            <input
              required
              maxLength={40}
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
            />
          </label>
        </>
      )}
      <div className="group-fields">
        <label>
          参与人数
          <select
            value={targetCount}
            onChange={(e) => {
              const count = Number(e.target.value);
              setCount(count);
              setSetup((s) => ({
                ...s,
                budget:
                  s.budget === targetCount * 150
                    ? count * 150
                    : Math.min(s.budget, count * 2000),
              }));
            }}
          >
            {[2, 3, 4, 5, 6]
              .filter((n) => n >= minimumCount)
              .map((n) => (
                <option key={n} value={n}>
                  {n} 人
                </option>
              ))}
          </select>
        </label>
        <label>
          日期
          <input
            required
            type="date"
            min={shanghaiToday()}
            value={setup.date}
            onChange={(e) => setSetup({ ...setup, date: e.target.value })}
          />
        </label>
        <label>
          开始时间
          <input
            required
            type="time"
            value={setup.startTime}
            onChange={(e) => setSetup({ ...setup, startTime: e.target.value })}
          />
        </label>
        <label>
          结束时间
          <input
            required
            type="time"
            value={setup.endTime}
            onChange={(e) => setSetup({ ...setup, endTime: e.target.value })}
          />
        </label>
        <label>
          出发区域
          <select
            value={setup.startingArea}
            onChange={(e) =>
              setSetup({
                ...setup,
                startingArea: e.target.value as PlanSetup["startingArea"],
              })
            }
          >
            {ShanghaiAreaSchema.options.map((area) => (
              <option key={area}>{area}</option>
            ))}
          </select>
        </label>
        <div>
          <label>
            总预算（元）
            <input
              required
              type="number"
              min={100}
              max={targetCount * 2000}
              step={1}
              value={setup.budget}
              onChange={(e) =>
                setSetup({ ...setup, budget: Number(e.target.value) })
              }
            />
          </label>
          <small>
            人均 ¥{Math.round((setup.budget / targetCount) * 100) / 100}
          </small>
        </div>
      </div>
      {initial && (
        <p>
          已有 {minimumCount}{" "}
          位成员；如需减少人数，请先在收集中移除其他成员。每个人的草稿会保留，须重新确认提交。
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      <button className="button primary" disabled={busy} type="submit">
        {initial ? "确认开启新一轮" : "创建并邀请"}
      </button>
    </form>
  );
}
