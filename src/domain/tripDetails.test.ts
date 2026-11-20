import { describe, expect, it } from "vitest";
import type { Itinerary } from "@/contracts/agent";
import { createDemoRun } from "@/demo/demoRun";
import { getCandidates } from "@/features/workbench/events";
import { describeTrip } from "./tripDetails";

const stops: Itinerary["stops"] = [
  {
    id: "museum",
    placeId: "west-bund-museum",
    name: "西岸美术馆",
    area: "徐汇滨江",
    startTime: "13:00",
    endTime: "15:00",
    cost: 300,
    latitude: 31.1744,
    longitude: 121.4605,
    tags: ["展览"],
    locked: false,
  },
  {
    id: "museum-east",
    placeId: "shanghai-museum-east",
    name: "上海博物馆东馆",
    area: "世纪大道",
    startTime: "16:00",
    endTime: "18:00",
    cost: 0,
    latitude: 31.2248,
    longitude: 121.5415,
    tags: ["展览"],
    locked: false,
  },
  {
    id: "coffee",
    placeId: "starbucks-reserve-roastery",
    name: "星巴克臻选上海烘焙工坊",
    area: "南京西路",
    startTime: "18:40",
    endTime: "19:40",
    cost: 330,
    latitude: 31.2284,
    longitude: 121.4589,
    tags: ["咖啡"],
    locked: false,
  },
];

const plan: Itinerary = {
  id: "detail-plan",
  title: "跨江看展与咖啡",
  summary: "从徐汇滨江去浦东看展，再喝咖啡。",
  matchScore: 90,
  totalCost: 719.4,
  totalDistanceKm: 15.2,
  indoorRatio: 100,
  transfers: 2,
  stops,
  reasons: ["覆盖看展和咖啡"],
};

describe("trip cost and transit details", () => {
  it("maps metro legs to the nearest stations and charges the shared transit estimate", () => {
    const details = describeTrip(plan, 3);

    expect(details.transportLegs[0]).toMatchObject({
      mode: "metro",
      fromStation: "云锦路",
      fromLines: ["11 号线"],
      toStation: "上海科技馆",
      toLines: ["2 号线"],
      farePerPerson: 4,
      totalCost: 12,
    });
    expect(details.transportLegs[1]).toMatchObject({
      mode: "metro",
      fromStation: "上海科技馆",
      fromLines: ["2 号线"],
      toStation: "南京西路",
      toLines: ["2 号线", "12 号线", "13 号线"],
      totalCost: 12,
    });
  });

  it("lists venue, transport and buffer amounts with per-person units", () => {
    const details = describeTrip(plan, 3);

    expect(details.costLines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "venue",
          label: "西岸美术馆",
          unitPrice: 100,
          quantity: 3,
          amount: 300,
        }),
        expect.objectContaining({
          kind: "transport",
          label: "地铁 · 云锦路 → 上海科技馆",
          unitPrice: 4,
          quantity: 3,
          amount: 12,
        }),
        expect.objectContaining({
          kind: "venue",
          label: "星巴克臻选上海烘焙工坊",
          amount: 330,
        }),
      ]),
    );
    expect(details.venueSubtotal).toBe(630);
    expect(details.transportSubtotal).toBe(24);
    expect(details.buffer).toBe(65.4);
  });

  it("uses walking for nearby stops without inventing a metro fare", () => {
    const details = describeTrip(
      {
        ...plan,
        totalCost: 400,
        stops: [
          stops[0],
          {
            ...stops[0],
            id: "nearby",
            placeId: "manner-xuhui-riverside",
            name: "Manner Coffee 徐汇滨江店",
            startTime: "15:30",
            endTime: "16:20",
            cost: 100,
            latitude: 31.1719,
            longitude: 121.4637,
          },
        ],
      },
      2,
    );

    expect(details.transportLegs[0]).toMatchObject({
      mode: "walking",
      farePerPerson: 0,
      totalCost: 0,
    });
    expect(details.costLines.some((line) => line.kind === "transport")).toBe(
      false,
    );
  });

  it("keeps every fixed demo plan reconciled to its displayed total", () => {
    for (const demo of getCandidates(createDemoRun({ runId: "cost-check" }))) {
      const details = describeTrip(demo, 2);
      const lineTotal = details.costLines.reduce(
        (sum, line) => sum + line.amount,
        0,
      );
      expect(lineTotal).toBeCloseTo(demo.totalCost, 2);
    }
  });
});
