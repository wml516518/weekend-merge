import type { WeatherEvidence } from "@/contracts/evidence";

export function weatherTemperature(weather: WeatherEvidence) {
  if (weather.temperatureMinC === null || weather.temperatureMaxC === null)
    return "天气温度暂缺";
  return `${weather.temperatureMinC}–${weather.temperatureMaxC}°C`;
}

export function weatherRain(weather: WeatherEvidence) {
  return weather.maxPrecipitationProbability === null
    ? "降雨概率暂无数据"
    : `最高降雨概率 ${weather.maxPrecipitationProbability}%`;
}

export function weatherSource(source: WeatherEvidence["source"]) {
  return source === "qweather" ? "和风天气" : "Open-Meteo";
}

export function weatherInterval(weather: WeatherEvidence) {
  const format = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return `${format.format(new Date(weather.interval.start))}–${format.format(new Date(weather.interval.end))}`;
}
