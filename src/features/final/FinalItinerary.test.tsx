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
