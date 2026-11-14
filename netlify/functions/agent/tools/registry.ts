import { z } from "zod";

import { ItinerarySchema, type PlanRequest } from "../../../../src/contracts/agent";
import { calculateBudget } from "./budget";
import { CalculateBudgetInputSchema, EstimateRouteInputSchema, SearchPlacesInputSchema, type Place } from "./contracts";
import { searchPlaces, shanghaiPlaces } from "./places";
import { parsePlaceSearchInput } from "./placeSearchInput";
import { estimateRoute } from "./route";
import { validatePlan } from "./validator";
import { WeatherInputSchema, createWeatherTool, type WeatherInput, type WeatherOutput } from "./weather";

const productionWeather = createWeatherTool();

// Catalog, setup, preferences, and original locked plans are never tool arguments.
export const ValidatePlanInputSchema = z.object({
  plan: ItinerarySchema,
  walkingDistanceKm: z.number().finite().nonnegative().optional(),
});

export const toolInputSchemas = {
  get_weather: WeatherInputSchema,
  search_places: SearchPlacesInputSchema,
  estimate_route: EstimateRouteInputSchema,
  calculate_budget: CalculateBudgetInputSchema,
  validate_plan: ValidatePlanInputSchema,
};

// People's Square is the fixed central Shanghai planning reference for MVP weather.
export function weatherScopeForRequest(request: PlanRequest): WeatherInput {
  const { date, startTime, endTime } = request.setup;
  const endDate = endTime === "24:00"
    ? new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)
    : date;
  return WeatherInputSchema.parse({
    latitude: 31.2304,
    longitude: 121.4737,
    start: `${date}T${startTime}:00+08:00`,
    end: `${endDate}T${endTime === "24:00" ? "00:00" : endTime}:00+08:00`,
  });
}

type ToolOutputs = {
  get_weather: WeatherOutput;
  search_places: ReturnType<typeof searchPlaces>;
  estimate_route: ReturnType<typeof estimateRoute>;
  calculate_budget: ReturnType<typeof calculateBudget>;
  validate_plan: ReturnType<typeof validatePlan>;
};
export type AgentTools = {
  [K in keyof typeof toolInputSchemas]: (input: z.input<(typeof toolInputSchemas)[K]>) => ToolOutputs[K] | Promise<ToolOutputs[K]>;
};

export function createAgentTools(config: {
  request: PlanRequest;
  places?: readonly Place[];
  weather?: (input: WeatherInput) => Promise<WeatherOutput>;
  now?: () => Date;
}): AgentTools {
  const places = config.places ?? shanghaiPlaces;
  const weather = config.weather ?? (config.now ? createWeatherTool({ now: config.now }) : productionWeather);
  return {
    get_weather: (input) => {
      WeatherInputSchema.parse(input);
      return weather(weatherScopeForRequest(config.request));
    },
    search_places: (input) => searchPlaces(parsePlaceSearchInput(input, config.request.setup.date), places),
    estimate_route: (input) => estimateRoute(EstimateRouteInputSchema.parse(input)),
    calculate_budget: (input) => calculateBudget(CalculateBudgetInputSchema.parse(input)),
    validate_plan: (input) => validatePlan({
      ...ValidatePlanInputSchema.parse(input), setup: config.request.setup,
      preferences: config.request.preferences, places, lockedStopIds: [],
    }),
  };
}
