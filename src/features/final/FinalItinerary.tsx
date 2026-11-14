import { useState } from "react";
import {
  ArrowLeft,
  CheckCheck,
  Download,
  Footprints,
  Leaf,
  Link,
  LockKeyhole,
  Sparkles,
} from "lucide-react";
import type { Itinerary, PlanSetup } from "@/contracts/agent";
import { dateLabel, Tag } from "@/components/Ui";
import { RouteMap } from "@/components/RouteMap";
import { encodeShare, exportItinerary } from "./share";

export function FinalItinerary({
  plan,
  setup,
  onBack,
  readOnly = false,
  live = false,
  participantCount = 2,
}: {
  plan: Itinerary;
  setup?: PlanSetup;
  onBack?: () => void;
  readOnly?: boolean;
  live?: boolean;
  participantCount?: number;
}) {
  const [message, setMessage] = useState("");
  const [exporting, setExporting] = useState(false);
  async function download() {
    setExporting(true);
    try {
      await exportItinerary(plan, setup, live, participantCount);
      setMessage("行程长图已生成。");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "导出失败，请重试。");
    } finally {
      setExporting(false);
    }
  }
  async function share() {
    try {
      const hash = encodeShare(plan, setup, participantCount);
      await navigator.clipboard.writeText(
        `${location.origin}${location.pathname}${hash}`,
      );
      setMessage("只读分享链接已复制，不包含个人偏好。");
    } catch (e) {
      setMessage(
        e instanceof Error ? e.message : "剪贴板不可用，请使用导出长图。",
      );
    }
  }
  const subtotal = plan.stops.reduce((sum, s) => sum + s.cost, 0);
  return (
    <main className="final-page">
      <div className="center-heading">
        <Tag>
          {readOnly ? <LockKeyhole size={15} /> : <CheckCheck size={15} />}{" "}
          {readOnly ? "只读分享快照" : `${participantCount} 人，都说好`}
        </Tag>
        <h1>{plan.title}。</h1>
        <p>
          {setup
            ? `${dateLabel(setup.date)} · 上海 · ${setup.startTime}–${setup.endTime}`
            : `上海 · ${participantCount} 个人的周末`}
        </p>
      </div>
      <div className="final-layout">
        <section className="final-card">
          <div className="final-card-top">
            <span>OUR LITTLE WEEKEND</span>
            <Leaf size={26} />
          </div>
          {plan.stops.map((stop, i) => (
            <div className="final-stop" key={stop.id}>
              <span className="number-circle">{i + 1}</span>
              <div>
                <small>
                  {stop.startTime} — {stop.endTime}
                </small>
                <h3>
                  {stop.name}
                  {stop.locked && <LockKeyhole size={14} />}
                </h3>
                <p>
                  {stop.area} · {stop.tags.join(" / ")}
                </p>
                <Tag>{stop.tags[0] ?? "周末活动"}</Tag>
                <span className="final-price">
                  {participantCount} 人 ¥{stop.cost}
                </span>
                {i < plan.stops.length - 1 && (
                  <div className="transit-note">
                    <Footprints size={13} />
                    下一站 {plan.stops[i + 1].startTime} 开始 · 路线为估算
                  </div>
                )}
              </div>
            </div>
          ))}
        </section>
        <aside>
          <div className="final-summary">
            <h2>周末小账本</h2>
            <div>
              <span>站点费用合计</span>
              <b>¥{subtotal}</b>
            </div>
            {plan.totalCost >= subtotal && (
              <div>
                <span>其他费用</span>
                <b>¥{plan.totalCost - subtotal}</b>
              </div>
            )}
            <div className="summary-total">
              <span>{participantCount} 人总计</span>
              <b>¥{plan.totalCost}</b>
            </div>
            <div>
              <span>人均估算</span>
              <b>
                ¥{Math.round((plan.totalCost / participantCount) * 100) / 100}
              </b>
            </div>
            <p>
              {setup
                ? `预算余量 ¥${setup.budget - plan.totalCost}`
                : "费用为估算"}{" "}
              · 费用拆分以工具结果为准
            </p>
            <hr />
            <div>
              <span>预计总路程</span>
              <b>{plan.totalDistanceKm} km</b>
            </div>
            <div>
              <span>室内活动占比</span>
              <b>{plan.indoorRatio}%</b>
            </div>
            <div>
              <span>{live || readOnly ? "预计交通段" : "换乘次数"}</span>
              <b>{plan.transfers} 次</b>
            </div>
          </div>
          <div className="final-compromise">
            <Sparkles size={19} />
            <h3>各有喜欢，也有共同的快乐。</h3>
            {plan.reasons.map((reason) => (
              <p key={reason}>{reason}</p>
            ))}
          </div>
          <button
            className="button primary full-width"
            disabled={exporting}
            onClick={download}
          >
            <Download size={16} />
            {exporting ? "正在生成图片…" : "导出行程长图"}
          </button>
          <button className="button secondary full-width" onClick={share}>
            <Link size={16} />
            复制只读分享链接
          </button>
          {onBack && !readOnly && (
            <button className="text-button final-back" onClick={onBack}>
              <ArrowLeft size={14} />
              再调整一下
            </button>
          )}
          {message && (
            <p className="share-message" role="status">
              {message}
            </p>
          )}
        </aside>
      </div>
      <div className="final-map">
        <RouteMap plan={plan} />
      </div>
      <p className="final-disclaimer">
        {live || readOnly
          ? "路线与费用为估算。出发前请核对营业时间、票价和天气。"
          : "演示行程。地点、价格与天气为预设数据。"}
      </p>
    </main>
  );
}
