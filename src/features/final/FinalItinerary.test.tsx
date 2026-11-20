import { render, screen } from "@testing-library/react";
import { createDemoRun } from "@/demo/demoRun";
import { getCandidates } from "@/features/workbench/events";
import { FinalItinerary } from "./FinalItinerary";

it("shows the persisted weather summary on the final itinerary", () => {
  const plan = getCandidates(createDemoRun({ runId: "final-weather" }))[0];

  render(
    <FinalItinerary
      plan={plan}
      live
      participantCount={3}
      weather={{
        source: "qweather",
        reference: "上海",
        interval: {
          start: "2026-11-21T13:00:00+08:00",
          end: "2026-11-21T21:00:00+08:00",
        },
        hourlyCount: 8,
        temperatureMinC: 18,
        temperatureMaxC: 24,
        maxPrecipitationProbability: 35,
      }}
    />,
  );

  expect(screen.getByText("18–24°C")).toBeInTheDocument();
  expect(screen.getByText("最高降雨概率 35%")).toBeInTheDocument();
  expect(screen.getByText(/和风天气/)).toBeInTheDocument();
});

it("shows station-to-station transit and an itemized spending list", () => {
  const stops = [
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
  ];

  render(
    <FinalItinerary
      plan={{
        id: "transit-plan",
        title: "跨江看展",
        summary: "从徐汇滨江到浦东。",
        matchScore: 90,
        totalCost: 343.2,
        totalDistanceKm: 9.4,
        indoorRatio: 100,
        transfers: 1,
        stops,
        reasons: ["覆盖看展兴趣"],
      }}
      live
      participantCount={3}
    />,
  );

  expect(screen.getByText(/云锦路（11 号线）/)).toBeInTheDocument();
  expect(screen.getByText(/上海科技馆（2 号线）/)).toBeInTheDocument();
  expect(screen.getAllByText("西岸美术馆").length).toBeGreaterThan(0);
  expect(screen.getByText("费用明细")).toBeInTheDocument();
  expect(screen.getAllByText("¥300.00").length).toBeGreaterThan(0);
  expect(screen.getAllByText("¥12.00").length).toBeGreaterThan(0);
});
