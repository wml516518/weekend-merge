import type { Itinerary } from "@/contracts/agent";

export const TRANSIT_FARE_PER_PERSON = 4;
const WALKING_THRESHOLD_KM = 1.2;
const WALKING_SPEED_KMH = 4.5;
const TRANSIT_SPEED_KMH = 18;
const TRANSIT_BUFFER_MINUTES = 8;

type MetroAccess = {
  station: string;
  lines: string[];
};

const metroByPlaceId: Record<string, MetroAccess> = {
  "west-bund-museum": { station: "云锦路", lines: ["11 号线"] },
  "long-museum-west-bund": {
    station: "龙华中路",
    lines: ["7 号线", "12 号线"],
  },
  "manner-xuhui-riverside": { station: "云锦路", lines: ["11 号线"] },
  "shanghai-museum-east": { station: "上海科技馆", lines: ["2 号线"] },
  "century-park": { station: "世纪公园", lines: ["2 号线"] },
  "shanghai-book-city": { station: "南京东路", lines: ["2 号线", "10 号线"] },
  "the-bund-promenade": { station: "南京东路", lines: ["2 号线", "10 号线"] },
  "jic-books-pujiang": { station: "提篮桥", lines: ["12 号线"] },
  "north-bund-aviation-center": {
    station: "国际客运中心",
    lines: ["12 号线"],
  },
  "starbucks-reserve-roastery": {
    station: "南京西路",
    lines: ["2 号线", "12 号线", "13 号线"],
  },
  "shanghai-classical-restaurant": {
    station: "豫园",
    lines: ["10 号线", "14 号线"],
  },
  "lu-bo-lang-yuyuan": { station: "豫园", lines: ["10 号线", "14 号线"] },
  "fuxing-park": { station: "新天地", lines: ["10 号线", "13 号线"] },
  // The fixed portfolio demo uses its own stable IDs.
  "hengshan-cafe": { station: "衡山路", lines: ["1 号线"] },
  "wukang-dinner": { station: "上海图书馆", lines: ["10 号线"] },
  "power-station-art": { station: "西藏南路", lines: ["4 号线", "8 号线"] },
  "south-bund-cafe": { station: "小南门", lines: ["9 号线"] },
  "north-bund-view": { station: "国际客运中心", lines: ["12 号线"] },
  "sinan-books": { station: "新天地", lines: ["10 号线", "13 号线"] },
  "fuxing-cafe": { station: "新天地", lines: ["10 号线", "13 号线"] },
  "sinan-dinner": { station: "新天地", lines: ["10 号线", "13 号线"] },
};

export type TransportDetail = {
  fromStopId: string;
  toStopId: string;
  fromName: string;
  toName: string;
  mode: "walking" | "metro";
  distanceKm: number;
  durationMinutes: number;
  fromStation?: string;
  fromLines: string[];
  toStation?: string;
  toLines: string[];
  farePerPerson: number;
  totalCost: number;
};

export type CostLine = {
  kind: "venue" | "transport" | "buffer";
  label: string;
  unitPrice: number;
  quantity: number;
  amount: number;
};

export type TripDetails = {
  transportLegs: TransportDetail[];
  costLines: CostLine[];
  venueSubtotal: number;
  transportSubtotal: number;
  buffer: number;
};

function radians(degrees: number) {
  return (degrees * Math.PI) / 180;
}

function distanceKm(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
) {
  const latitudeDelta = radians(b.latitude - a.latitude);
  const longitudeDelta = radians(b.longitude - a.longitude);
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(radians(a.latitude)) *
      Math.cos(radians(b.latitude)) *
      Math.sin(longitudeDelta / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(haversine)));
}

function round(value: number, digits = 2) {
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

function unknownStation(label: string): MetroAccess {
  return { station: `${label}附近地铁站（待核实）`, lines: [] };
}

export function describeTrip(
  plan: Itinerary,
  participantCount: number,
): TripDetails {
  const transportLegs = plan.stops.slice(1).map<TransportDetail>(
    (stop, index) => {
      const previous = plan.stops[index];
      const rawDistance = distanceKm(previous, stop);
      const mode = rawDistance <= WALKING_THRESHOLD_KM ? "walking" : "metro";
      const durationMinutes =
        mode === "walking"
          ? Math.ceil((rawDistance / WALKING_SPEED_KMH) * 60)
          : Math.ceil(
              (rawDistance / TRANSIT_SPEED_KMH) * 60 + TRANSIT_BUFFER_MINUTES,
            );
      if (mode === "walking")
        return {
          fromStopId: previous.id,
          toStopId: stop.id,
          fromName: previous.name,
          toName: stop.name,
          mode,
          distanceKm: round(rawDistance),
          durationMinutes,
          fromLines: [],
          toLines: [],
          farePerPerson: 0,
          totalCost: 0,
        };
      const from = metroByPlaceId[previous.placeId] ?? unknownStation(previous.area);
      const to = metroByPlaceId[stop.placeId] ?? unknownStation(stop.area);
      return {
        fromStopId: previous.id,
        toStopId: stop.id,
        fromName: previous.name,
        toName: stop.name,
        mode,
        distanceKm: round(rawDistance),
        durationMinutes,
        fromStation: from.station,
        fromLines: from.lines,
        toStation: to.station,
        toLines: to.lines,
        farePerPerson: TRANSIT_FARE_PER_PERSON,
        totalCost: round(TRANSIT_FARE_PER_PERSON * participantCount),
      };
    },
  );
  const venueSubtotal = round(
    plan.stops.reduce((sum, stop) => sum + stop.cost, 0),
  );
  const transportSubtotal = round(
    transportLegs.reduce((sum, leg) => sum + leg.totalCost, 0),
  );
  const buffer = round(
    Math.max(0, plan.totalCost - venueSubtotal - transportSubtotal),
  );
  const costLines: CostLine[] = plan.stops.map((stop) => ({
    kind: "venue",
    label: stop.name,
    unitPrice: round(stop.cost / participantCount),
    quantity: participantCount,
    amount: round(stop.cost),
  }));
  for (const leg of transportLegs) {
    if (leg.mode !== "metro") continue;
    costLines.push({
      kind: "transport",
      label: `地铁 · ${leg.fromStation} → ${leg.toStation}`,
      unitPrice: leg.farePerPerson,
      quantity: participantCount,
      amount: leg.totalCost,
    });
  }
  if (buffer > 0)
    costLines.push({
      kind: "buffer",
      label: "预算缓冲（约 10%）",
      unitPrice: buffer,
      quantity: 1,
      amount: buffer,
    });
  return {
    transportLegs,
    costLines,
    venueSubtotal,
    transportSubtotal,
    buffer,
  };
}
