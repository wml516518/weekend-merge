import { useState } from "react";
import {
  ArrowLeft,
  CheckCheck,
  CloudSun,
  Download,
  Droplets,
  Footprints,
  Leaf,
  Link,
  LockKeyhole,
  ReceiptText,
  Sparkles,
  TrainFront,
} from "lucide-react";
import type { Itinerary, PlanSetup } from "@/contracts/agent";
import type { WeatherEvidence } from "@/contracts/evidence";
import { dateLabel, Tag } from "@/components/Ui";
import { RouteMap } from "@/components/RouteMap";
import { describeTrip } from "@/domain/tripDetails";
import { encodeShare, exportItinerary } from "./share";
import {
  weatherInterval,
  weatherRain,
  weatherSource,
  weatherTemperature,
} from "./weatherPresentation";

export function FinalItinerary({
  plan,
  setup,
  onBack,
  readOnly = false,
  live = false,
  participantCount = 2,
  weather,
}: {
  plan: Itinerary;
  setup?: PlanSetup;
  onBack?: () => void;
  readOnly?: boolean;
  live?: boolean;
  participantCount?: number;
  weather?: WeatherEvidence;
}) {
  const [message, setMessage] = useState("");
  const [exporting, setExporting] = useState(false);
  async function download() {
    setExporting(true);
    try {
      await exportItinerary(plan, setup, live, participantCount, weather);
      setMessage("行程长图已生成。");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "导出失败，请重试。");
    } finally {
      setExporting(false);
    }
  }
  async function share() {
    try {
      const hash = encodeShare(plan, setup, participantCount, weather);
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
  const details = describeTrip(plan, participantCount);
  const budgetRemaining = setup ? setup.budget - plan.totalCost : 0;
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
                  {participantCount} 人 ¥{stop.cost.toFixed(2)} · 人均 ¥
                  {(stop.cost / participantCount).toFixed(2)}
                </span>
                {i < plan.stops.length - 1 && (
                  <div
                    className={`final-transit ${details.transportLegs[i].mode}`}
                  >
                    <span className="final-transit-icon">
                      {details.transportLegs[i].mode === "metro" ? (
                        <TrainFront size={16} />
                      ) : (
                        <Footprints size={16} />
                      )}
                    </span>
                    <div>
                      <small>
                        前往下一站 · 预计{" "}
                        {details.transportLegs[i].durationMinutes} 分钟
                      </small>
                      <h4>
                        {transportHeading(details.transportLegs[i])}
                      </h4>
                      <p>
                        {details.transportLegs[i].distanceKm.toFixed(2)} km ·{" "}
                        {transportCost(details.transportLegs[i], participantCount)}
                      </p>
                    </div>
                  </div>
                )}
              </div>
            </div>
          ))}
        </section>
        <aside>
          {weather && (
            <div className="final-weather">
              <div className="final-weather-heading">
                <span><CloudSun size={21} /></span>
                <div>
                  <small>周末天气参考</small>
                  <h2>{weatherTemperature(weather)}</h2>
                </div>
              </div>
              <p className="final-weather-rain">
                <Droplets size={14} />
                {weatherRain(weather)}
              </p>
              <div className="final-weather-meta">
                <span>{weatherInterval(weather)}</span>
                <span>{weatherSource(weather.source)}</span>
              </div>
            </div>
          )}
          <div className="final-summary">
            <h2>周末小账本</h2>
            <div>
              <span>站点费用合计</span>
              <b>¥{money(subtotal)}</b>
            </div>
            {details.transportSubtotal > 0 && (
              <div>
                <span>交通预留</span>
                <b>¥{money(details.transportSubtotal)}</b>
              </div>
            )}
            {details.buffer > 0 && (
              <div>
                <span>预算缓冲</span>
                <b>¥{money(details.buffer)}</b>
              </div>
            )}
            <div className="summary-total">
              <span>{participantCount} 人总计</span>
              <b>¥{money(plan.totalCost)}</b>
            </div>
            <div>
              <span>人均估算</span>
              <b>
                ¥{money(plan.totalCost / participantCount)}
              </b>
            </div>
            <p>
              {setup
                ? `预算余量 ¥${money(budgetRemaining)}`
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
              <b>{details.transportLegs.length} 次</b>
            </div>
          </div>
          <div className="final-costs">
            <h2>
              <ReceiptText size={17} />
              费用明细
            </h2>
            <div className="final-cost-lines">
              {details.costLines.map((line, index) => (
                <div
                  className={`final-cost-line ${line.kind}`}
                  key={`${line.kind}-${line.label}-${index}`}
                >
                  <div>
                    <span>{line.label}</span>
                    <small>
                      ¥{line.unitPrice.toFixed(2)}
                      {line.quantity > 1 ? ` × ${line.quantity} 人` : ""}
                    </small>
                  </div>
                  <b>¥{line.amount.toFixed(2)}</b>
                </div>
              ))}
            </div>
            <div className="final-cost-total">
              <span>{participantCount} 人合计</span>
              <b>¥{money(plan.totalCost)}</b>
            </div>
            <p>
              交通按每段地铁 4 元/人预留；邻近站点、线路和耗时均为估算，出发前请以地图应用为准。
            </p>
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

function stationLabel(station?: string, lines: string[] = []) {
  if (!station) return "附近站点待核实";
  return lines.length ? `${station}（${lines.join("、")}）` : station;
}

function transportHeading(leg: ReturnType<typeof describeTrip>["transportLegs"][number]) {
  if (leg.mode === "walking")
    return `步行 · ${leg.fromName} → ${leg.toName}`;
  return `地铁 · ${stationLabel(leg.fromStation, leg.fromLines)} → ${stationLabel(leg.toStation, leg.toLines)}`;
}

function transportCost(
  leg: ReturnType<typeof describeTrip>["transportLegs"][number],
  participantCount: number,
) {
  if (leg.mode === "walking") return "无需交通费";
  return `每人 ¥${leg.farePerPerson.toFixed(2)} · ${participantCount} 人共 ¥${leg.totalCost.toFixed(2)}`;
}

function money(value: number) {
  return value.toFixed(2);
}
