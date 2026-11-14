import { z } from "zod";
import {
  ItinerarySchema,
  PlanSetupSchema,
  type Itinerary,
  type PlanSetup,
} from "@/contracts/agent";
import { dateLabel } from "@/components/Ui";

const ShareSchema = z.object({
  version: z.literal(1),
  participantCount: z.number().int().min(2).max(6).default(2),
  plan: ItinerarySchema,
  setup: PlanSetupSchema.optional(),
});
export function encodeShare(
  plan: Itinerary,
  setup?: PlanSetup,
  participantCount = 2,
) {
  const payload = ShareSchema.parse({
    version: 1,
    plan,
    setup,
    participantCount,
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
) {
  const canvas = document.createElement("canvas");
  canvas.width = 1000;
  canvas.height = 650 + plan.stops.length * 190;
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
  plan.stops.forEach((stop, i) => {
    const y = 465 + i * 190;
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
  });
  ctx.fillStyle = "#87937c";
  ctx.font = "20px sans-serif";
  ctx.fillText(
    live
      ? "地点资料与费用为估算，请在出发前核实。"
      : "演示行程 · 地点、价格及天气为预设数据",
    65,
    canvas.height - 100,
  );
  ctx.fillText(
    "路线为示意估算，非实时导航；出发前请核实地点信息。",
    65,
    canvas.height - 60,
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
