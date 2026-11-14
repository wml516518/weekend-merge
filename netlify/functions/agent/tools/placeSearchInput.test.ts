import { describe, expect, it } from "vitest";
import { parsePlaceSearchInput } from "./placeSearchInput";

describe("place search time completion", () => {
  it("completes an end-of-day clock time as midnight on the next Shanghai date", () => {
    expect(parsePlaceSearchInput({ openBetween: { start: "21:00", end: "24:00" } }, "2026-12-31").openBetween).toEqual({
      start: "2026-12-31T21:00:00+08:00", end: "2027-01-01T00:00:00+08:00",
    });
  });

  it("preserves explicit offsets and does not mutate model arguments", () => {
    const input = { openBetween: { start: "2026-11-14T11:00:00+09:00", end: "2026-11-14T14:00:00+09:00" } };
    expect(parsePlaceSearchInput(input, "2026-11-14").openBetween).toEqual(input.openBetween);
    expect(input.openBetween.start).toBe("2026-11-14T11:00:00+09:00");
  });

  it("rejects midnight as a start and does not infer overnight travel from reversed clocks", () => {
    expect(() => parsePlaceSearchInput({ openBetween: { start: "24:00", end: "24:00" } }, "2026-11-14")).toThrow();
    expect(() => parsePlaceSearchInput({ openBetween: { start: "21:00", end: "01:00" } }, "2026-11-14")).toThrow();
  });
});
