import { SearchPlacesInputSchema } from "./contracts";

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// Only complete unambiguous Shanghai wall-clock formats. Never guess natural
// language, silently drop a filter, or change an explicit timezone.
function completeDatetime(value: unknown, date: string, isEnd = false): unknown {
  if (typeof value !== "string") return value;
  if (isEnd && (value === "24:00" || value === "24:00:00")) {
    const nextDate = new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    return `${nextDate}T00:00:00+08:00`;
  }
  const clock = /^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.exec(value);
  if (clock) return `${date}T${value.length === 5 ? `${value}:00` : value}+08:00`;
  const local = /^(\d{4}-\d{2}-\d{2})[T ]((?:[01]\d|2[0-3]):[0-5]\d)(?::([0-5]\d))?$/.exec(value);
  if (local) return `${local[1]}T${local[2]}:${local[3] ?? "00"}+08:00`;
  return value;
}

export function parsePlaceSearchInput(input: unknown, date: string) {
  if (!record(input) || !record(input.openBetween)) return SearchPlacesInputSchema.parse(input);
  return SearchPlacesInputSchema.parse({
    ...input,
    openBetween: {
      ...input.openBetween,
      start: completeDatetime(input.openBetween.start, date),
      end: completeDatetime(input.openBetween.end, date, true),
    },
  });
}
