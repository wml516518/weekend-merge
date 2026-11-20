import { createDemoRun } from "@/demo/demoRun";
import { getCandidates } from "@/features/workbench/events";
import { exportItineraryLayout, exportRoutePoints } from "./exportLayout";

const plan = getCandidates(createDemoRun({ runId: "export-layout" }))[0];

it("reserves a route-map section and a weather strip in the exported image", () => {
  const withWeather = exportItineraryLayout(plan, true);
  const withoutWeather = exportItineraryLayout(plan, false);

  expect(withWeather.map.height).toBeGreaterThanOrEqual(320);
  expect(withWeather.weather).toBeDefined();
  expect(withWeather.height).toBeGreaterThan(withoutWeather.height);
  expect(withWeather.height).toBeGreaterThan(650 + plan.stops.length * 190);
});

it("maps every stop inside the exported route-map bounds", () => {
  const box = { x: 65, y: 380, width: 870, height: 340 };
  const points = exportRoutePoints(plan.stops, box);

  expect(points).toHaveLength(plan.stops.length);
  for (const point of points) {
    expect(point.x).toBeGreaterThanOrEqual(box.x + 40);
    expect(point.x).toBeLessThanOrEqual(box.x + box.width - 40);
    expect(point.y).toBeGreaterThanOrEqual(box.y + 40);
    expect(point.y).toBeLessThanOrEqual(box.y + box.height - 40);
  }
});
