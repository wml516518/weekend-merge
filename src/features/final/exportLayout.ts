import type { Itinerary } from "@/contracts/agent";

export interface ExportBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function exportItineraryLayout(
  plan: Itinerary,
  hasWeather: boolean,
  detailLineCount = 0,
) {
  const map: ExportBox = { x: 65, y: 390, width: 870, height: 340 };
  const weather: ExportBox | undefined = hasWeather
    ? { x: 65, y: 750, width: 870, height: 96 }
    : undefined;
  const detailCount = Math.max(0, detailLineCount);
  const costBreakdown: ExportBox | undefined =
    detailCount > 0
      ? {
          x: 65,
          y: weather ? 874 : 762,
          width: 870,
          height: 120 + detailCount * 44,
        }
      : undefined;
  const itineraryTop = costBreakdown
    ? costBreakdown.y + costBreakdown.height + 42
    : weather
      ? 910
      : 800;
  const stopHeight = detailCount > 0 ? 232 : 190;
  const footerHeight = 150;
  return {
    map,
    weather,
    costBreakdown,
    itineraryTop,
    stopHeight,
    footerTop: itineraryTop + plan.stops.length * stopHeight + 30,
    height: itineraryTop + plan.stops.length * stopHeight + footerHeight,
  };
}

export function exportRoutePoints(
  stops: Itinerary["stops"],
  box: ExportBox,
) {
  const horizontalPadding = 48;
  const topPadding = 82;
  const bottomPadding = 48;
  const inner = {
    x: box.x + horizontalPadding,
    y: box.y + topPadding,
    width: box.width - horizontalPadding * 2,
    height: box.height - topPadding - bottomPadding,
  };
  const longitudes = stops.map((stop) => stop.longitude);
  const latitudes = stops.map((stop) => stop.latitude);
  const minLongitude = Math.min(...longitudes);
  const maxLongitude = Math.max(...longitudes);
  const minLatitude = Math.min(...latitudes);
  const maxLatitude = Math.max(...latitudes);
  return stops.map((stop) => ({
    x:
      maxLongitude === minLongitude
        ? inner.x + inner.width / 2
        : inner.x +
          ((stop.longitude - minLongitude) / (maxLongitude - minLongitude)) *
            inner.width,
    y:
      maxLatitude === minLatitude
        ? inner.y + inner.height / 2
        : inner.y +
          ((maxLatitude - stop.latitude) / (maxLatitude - minLatitude)) *
            inner.height,
  }));
}
