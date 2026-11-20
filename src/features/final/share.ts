import { z } from "zod";
import {
  ItinerarySchema,
  PlanSetupSchema,
  type Itinerary,
  type PlanSetup,
} from "@/contracts/agent";
import {
  WeatherEvidenceSchema,
  type WeatherEvidence,
} from "@/contracts/evidence";
import { dateLabel } from "@/components/Ui";
import { describeTrip, type CostLine } from "@/domain/tripDetails";
import { exportItineraryLayout, exportRoutePoints } from "./exportLayout";
import {
  weatherInterval,
  weatherRain,
  weatherSource,
  weatherTemperature,
} from "./weatherPresentation";

const ShareSchema = z.object({
  version: z.literal(1),
  participantCount: z.number().int().min(2).max(6).default(2),
  plan: ItinerarySchema,
  setup: PlanSetupSchema.optional(),
  weather: WeatherEvidenceSchema.optional(),
});
export function encodeShare(
  plan: Itinerary,
  setup?: PlanSetup,
  participantCount = 2,
  weather?: WeatherEvidence,
) {
  const payload = ShareSchema.parse({
    version: 1,
    plan,
    setup,
    participantCount,
    weather,
  });
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  if (bytes.byteLength >= 6000)
    throw new Error("快照超过 6 KB，请使用导出长图。");
  return (
    "#share=" + btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(""))
  );
}
export function decodeShare(hash: string) {
  if (!hash.startsWith("#share=")) return null;
  try {
    if (hash.length > 8100) throw new Error();
    const bytes = Uint8Array.from(atob(hash.slice(7)), (c) => c.charCodeAt(0));
    if (bytes.byteLength >= 6000) throw new Error();
    return ShareSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    throw new Error("分享快照无法读取，请索取新的链接。");
  }
}
export async function exportItinerary(
  plan: Itinerary,
  setup?: PlanSetup,
  live = false,
  participantCount = 2,
  weather?: WeatherEvidence,
) {
  const details = describeTrip(plan, participantCount);
  const layout = exportItineraryLayout(
    plan,
    !!weather,
    details.costLines.length,
  );
  const canvas = document.createElement("canvas");
  canvas.width = 1000;
  canvas.height = layout.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("浏览器暂不支持图片导出。");
  ctx.fillStyle = "#f8f8f3";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#354e44";
  ctx.fillRect(0, 0, 1000, 300);
  ctx.fillStyle = "#e5ecd7";
  ctx.font = "24px sans-serif";
  ctx.fillText("WEEKEND MERGE / 周末共识局", 65, 75);
  ctx.fillStyle = "#fff";
  ctx.font = "bold 48px sans-serif";
  ctx.fillText(plan.title, 65, 160, 870);
  ctx.font = "24px sans-serif";
  ctx.fillText(
    `${setup ? dateLabel(setup.date) : "周末演示"} · 上海 · ${participantCount} 人`,
    65,
    230,
  );
  ctx.fillStyle = "#354e44";
  ctx.font = "26px sans-serif";
  ctx.fillText(
    `预计 ¥${plan.totalCost} / ${participantCount} 人 · 人均 ¥${Math.round((plan.totalCost / participantCount) * 100) / 100} · 路程 ${plan.totalDistanceKm} km`,
    65,
    370,
  );
  drawExportMap(ctx, plan, layout.map);
  if (weather && layout.weather)
    drawWeatherStrip(ctx, weather, layout.weather);
  if (layout.costBreakdown)
    drawCostBreakdown(ctx, details.costLines, layout.costBreakdown);
  plan.stops.forEach((stop, i) => {
    const y = layout.itineraryTop + i * layout.stopHeight;
    ctx.fillStyle = "#e0e8d5";
    ctx.beginPath();
    ctx.arc(90, y, 26, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#354e44";
    ctx.font = "bold 24px sans-serif";
    ctx.fillText(String(i + 1), 82, y + 8);
    ctx.font = "22px sans-serif";
    ctx.fillText(
      `${stop.startTime} — ${stop.endTime}${stop.locked ? " · 已锁定" : ""}`,
      140,
      y,
    );
    ctx.font = "bold 31px sans-serif";
    ctx.fillText(stop.name, 140, y + 49, 790);
    ctx.fillStyle = "#818d73";
    ctx.font = "21px sans-serif";
    ctx.fillText(
      `${stop.area} · ${participantCount} 人 ¥${stop.cost} · ${stop.tags.join(" / ")}`,
      140,
      y + 91,
      790,
    );
    const transport = details.transportLegs[i];
    if (transport) {
      ctx.fillStyle = transport.mode === "metro" ? "#eef3ed" : "#f4f5ed";
      roundRect(ctx, 140, y + 117, 790, 66, 8);
      ctx.fill();
      ctx.fillStyle = transport.mode === "metro" ? "#536d62" : "#6f7f63";
      ctx.font = "bold 18px sans-serif";
      ctx.fillText(
        transport.mode === "metro"
          ? `地铁 · ${stationText(transport.fromStation, transport.fromLines)} → ${stationText(transport.toStation, transport.toLines)}`
          : `步行 · ${transport.fromName} → ${transport.toName}`,
        156,
        y + 145,
        758,
      );
      ctx.fillStyle = "#84917e";
      ctx.font = "15px sans-serif";
      ctx.fillText(
        `${transport.distanceKm.toFixed(2)} km · 约 ${transport.durationMinutes} 分钟 · ${
          transport.mode === "metro"
            ? `每人 ¥${transport.farePerPerson.toFixed(2)}，${participantCount} 人共 ¥${transport.totalCost.toFixed(2)}`
            : "无需交通费"
        }`,
        156,
        y + 170,
        758,
      );
    }
  });
  ctx.fillStyle = "#87937c";
  ctx.font = "20px sans-serif";
  ctx.fillText(
    live
      ? "地点资料与费用为估算，请在出发前核实。"
      : "演示行程 · 地点、价格及天气为预设数据",
    65,
    layout.footerTop,
  );
  ctx.fillText(
    "地铁站为地点邻近站，线路、耗时与 4 元/人票价均为估算；出发前请核实地点与交通信息。",
    65,
    layout.footerTop + 40,
  );
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/png"),
  );
  if (!blob) throw new Error("图片生成失败，请稍后重试。");
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.download = "Weekend-Merge-周末行程.png";
  link.href = url;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function drawCostBreakdown(
  ctx: CanvasRenderingContext2D,
  lines: CostLine[],
  box: { x: number; y: number; width: number; height: number },
) {
  ctx.save();
  ctx.fillStyle = "#fffefa";
  ctx.strokeStyle = "#dfe5d7";
  ctx.lineWidth = 1;
  roundRect(ctx, box.x, box.y, box.width, box.height, 12);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = "#354e44";
  ctx.font = "bold 23px sans-serif";
  ctx.fillText("费用明细 / WHERE THE MONEY GOES", box.x + 24, box.y + 38);
  lines.forEach((line, index) => {
    const y = box.y + 80 + index * 44;
    ctx.fillStyle = "#eef0e7";
    ctx.fillRect(box.x + 22, y + 39, box.width - 44, 1);
    ctx.fillStyle = line.kind === "transport" ? "#587068" : "#607358";
    ctx.font = "16px sans-serif";
    ctx.fillText(line.label, box.x + 24, y + 14, 600);
    ctx.fillStyle = "#98a18f";
    ctx.font = "13px sans-serif";
    ctx.fillText(
      line.quantity > 1
        ? `¥${line.unitPrice.toFixed(2)} × ${line.quantity} 人`
        : "一次性预留",
      box.x + 24,
      y + 33,
      500,
    );
    ctx.textAlign = "right";
    ctx.fillStyle = "#536d52";
    ctx.font = "bold 17px sans-serif";
    ctx.fillText(
      `¥${line.amount.toFixed(2)}`,
      box.x + box.width - 24,
      y + 22,
    );
    ctx.textAlign = "left";
  });
  ctx.fillStyle = "#9aa493";
  ctx.font = "14px sans-serif";
  ctx.fillText(
    "地铁票价按每段 4 元/人预留；邻近站点、线路与耗时均为估算。",
    box.x + 24,
    box.y + box.height - 18,
    box.width - 48,
  );
  ctx.restore();
}

function stationText(station?: string, lines: string[] = []) {
  if (!station) return "附近站点待核实";
  return lines.length ? `${station}（${lines.join("、")}）` : station;
}

function drawExportMap(
  ctx: CanvasRenderingContext2D,
  plan: Itinerary,
  box: { x: number; y: number; width: number; height: number },
) {
  ctx.save();
  ctx.fillStyle = "#efefe7";
  roundRect(ctx, box.x, box.y, box.width, box.height, 14);
  ctx.fill();
  ctx.clip();

  ctx.fillStyle = "#e3e5dc";
  for (let row = 0; row < 4; row++) {
    for (let column = 0; column < 8; column++) {
      const x = box.x + column * 118 + (row % 2) * 18;
      const y = box.y + row * 92 + 12;
      ctx.fillRect(x, y, 86, 55);
    }
  }
  ctx.fillStyle = "#c7dcdd";
  ctx.beginPath();
  ctx.moveTo(box.x + box.width - 70, box.y - 20);
  ctx.bezierCurveTo(
    box.x + box.width - 155,
    box.y + 90,
    box.x + box.width - 40,
    box.y + 170,
    box.x + box.width + 40,
    box.y + 240,
  );
  ctx.lineTo(box.x + box.width + 40, box.y + box.height);
  ctx.lineTo(box.x + box.width - 115, box.y + box.height);
  ctx.bezierCurveTo(
    box.x + box.width - 205,
    box.y + 205,
    box.x + box.width - 85,
    box.y + 115,
    box.x + box.width - 10,
    box.y - 20,
  );
  ctx.closePath();
  ctx.fill();

  ctx.strokeStyle = "#fffef9";
  ctx.lineWidth = 22;
  ctx.beginPath();
  ctx.moveTo(box.x - 30, box.y + 250);
  ctx.lineTo(box.x + box.width + 30, box.y + 55);
  ctx.moveTo(box.x + 155, box.y - 30);
  ctx.lineTo(box.x + 405, box.y + box.height + 30);
  ctx.stroke();
  ctx.strokeStyle = "#d8d9d0";
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();

  const points = exportRoutePoints(plan.stops, box);
  ctx.save();
  ctx.beginPath();
  points.forEach((point, index) =>
    index ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y),
  );
  ctx.strokeStyle = "#fffef9";
  ctx.lineWidth = 10;
  ctx.lineJoin = "round";
  ctx.stroke();
  ctx.strokeStyle = "#536d52";
  ctx.lineWidth = 4;
  ctx.setLineDash([9, 7]);
  ctx.stroke();
  ctx.setLineDash([]);

  points.forEach((point, index) => {
    ctx.fillStyle = "#fffef9";
    ctx.beginPath();
    ctx.arc(point.x, point.y, 21, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#687e5d";
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.fillStyle = "#354e44";
    ctx.font = "bold 17px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(String(index + 1), point.x, point.y + 6);
    ctx.textAlign = "left";

    const name = plan.stops[index].name;
    ctx.font = "15px sans-serif";
    const labelWidth = Math.min(190, Math.max(78, ctx.measureText(name).width + 24));
    const labelX = Math.min(point.x + 24, box.x + box.width - labelWidth - 8);
    const labelY = Math.max(box.y + 8, point.y - 19);
    ctx.fillStyle = "rgba(255, 254, 249, .96)";
    roundRect(ctx, labelX, labelY, labelWidth, 32, 6);
    ctx.fill();
    ctx.fillStyle = "#465547";
    ctx.fillText(
      name.length > 11 ? `${name.slice(0, 10)}…` : name,
      labelX + 10,
      labelY + 21,
      labelWidth - 18,
    );
  });
  ctx.fillStyle = "#354e44";
  ctx.font = "bold 18px sans-serif";
  ctx.fillText("ROUTE / 周末路线", box.x + 22, box.y + 31);
  ctx.fillStyle = "#7f8b7a";
  ctx.font = "14px sans-serif";
  ctx.fillText("示意地图 · 非实时导航", box.x + 22, box.y + 53);
  ctx.restore();
}

function drawWeatherStrip(
  ctx: CanvasRenderingContext2D,
  weather: WeatherEvidence,
  box: { x: number; y: number; width: number; height: number },
) {
  ctx.save();
  ctx.fillStyle = "#edf3ea";
  roundRect(ctx, box.x, box.y, box.width, box.height, 12);
  ctx.fill();
  ctx.fillStyle = "#354e44";
  ctx.font = "bold 22px sans-serif";
  ctx.fillText(weatherTemperature(weather), box.x + 24, box.y + 36);
  ctx.fillStyle = "#60745d";
  ctx.font = "16px sans-serif";
  ctx.fillText(weatherRain(weather), box.x + 24, box.y + 65);
  ctx.fillStyle = "#7f8b76";
  ctx.font = "15px sans-serif";
  ctx.textAlign = "right";
  ctx.fillText(
    `${weatherSource(weather.source)} · ${weatherInterval(weather)}`,
    box.x + box.width - 24,
    box.y + 43,
  );
  ctx.textAlign = "left";
  ctx.restore();
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + width, y, x + width, y + height, radius);
  ctx.arcTo(x + width, y + height, x, y + height, radius);
  ctx.arcTo(x, y + height, x, y, radius);
  ctx.arcTo(x, y, x + width, y, radius);
  ctx.closePath();
}
