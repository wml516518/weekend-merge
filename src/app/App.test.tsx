import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { usePlanningStore } from "@/state/usePlanningStore";
import fixture from "../../tests/fixtures/plan-request.demo.json";
import { PlanRequestSchema, type ReplanRequest } from "@/contracts/agent";
import { createPlanHandler } from "../../netlify/functions/plan";
import { createReplanHandler } from "../../netlify/functions/replan";
import { App } from "./App";

describe("App", () => {
  beforeEach(() => {
    localStorage.clear();
    usePlanningStore.getState().reset();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("moves from plan setup to A's private preference step", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.type(screen.getByLabelText("日期"), "2026-11-14");
    await user.selectOptions(screen.getByLabelText("出发区域"), "静安寺");
    await user.click(screen.getByRole("button", { name: "填写 A 的偏好" }));

    expect(screen.getByRole("heading", { name: "A 的周末偏好" })).toBeInTheDocument();
  });

  it("plans from both inputs and only commits a successful locked replan", async () => {
    const user = userEvent.setup();
    const input = PlanRequestSchema.parse(fixture);
    const now = () => new Date("2026-11-13T02:00:00Z");
    const plan = createPlanHandler({ now, env: {}, limiter: { allow: () => true } });
    const replan = createReplanHandler({ now });
    let rejectFirst = true;
    const api = vi.fn(async (url: string, options: RequestInit) => {
      const request = new Request(new URL(url, "http://localhost"), options);
      if (url.endsWith("/plan")) return plan(request);
      if (rejectFirst) {
        rejectFirst = false;
        return Response.json({ error: { code: "NO_VALID_REPLAN" } }, { status: 422 });
      }
      return replan(request);
    });
    vi.stubGlobal("fetch", api);
    const store = usePlanningStore.getState();
    store.saveSetup(input.setup);
    store.savePreferences("a", input.preferences.a);
    store.handoffToB();
    store.savePreferences("b", input.preferences.b);
    const view = render(<App />);
    await user.click(screen.getByRole("button", { name: "开始规划" }));
    expect(await screen.findByRole("heading", { name: "共同兴趣优先" })).toBeInTheDocument();
    expect(screen.getByText("当前使用降级结果")).toBeInTheDocument();
    expect(api.mock.calls[0][0]).toBe("/.netlify/functions/plan");
    const sent = JSON.parse(api.mock.calls[0][1].body as string);
    expect(sent).toMatchObject({ mode: "live", setup: input.setup, preferences: input.preferences });

    const original = usePlanningStore.getState().liveEvents.find((event) => event.type === "plan.proposed")!.plan;
    const [locked, rejected] = original.stops;
    await user.click(screen.getByRole("button", { name: `锁定 ${locked.name}` }));
    await user.click(screen.getAllByRole("button", { name: `查看第 2 站 ${rejected.name}` })[0]);
    await user.click(screen.getByRole("button", { name: "换个地方" }));
    const dialog = within(screen.getByRole("dialog"));
    await user.click(dialog.getByRole("button", { name: "不感兴趣" }));
    await user.click(dialog.getByRole("button", { name: "找一个替代方案" }));
    expect(await dialog.findByRole("alert")).toHaveTextContent("原行程已保留");
    expect(usePlanningStore.getState().replanCount).toBe(0);
    await user.click(dialog.getByRole("button", { name: "找一个替代方案" }));
    await screen.findByText("已调整 1 / 2 次");
    const request = JSON.parse(api.mock.calls[2][1].body as string) as ReplanRequest;
    expect(api.mock.calls[2][0]).toBe("/.netlify/functions/replan");
    expect(request).toMatchObject({
      sessionId: sent.sessionId, plan: original, replanCount: 0,
      rejectedStopId: rejected.id, lockedStopIds: [locked.id], reasonCode: "CHANGE_PLACE",
    });
    const updated = usePlanningStore.getState().revisedPlans[original.id];
    expect(updated.stops[0]).toEqual(locked);
    expect(updated.stops[1].placeId).not.toBe(rejected.placeId);
    expect(screen.getByText(/已替换否决地点/)).toBeInTheDocument();
    view.unmount();
    await usePlanningStore.persist.rehydrate();
    render(<App />);
    expect(screen.getByRole("heading", { name: updated.title })).toBeInTheDocument();
    expect(screen.getByText("已调整 1 / 2 次")).toBeInTheDocument();
    expect(api).toHaveBeenCalledTimes(3);
  });
});
