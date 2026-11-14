import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { usePlanningStore } from "@/state/usePlanningStore";
import { createDemoRun } from "@/demo/demoRun";
import { getCandidates } from "@/features/workbench/events";
import { encodeShare } from "@/features/final/share";
import { App } from "./App";

describe("App entry", () => {
  beforeEach(() => {
    history.replaceState(null, "", "/");
    localStorage.clear();
    usePlanningStore.getState().reset();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ groups: [] })),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    history.replaceState(null, "", "/");
  });
  it("opens live groups even with an old persisted wizard/workbench session", async () => {
    usePlanningStore.getState().openWorkbench("live", "old-legacy-session");
    render(<App />);
    expect(
      await screen.findByRole("button", { name: "创建并邀请" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "共同兴趣优先" }),
    ).not.toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith(
      "/api/groups",
      expect.objectContaining({ credentials: "same-origin" }),
    );
  });
  it("opens the explicit fixture demo without invoking old live planning", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("link", { name: "体验演示" }));
    await screen.findByRole(
      "heading",
      { name: "雨天艺术散步" },
      { timeout: 4000 },
    );
    expect(usePlanningStore.getState().mode).toBe("demo");
    expect(
      vi.mocked(fetch).mock.calls.every(([path]) => path === "/api/groups"),
    ).toBe(true);
  });
  it("still opens read-only share snapshots and honors group headcount", async () => {
    const plan = getCandidates(createDemoRun({ runId: "app-test" }))[0];
    history.replaceState(null, "", encodeShare(plan, undefined, 6));
    render(<App />);
    expect(await screen.findByText("只读分享快照")).toBeInTheDocument();
    expect(screen.getByText("6 人总计")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "创建并邀请" }),
    ).not.toBeInTheDocument();
  });
});
