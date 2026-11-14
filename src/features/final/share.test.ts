import { createDemoRun } from "@/demo/demoRun";
import { getCandidates } from "@/features/workbench/events";
import { decodeShare, encodeShare } from "./share";
describe("read-only share snapshot", () => {
  const plan = getCandidates(createDemoRun({ runId: "share-test" }))[0];
  it("round-trips the itinerary and drops fields outside the shared contract", () => {
    const hash = encodeShare({
      ...plan,
      preferences: { wish: "PRIVATE" },
    } as typeof plan);
    expect(decodeShare(hash)?.plan).toEqual(plan);
    expect(JSON.stringify(decodeShare(hash))).not.toContain("PRIVATE");
  });
  it("rejects corrupted, invalid and oversized snapshots", () => {
    expect(() => decodeShare("#share=not-json")).toThrow();
    expect(() =>
      decodeShare("#share=" + btoa('{"version":1,"plan":{}}')),
    ).toThrow();
    expect(() => encodeShare({ ...plan, summary: "长".repeat(6000) })).toThrow(
      "6 KB",
    );
    expect(decodeShare("")).toBe(null);
  });
  it("retains actual headcount for a group and defaults legacy snapshots to two", () => {
    expect(decodeShare(encodeShare(plan, undefined, 6))?.participantCount).toBe(
      6,
    );
    const old =
      "#share=" +
      btoa(
        Array.from(
          new TextEncoder().encode(JSON.stringify({ version: 1, plan })),
          (b) => String.fromCharCode(b),
        ).join(""),
      );
    expect(decodeShare(old)?.participantCount).toBe(2);
  });
});
