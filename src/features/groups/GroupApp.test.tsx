import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import type { GroupView } from "@/contracts/groups";
import { createDemoRun } from "@/demo/demoRun";
import { getCandidates } from "@/features/workbench/events";
import { GroupApp } from "./GroupApp";

const preferences = {
  interests: ["咖啡"] as const,
  pace: "轻松",
  walkingLimitKm: 3,
  indoorPreference: "室内优先",
  foodTags: [],
  budgetStyle: "平衡",
  avoid: [],
  wish: "我的服务器草稿",
};
function group(overrides: Partial<GroupView> = {}): GroupView {
  return {
    id: "g1",
    name: "梧桐周末",
    targetCount: 2,
    setup: {
      city: "上海",
      date: "2026-11-15",
      startTime: "13:00",
      endTime: "20:00",
      budget: 300,
      startingArea: "徐汇",
    },
    revision: 1,
    stateVersion: 0,
    state: "collecting",
    createdAt: Date.now(),
    expiresAt: Date.now() + 86400000,
    inviteExpiresAt: Date.now() + 86400000,
    canManage: true,
    members: [{ id: "m1", nickname: "小林", owner: true, submitted: false }],
    myMembers: [
      { id: "m1", nickname: "小林", owner: true, submitted: false, version: 0 },
    ],
    candidates: [],
    lockedStopIds: [],
    replanCount: 0,
    ...overrides,
  };
}
let current: GroupView;
let groups: GroupView[];
let writes: { path: string; body: Record<string, unknown> }[];
let rejectSave = false;
beforeEach(() => {
  history.replaceState(null, "", "/");
  localStorage.clear();
  current = group();
  groups = [current];
  writes = [];
  rejectSave = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, options: RequestInit = {}) => {
      if (options.credentials !== "same-origin")
        throw new Error("Missing same-origin credentials");
      if (!options.method || options.method === "GET")
        return Response.json(path === "/api/groups" ? { groups } : current);
      const body = JSON.parse(String(options.body));
      writes.push({ path, body });
      if (path === "/api/groups/recover")
        return body.token === "BAD"
          ? Response.json(
              { error: { code: "NOT_FOUND", message: "恢复链接已失效。" } },
              { status: 404 },
            )
          : Response.json(current);
      if (path === "/api/groups") {
        current = group({
          name: body.name,
          targetCount: body.targetCount,
          setup: body.setup,
        });
        return Response.json({
          group: current,
          memberId: "m1",
          inviteToken: "INVITE",
          memberRecoveryToken: "PERSONAL",
          ownerRecoveryToken: "OWNER",
        });
      }
      if (path === "/api/groups/join") {
        const member = {
          id: "m2",
          nickname: body.nickname,
          owner: false,
          submitted: false,
          version: 0,
        };
        current = group({
          canManage: body.handoff ? current.canManage : false,
          members: [...current.members, member],
          myMembers: body.handoff ? [...current.myMembers, member] : [member],
        });
        return Response.json({
          group: current,
          memberId: "m2",
          memberRecoveryToken: "SECOND",
        });
      }
      if (path.endsWith("/preferences")) {
        if (rejectSave)
          return Response.json(
            {
              error: {
                code: "VERSION_CONFLICT",
                message: "内容已更新，请同步。",
              },
            },
            { status: 409 },
          );
        const mine = current.myMembers.find((m) => m.id === body.memberId)!;
        current = {
          ...current,
          state:
            body.submit && current.members.length === current.targetCount
              ? "queued"
              : "collecting",
          myMembers: [
            {
              ...mine,
              preferences: body.preferences,
              submitted: body.submit,
              version: mine.version + 1,
            },
          ],
          members: current.members.map((m) =>
            m.id === body.memberId ? { ...m, submitted: body.submit } : m,
          ),
        };
      }
      if (path.endsWith("/select"))
        current = {
          ...current,
          selectedPlanId: body.planId,
          lockedStopIds: body.lockedStopIds,
          stateVersion: current.stateVersion + 1,
        };
      if (path.endsWith("/finalize"))
        current = { ...current, state: "finalized", finalPlanId: body.planId };
      if (path.endsWith("/invite"))
        return Response.json({ group: current, inviteToken: "ROTATED" });
      if (path.endsWith("/remove"))
        current = {
          ...current,
          members: current.members.filter(
            (m) => !path.includes(`/members/${m.id}/`),
          ),
          myMembers: current.myMembers.filter(
            (m) => !path.includes(`/members/${m.id}/`),
          ),
        };
      if (path.endsWith("/round"))
        current = {
          ...current,
          revision: current.revision + 1,
          state: "collecting",
          setup: body.setup,
          targetCount: body.targetCount,
          candidates: [],
          selectedPlanId: undefined,
          lockedStopIds: [],
          replanCount: 0,
          myMembers: current.myMembers.map((m) => ({
            ...m,
            version: m.version + 1,
            submitted: false,
          })),
          members: current.members.map((m) => ({ ...m, submitted: false })),
        };
      return Response.json(current);
    }),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  history.replaceState(null, "", "/");
});

it("scales total budget with target seats and keeps a per-person amount", async () => {
  groups = [];
  const user = userEvent.setup();
  render(<GroupApp />);
  expect(await screen.findByLabelText("总预算（元）")).toHaveValue(300);
  await user.selectOptions(screen.getByLabelText("参与人数"), "6");
  expect(screen.getByLabelText("总预算（元）")).toHaveValue(900);
  expect(screen.getByLabelText("总预算（元）")).toHaveAttribute("max", "12000");
  expect(screen.getByText("人均 ¥150")).toBeInTheDocument();
  await user.type(screen.getByLabelText("计划名称"), "六人周末");
  await user.type(screen.getByLabelText("我的昵称"), "小林");
  await user.click(screen.getByRole("button", { name: "创建并邀请" }));
  expect(
    await screen.findByRole("heading", { name: "六人周末" }),
  ).toBeInTheDocument();
  expect(screen.getAllByRole("listitem", { name: /席位/ })).toHaveLength(6);
  expect(
    (screen.getByLabelText("我的恢复链接") as HTMLInputElement).value,
  ).toContain("#recover=PERSONAL");
  expect(
    (screen.getByLabelText("管理恢复链接") as HTMLInputElement).value,
  ).toContain("#recover=OWNER");
  expect(JSON.stringify(localStorage)).not.toContain("PERSONAL");
});

it("exchanges an invitation fragment only on join and gives a blank independent form", async () => {
  history.replaceState(null, "", "/#invite=SECRET");
  const user = userEvent.setup();
  render(<GroupApp />);
  expect(location.hash).toBe("");
  await user.type(screen.getByLabelText("加入昵称"), "小周");
  await user.click(screen.getByRole("button", { name: "加入计划" }));
  expect(
    await screen.findByRole("heading", { name: "梧桐周末" }),
  ).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "填写我的偏好" }));
  expect(screen.getByLabelText("咖啡")).not.toBeChecked();
  expect(screen.getByLabelText("一句话愿望（可选）")).toHaveValue("");
  expect(writes[0]).toEqual({
    path: "/api/groups/join",
    body: { token: "SECRET", nickname: "小周" },
  });
});

it("keeps a newly issued recovery link across refreshes and shows recovery failures", async () => {
  history.replaceState(null, "", "/#recover=BAD");
  render(<GroupApp />);
  expect(location.hash).toBe("");
  expect(await screen.findByRole("alert")).toHaveTextContent("恢复链接已失效");
});

it("submits only my member and waits until the final participant queues planning", async () => {
  const user = userEvent.setup();
  render(<GroupApp />);
  await user.click(
    await screen.findByRole("button", { name: "打开 梧桐周末" }),
  );
  await user.click(screen.getByRole("button", { name: "填写我的偏好" }));
  await user.click(screen.getByLabelText("咖啡"));
  await user.click(screen.getByRole("button", { name: "提交我的偏好" }));
  expect(await screen.findByText("等待其他成员提交")).toBeInTheDocument();
  expect(writes[0].body).toMatchObject({
    memberId: "m1",
    version: 0,
    submit: true,
    preferences: { interests: ["咖啡"], wish: "" },
  });
  expect(writes[0].body).not.toHaveProperty("participants");
});

it("shows queued status after the final submission and disallows further editing", async () => {
  current = group({
    members: [
      { id: "m1", nickname: "小林", owner: true, submitted: false },
      { id: "m2", nickname: "小周", owner: false, submitted: true },
    ],
  });
  groups = [current];
  const user = userEvent.setup();
  render(<GroupApp />);
  await user.click(
    await screen.findByRole("button", { name: "打开 梧桐周末" }),
  );
  await user.click(screen.getByRole("button", { name: "填写我的偏好" }));
  await user.click(screen.getByLabelText("咖啡"));
  await user.click(screen.getByRole("button", { name: "提交我的偏好" }));
  expect(await screen.findByText(/已进入规划队列/)).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "修改我的偏好" }),
  ).not.toBeInTheDocument();
});

it("preserves dirty edits on polling, reports stale saves and synchronizes explicitly", async () => {
  vi.useFakeTimers();
  render(<GroupApp />);
  await act(async () => {});
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "打开 梧桐周末" }));
  });
  fireEvent.click(screen.getByRole("button", { name: "填写我的偏好" }));
  fireEvent.change(screen.getByLabelText("一句话愿望（可选）"), {
    target: { value: "未保存的愿望" },
  });
  fireEvent.click(screen.getByLabelText("咖啡"));
  current = group({
    myMembers: [
      {
        ...current.myMembers[0],
        version: 1,
        preferences: { ...preferences, interests: ["咖啡"] },
      },
    ],
  });
  rejectSave = true;
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "提交我的偏好" }));
  });
  expect(screen.getByRole("alert")).toHaveTextContent("内容已更新");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
  expect(screen.getByLabelText("一句话愿望（可选）")).toHaveValue(
    "未保存的愿望",
  );
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "同步服务器草稿" }));
  });
  expect(screen.getByLabelText("一句话愿望（可选）")).toHaveValue(
    "我的服务器草稿",
  );
});

it("remounts only an authorized identity draft when switching members and rounds", async () => {
  current = group({
    myMembers: [
      current.myMembers[0],
      {
        id: "m2",
        nickname: "小周",
        owner: false,
        submitted: false,
        version: 0,
      },
    ],
  });
  groups = [current];
  const user = userEvent.setup();
  render(<GroupApp />);
  await user.click(
    await screen.findByRole("button", { name: "打开 梧桐周末" }),
  );
  await user.click(screen.getByRole("button", { name: "填写我的偏好" }));
  await user.type(screen.getByLabelText("一句话愿望（可选）"), "小林私密");
  await user.selectOptions(screen.getByLabelText("当前填写身份"), "m2");
  await user.click(screen.getByRole("button", { name: "填写我的偏好" }));
  expect(screen.getByLabelText("一句话愿望（可选）")).toHaveValue("");
});

it("supports management-only recovery without pretending to grant a member", async () => {
  current = group({ myMembers: [] });
  groups = [current];
  const user = userEvent.setup();
  render(<GroupApp />);
  await user.click(
    await screen.findByRole("button", { name: "打开 梧桐周末" }),
  );
  expect(
    screen.getByRole("button", { name: "更新邀请链接" }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "填写我的偏好" }),
  ).not.toBeInTheDocument();
  expect(screen.getByText(/仅有管理权限/)).toBeInTheDocument();
});

it("renders all three current candidates for nonowners, with persisted provenance and no owner actions", async () => {
  const candidates = getCandidates(createDemoRun({ runId: "group-test" }));
  current = group({
    canManage: false,
    state: "ready",
    candidates,
    selectedPlanId: candidates[1].id,
    job: {
      id: "j2",
      kind: "replan",
      state: "succeeded",
      attempt: 1,
      plans: [candidates[1]],
      events: [
        {
          sequence: 1,
          event: {
            type: "run.degraded",
            reason: "MODEL_UNAVAILABLE",
            fallback: "rule-planner",
          },
        },
      ],
    },
  });
  groups = [current];
  const user = userEvent.setup();
  render(<GroupApp />);
  await user.click(
    await screen.findByRole("button", { name: "打开 梧桐周末" }),
  );
  expect(screen.getAllByRole("article", { name: /候选方案/ })).toHaveLength(3);
  expect(screen.getByText(/rule-planner/)).toBeInTheDocument();
  expect(
    screen.getByText(`已选择：${candidates[1].title}`),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: /选择方案|确认最终行程|换个地方/ }),
  ).not.toBeInTheDocument();
});

it("renders partial interest support counts from the public consensus without member answers", async () => {
  current = group({ state: "ready", job: { id: "j", kind: "plan", state: "succeeded", attempt: 1, plans: [], events: [],
    result: { runId: "j", candidateIds: [], consensus: { shared: [], conflicts: [], constraints: [],
      interestSupport: [{ interest: "展览", count: 5, total: 6 }, { interest: "咖啡", count: 1, total: 6 }],
    } },
  } });
  groups = [current];
  const user = userEvent.setup();
  render(<GroupApp />);
  await user.click(await screen.findByRole("button", { name: "打开 梧桐周末" }));
  expect(screen.getByText("展览 · 5/6 人支持")).toBeInTheDocument();
  expect(screen.getByText("咖啡 · 1/6 人支持")).toBeInTheDocument();
});

it("selects and finalizes with stateVersion and displays the server final plan", async () => {
  const candidates = getCandidates(createDemoRun({ runId: "group-test" }));
  current = group({
    state: "ready",
    stateVersion: 8,
    candidates,
    members: [
      ...current.members,
      { id: "m2", nickname: "小周", owner: false, submitted: true },
    ],
  });
  groups = [current];
  const user = userEvent.setup();
  render(<GroupApp />);
  await user.click(
    await screen.findByRole("button", { name: "打开 梧桐周末" }),
  );
  await user.click(
    screen.getByRole("button", { name: `选择方案 ${candidates[1].title}` }),
  );
  await user.click(await screen.findByRole("button", { name: "确认最终行程" }));
  expect(writes.map((w) => w.body)).toEqual([
    { version: 8, planId: candidates[1].id, lockedStopIds: [] },
    { version: 9, planId: candidates[1].id },
  ]);
  expect(await screen.findByText("2 人，都说好")).toBeInTheDocument();
});

it("retains issued links through polling and grants another member only after explicit handoff", async () => {
  vi.useFakeTimers();
  groups = [];
  render(<GroupApp />);
  await act(async () => {});
  fireEvent.change(screen.getByLabelText("计划名称"), {
    target: { value: "梧桐周末" },
  });
  fireEvent.change(screen.getByLabelText("我的昵称"), {
    target: { value: "小林" },
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "创建并邀请" }));
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(6000);
  });
  expect(
    (screen.getByLabelText("我的恢复链接") as HTMLInputElement).value,
  ).toContain("#recover=PERSONAL");
  fireEvent.click(screen.getByRole("button", { name: "交给同设备另一位" }));
  fireEvent.change(screen.getByLabelText("加入昵称"), {
    target: { value: "小周" },
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "确认新增独立成员" }));
  });
  expect(writes[1].body).toEqual({
    token: "INVITE",
    nickname: "小周",
    handoff: true,
  });
  expect(screen.getByLabelText("当前填写身份")).toHaveValue("m2");
  fireEvent.click(screen.getByRole("button", { name: "填写我的偏好" }));
  expect(screen.getByLabelText("一句话愿望（可选）")).toHaveValue("");
  fireEvent.change(screen.getByLabelText("当前填写身份"), {
    target: { value: "m1" },
  });
  expect(
    (screen.getByLabelText("我的恢复链接") as HTMLInputElement).value,
  ).toContain("#recover=PERSONAL");
});

it("refreshes immediately on visibility changes and uses a slower hidden poll", async () => {
  vi.useFakeTimers();
  render(<GroupApp />);
  await act(async () => {});
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "打开 梧桐周末" }));
  });
  const initial = vi.mocked(fetch).mock.calls.length;
  Object.defineProperty(document, "hidden", {
    configurable: true,
    value: true,
  });
  await act(async () => {
    fireEvent(document, new Event("visibilitychange"));
  });
  expect(vi.mocked(fetch).mock.calls.length).toBe(initial + 1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(14999);
  });
  expect(vi.mocked(fetch).mock.calls.length).toBe(initial + 1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(vi.mocked(fetch).mock.calls.length).toBe(initial + 2);
  Object.defineProperty(document, "hidden", {
    configurable: true,
    value: false,
  });
  await act(async () => {
    fireEvent(document, new Event("visibilitychange"));
  });
  expect(vi.mocked(fetch).mock.calls.length).toBe(initial + 3);
});

it("backs off rate-limited polling across visibility changes and clears its error on recovery", async () => {
  vi.useFakeTimers();
  const original = vi.mocked(fetch).getMockImplementation()!;
  let reads = 0;
  vi.mocked(fetch).mockImplementation((path, options) => {
    if (path === "/api/groups/g1" && ++reads === 1)
      return Promise.resolve(Response.json({ error: { code: "RATE_LIMITED", message: "稍后重试轮询" } },
        { status: 429, headers: { "Retry-After": "12" } }));
    return original(path, options);
  });
  render(<GroupApp />);
  await act(async () => {});
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "打开 梧桐周末" })); });
  expect(screen.getByRole("alert")).toHaveTextContent("稍后重试轮询");
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); fireEvent(document, new Event("visibilitychange")); });
  await act(async () => { await vi.advanceTimersByTimeAsync(8999); });
  expect(reads).toBe(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(reads).toBe(2);
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("recovery restores management without adding a personal identity, and round reset requires reconfirmation", async () => {
  current = group({ myMembers: [], state: "ready" });
  history.replaceState(null, "", "/#recover=OWNER");
  const user = userEvent.setup();
  render(<GroupApp />);
  expect(
    await screen.findByRole("button", { name: "更新邀请链接" }),
  ).toBeInTheDocument();
  expect(writes[0].body).toEqual({ token: "OWNER" });
  await user.click(screen.getByRole("button", { name: "开启新一轮" }));
  await user.click(screen.getByRole("button", { name: "确认开启新一轮" }));
  expect(writes[1].body).toMatchObject({
    targetCount: 2,
    setup: { budget: 300 },
  });
  expect(screen.getByText("上海 · 第 2 轮")).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "填写我的偏好" }),
  ).not.toBeInTheDocument();
});

it("never lets a failed adjustment select or finalize old candidates and retry preserves the allowance", async () => {
  const candidates = getCandidates(createDemoRun({ runId: "failed-replan" }));
  current = group({
    state: "failed",
    replanCount: 1,
    candidates,
    selectedPlanId: candidates[0].id,
  });
  groups = [current];
  const user = userEvent.setup();
  render(<GroupApp />);
  await user.click(
    await screen.findByRole("button", { name: "打开 梧桐周末" }),
  );
  expect(screen.getByRole("button", { name: "确认最终行程" })).toBeDisabled();
  expect(
    screen.getByRole("button", { name: `选择方案 ${candidates[1].title}` }),
  ).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "重试本次规划" }));
  expect(writes[0]).toEqual({ path: "/api/groups/g1/retry", body: {} });
  expect(screen.getByText("已调整 1 / 2 次")).toBeInTheDocument();
});

it("limits adjustment reasons to 160 characters and sends only the selected stop and server version", async () => {
  const candidates = getCandidates(createDemoRun({ runId: "replan" }));
  current = group({
    state: "ready",
    stateVersion: 4,
    candidates,
    selectedPlanId: candidates[0].id,
  });
  groups = [current];
  const user = userEvent.setup();
  render(<GroupApp />);
  await user.click(
    await screen.findByRole("button", { name: "打开 梧桐周末" }),
  );
  await user.click(
    screen.getByRole("button", {
      name: `换个地方 ${candidates[0].stops[0].name}`,
    }),
  );
  expect(screen.getByLabelText("调整原因")).toHaveAttribute("maxLength", "160");
  await user.type(screen.getByLabelText("调整原因"), "希望更安静");
  await user.click(screen.getByRole("button", { name: "提交局部调整" }));
  expect(writes[0].body).toEqual({
    version: 4,
    rejectedStopId: candidates[0].stops[0].id,
    reason: "希望更安静",
  });
});

it("explicit synchronization after a conflict fetches the current draft before remounting", async () => {
  const user = userEvent.setup();
  render(<GroupApp />);
  await user.click(
    await screen.findByRole("button", { name: "打开 梧桐周末" }),
  );
  await user.click(screen.getByRole("button", { name: "填写我的偏好" }));
  await user.click(screen.getByLabelText("咖啡"));
  current = group({
    myMembers: [
      {
        ...current.myMembers[0],
        version: 2,
        preferences: { ...preferences, interests: ["咖啡"] },
      },
    ],
  });
  rejectSave = true;
  await user.click(screen.getByRole("button", { name: "提交我的偏好" }));
  await user.click(screen.getByRole("button", { name: "同步服务器草稿" }));
  expect(screen.getByLabelText("一句话愿望（可选）")).toHaveValue(
    "我的服务器草稿",
  );
  rejectSave = false;
  await user.click(screen.getByRole("button", { name: "保存我的草稿" }));
  expect(writes.at(-1)?.body).toMatchObject({ version: 2, submit: false });
});

it("keeps final plan and persisted events visible together for every member", async () => {
  const candidates = getCandidates(createDemoRun({ runId: "final" }));
  current = group({
    canManage: false,
    state: "finalized",
    candidates,
    finalPlanId: candidates[0].id,
    job: {
      id: "j",
      kind: "plan",
      state: "succeeded",
      attempt: 1,
      plans: candidates,
      events: [
        {
          sequence: 1,
          event: {
            type: "run.degraded",
            reason: "MODEL_UNAVAILABLE",
            fallback: "rule-planner",
          },
        },
      ],
    },
  });
  groups = [current];
  const user = userEvent.setup();
  render(<GroupApp />);
  await user.click(
    await screen.findByRole("button", { name: "打开 梧桐周末" }),
  );
  expect(screen.getByText(/rule-planner/)).toBeInTheDocument();
  expect(
    screen.getByRole("heading", { name: `${candidates[0].title}。` }),
  ).toBeInTheDocument();
});

it("preserves an own draft across a new round but never auto-submits it", async () => {
  current = group({
    myMembers: [
      {
        ...current.myMembers[0],
        preferences: { ...preferences, interests: ["咖啡"] },
        submitted: true,
      },
    ],
  });
  groups = [current];
  const user = userEvent.setup();
  render(<GroupApp />);
  await user.click(
    await screen.findByRole("button", { name: "打开 梧桐周末" }),
  );
  await user.click(screen.getByRole("button", { name: "开启新一轮" }));
  await user.click(screen.getByRole("button", { name: "确认开启新一轮" }));
  await user.click(screen.getByRole("button", { name: "填写我的偏好" }));
  expect(screen.getByLabelText("一句话愿望（可选）")).toHaveValue(
    "我的服务器草稿",
  );
  expect(screen.getByRole("button", { name: "提交我的偏好" })).toBeEnabled();
  expect(writes).toHaveLength(1);
});

it("ignores a delayed previous group response after switching to another group", async () => {
  const second = group({ id: "g2", name: "另一个周末" });
  groups.push(second);
  const original = vi.mocked(fetch).getMockImplementation()!;
  let release!: (r: Response) => void;
  vi.mocked(fetch).mockImplementation((path, options) =>
    path === "/api/groups/g1"
      ? new Promise((resolve) => {
          release = resolve;
        })
      : path === "/api/groups/g2"
        ? Promise.resolve(Response.json(second))
        : original(path, options),
  );
  const user = userEvent.setup();
  render(<GroupApp />);
  await user.click(
    await screen.findByRole("button", { name: "打开 梧桐周末" }),
  );
  await user.click(screen.getByRole("button", { name: "我的计划" }));
  await user.click(
    await screen.findByRole("button", { name: "打开 另一个周末" }),
  );
  await act(async () => {
    release(Response.json(current));
  });
  expect(
    screen.getByRole("heading", { name: "另一个周末" }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("heading", { name: "梧桐周末" }),
  ).not.toBeInTheDocument();
});

it("shows all-member interest support from persisted consensus without exposing drafts", async () => {
  const events = createDemoRun({ runId: "consensus" });
  const terminal = events.find((e) => e.type === "run.completed")!;
  current = group({
    state: "ready",
    canManage: false,
    members: [
      ...current.members,
      { id: "m2", nickname: "小周", owner: false, submitted: true },
    ],
    candidates: getCandidates(events),
    job: {
      id: "j",
      kind: "plan",
      state: "succeeded",
      attempt: 1,
      plans: getCandidates(events),
      events: events.map((event, index) => ({ sequence: index + 1, event })),
      result: terminal.result,
    },
  });
  groups = [current];
  const user = userEvent.setup();
  render(<GroupApp />);
  await user.click(
    await screen.findByRole("button", { name: "打开 梧桐周末" }),
  );
  expect(screen.getByText("咖啡 · 2/2 人共同支持")).toBeInTheDocument();
  expect(screen.queryByText("我的服务器草稿")).not.toBeInTheDocument();
});

it("rotates invitation separately and removes a member before reducing target count", async () => {
  current = group({
    targetCount: 3,
    members: [
      ...current.members,
      { id: "m2", nickname: "小周", owner: false, submitted: false },
      { id: "m3", nickname: "小何", owner: false, submitted: false },
    ],
  });
  groups = [current];
  const user = userEvent.setup();
  render(<GroupApp />);
  await user.click(
    await screen.findByRole("button", { name: "打开 梧桐周末" }),
  );
  await user.click(screen.getByRole("button", { name: "更新邀请链接" }));
  expect(
    (screen.getByLabelText("邀请链接") as HTMLInputElement).value,
  ).toContain("#invite=ROTATED");
  await user.click(screen.getByRole("button", { name: "开启新一轮" }));
  expect(
    within(screen.getByLabelText("参与人数")).queryByRole("option", {
      name: "2 人",
    }),
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "移除 小何" }));
  await user.click(screen.getByRole("button", { name: "开启新一轮" }));
  await user.click(screen.getByRole("button", { name: "开启新一轮" }));
  expect(
    within(screen.getByLabelText("参与人数")).getByRole("option", {
      name: "2 人",
    }),
  ).toBeInTheDocument();
  expect(writes[1]).toEqual({
    path: "/api/groups/g1/members/m3/remove",
    body: {},
  });
});

it("updates the selected and final plans from server polling without local voting state", async () => {
  vi.useFakeTimers();
  const candidates = getCandidates(createDemoRun({ runId: "poll-final" }));
  current = group({ state: "ready", canManage: false, candidates });
  groups = [current];
  render(<GroupApp />);
  await act(async () => {});
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "打开 梧桐周末" }));
  });
  current = { ...current, selectedPlanId: candidates[2].id };
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
  expect(
    screen.getByRole("heading", { name: `已选择：${candidates[2].title}` }),
  ).toBeInTheDocument();
  current = { ...current, state: "finalized", finalPlanId: candidates[2].id };
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
  expect(
    screen.getByRole("heading", { name: `${candidates[2].title}。` }),
  ).toBeInTheDocument();
});

it("locks a selected stop on the server and prevents a third local adjustment", async () => {
  const candidates = getCandidates(createDemoRun({ runId: "locks" }));
  current = group({
    state: "ready",
    candidates,
    selectedPlanId: candidates[0].id,
    stateVersion: 3,
    replanCount: 2,
  });
  groups = [current];
  const user = userEvent.setup();
  render(<GroupApp />);
  await user.click(
    await screen.findByRole("button", { name: "打开 梧桐周末" }),
  );
  const stop = candidates[0].stops[0];
  expect(
    screen.getByRole("button", { name: `换个地方 ${stop.name}` }),
  ).toBeDisabled();
  await user.click(screen.getByRole("button", { name: `锁定 ${stop.name}` }));
  expect(writes[0].body).toEqual({
    version: 3,
    planId: candidates[0].id,
    lockedStopIds: [stop.id],
  });
  expect(
    screen.getByRole("button", { name: `解锁 ${stop.name}` }),
  ).toBeInTheDocument();
});

it("keeps member-only recovery of the creator separate from management authority", async () => {
  current = group({ canManage: false });
  history.replaceState(null, "", "/#recover=PERSONAL");
  render(<GroupApp />);
  expect(
    await screen.findByRole("button", { name: "填写我的偏好" }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "更新邀请链接" }),
  ).not.toBeInTheDocument();
});

it("surfaces expired group status and disables its editing and management actions", async () => {
  current = group({ expiresAt: Date.now() - 1 });
  groups = [current];
  const user = userEvent.setup();
  render(<GroupApp />);
  await user.click(
    await screen.findByRole("button", { name: "打开 梧桐周末" }),
  );
  expect(screen.getByRole("status")).toHaveTextContent("计划已过期");
  expect(
    screen.queryByRole("button", { name: "填写我的偏好" }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "开启新一轮" })).toBeDisabled();
});

it("does not let a visibility poll discard an in-flight save and resumes polling afterward", async () => {
  vi.useFakeTimers();
  render(<GroupApp />);
  await act(async () => {});
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "打开 梧桐周末" }));
  });
  fireEvent.click(screen.getByRole("button", { name: "填写我的偏好" }));
  fireEvent.click(screen.getByLabelText("咖啡"));
  const original = vi.mocked(fetch).getMockImplementation()!;
  let finish!: () => void;
  vi.mocked(fetch).mockImplementation((path, options) =>
    path.endsWith("/preferences")
      ? new Promise((resolve) => {
          finish = async () => resolve(await original(path, options));
        })
      : original(path, options),
  );
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "提交我的偏好" }));
  });
  await act(async () => {
    fireEvent(document, new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(3000);
    finish();
  });
  expect(screen.getByText("等待其他成员提交")).toBeInTheDocument();
  current = { ...current, name: "服务器改名" };
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
  expect(
    screen.getByRole("heading", { name: "服务器改名" }),
  ).toBeInTheDocument();
});

it.each(["rotation", "manual refresh"] as const)(
  "keeps group, identity and URL aligned after a delayed %s response",
  async (operation) => {
    const first = current;
    const second = group({
      id: "g2",
      name: "另一组",
      myMembers: [
        {
          id: "m9",
          nickname: "阿九",
          owner: false,
          submitted: false,
          version: 0,
        },
      ],
      members: [{ id: "m9", nickname: "阿九", owner: false, submitted: false }],
    });
    groups.push(second);
    const original = vi.mocked(fetch).getMockImplementation()!;
    let delayRefresh = false;
    let release!: (value: Response) => void;
    vi.mocked(fetch).mockImplementation((path, options) => {
      if (path === "/api/groups/g2")
        return Promise.resolve(Response.json(second));
      if (path.endsWith("/invite"))
        return operation === "rotation"
          ? new Promise((resolve) => {
              release = resolve;
            })
          : Promise.resolve(
              Response.json(
                { error: { code: "RATE_LIMITED", message: "请稍后重试。" } },
                { status: 429 },
              ),
            );
      if (path === "/api/groups/g1" && delayRefresh)
        return new Promise((resolve) => {
          release = resolve;
        });
      return original(path, options);
    });
    const user = userEvent.setup();
    render(<GroupApp />);
    await user.click(
      await screen.findByRole("button", { name: "打开 梧桐周末" }),
    );
    await user.click(screen.getByRole("button", { name: "更新邀请链接" }));
    if (operation === "manual refresh") {
      delayRefresh = true;
      await user.click(screen.getByRole("button", { name: "刷新计划状态" }));
    }
    await user.click(screen.getByRole("button", { name: "我的计划" }));
    await user.click(
      await screen.findByRole("button", { name: "打开 另一组" }),
    );
    await act(async () => {
      release(
        Response.json(
          operation === "rotation"
            ? { group: first, inviteToken: "STALE" }
            : first,
        ),
      );
    });
    expect(screen.getByRole("heading", { name: "另一组" })).toBeInTheDocument();
    expect(screen.getByText(/当前身份：阿九/)).toBeInTheDocument();
    expect(location.hash).toBe("#group=g2");
    expect(
      screen.queryByRole("heading", { name: "梧桐周末" }),
    ).not.toBeInTheDocument();
  },
);

it.each(["recover", "create", "join"] as const)(
  "ignores a delayed %s navigation completion after choosing a different group",
  async (operation) => {
    const first = current;
    const second = group({ id: "g2", name: "另一组" });
    groups.push(second);
    const original = vi.mocked(fetch).getMockImplementation()!;
    let release!: (value: Response) => void;
    const pathToDelay =
      operation === "create" ? "/api/groups" : `/api/groups/${operation}`;
    vi.mocked(fetch).mockImplementation((path, options) => {
      if (path === pathToDelay && options?.method === "POST")
        return new Promise((resolve) => {
          release = resolve;
        });
      if (path === "/api/groups/g2")
        return Promise.resolve(Response.json(second));
      return original(path, options);
    });
    if (operation !== "create")
      history.replaceState(
        null,
        "",
        operation === "recover" ? "/#recover=OWNER" : "/#invite=INVITE",
      );
    const user = userEvent.setup();
    render(<GroupApp />);
    if (operation === "create") {
      await user.type(screen.getByLabelText("计划名称"), "新建组");
      await user.type(screen.getByLabelText("我的昵称"), "小林");
      await user.click(screen.getByRole("button", { name: "创建并邀请" }));
    }
    if (operation === "join") {
      await user.type(screen.getByLabelText("加入昵称"), "小林");
      await user.click(screen.getByRole("button", { name: "加入计划" }));
    }
    await user.click(screen.getByRole("button", { name: "我的计划" }));
    await user.click(
      await screen.findByRole("button", { name: "打开 另一组" }),
    );
    await act(async () => {
      release(
        Response.json(
          operation === "recover"
            ? first
            : {
                group: first,
                memberId: "m1",
                inviteToken: "INVITE",
                memberRecoveryToken: "PERSONAL",
                ownerRecoveryToken: "OWNER",
              },
        ),
      );
    });
    expect(screen.getByRole("heading", { name: "另一组" })).toBeInTheDocument();
    expect(location.hash).toBe("#group=g2");
  },
);

it.each(["queued", "running", "ready", "finalized"] as const)(
  "marks invitations invalid in %s and hides stale invite credentials",
  async (state) => {
    vi.useFakeTimers();
    groups = [];
    render(<GroupApp />);
    await act(async () => {});
    fireEvent.change(screen.getByLabelText("计划名称"), {
      target: { value: "梧桐周末" },
    });
    fireEvent.change(screen.getByLabelText("我的昵称"), {
      target: { value: "小林" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "创建并邀请" }));
    });
    expect(screen.getByLabelText("邀请链接")).toBeInTheDocument();
    current = { ...current, state };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(screen.getByText(/邀请已失效：本轮已进入规划/)).toBeInTheDocument();
    expect(
      screen.getByText(/开启新一轮收集后，需更新有效邀请链接/),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "更新邀请链接" })).toBeDisabled();
    expect(screen.queryByLabelText("邀请链接")).not.toBeInTheDocument();
    expect(screen.getByLabelText("我的恢复链接")).toBeInTheDocument();
  },
);

it("marks a collecting invitation expired at its seven-day deadline", async () => {
  current = group({
    createdAt: Date.now() - 8 * 86400000,
    inviteExpiresAt: Date.now() - 86400000,
  });
  groups = [current];
  const user = userEvent.setup();
  render(<GroupApp />);
  await user.click(
    await screen.findByRole("button", { name: "打开 梧桐周末" }),
  );
  expect(screen.getByText(/邀请已过期：已超过七天有效期/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "更新邀请链接" })).toBeDisabled();
  expect(screen.queryByText(/邀请有效至/)).not.toBeInTheDocument();
});

it("retains static-catalog freshness disclosure for an already finalized group", async () => {
  const candidates = getCandidates(createDemoRun({ runId: "final-source" }));
  current = group({
    state: "finalized",
    candidates,
    finalPlanId: candidates[0].id,
  });
  groups = [current];
  const user = userEvent.setup();
  render(<GroupApp />);
  await user.click(
    await screen.findByRole("button", { name: "打开 梧桐周末" }),
  );
  expect(screen.getByText(/地点来自静态上海精选目录/)).toBeInTheDocument();
});

it("completes a single recovery exchange through the application StrictMode effect replay", async () => {
  history.replaceState(null, "", "/#recover=OWNER");
  render(
    <StrictMode>
      <GroupApp />
    </StrictMode>,
  );
  expect(
    await screen.findByRole("heading", { name: "梧桐周末" }),
  ).toBeInTheDocument();
  expect(writes.filter((w) => w.path === "/api/groups/recover")).toHaveLength(
    1,
  );
  expect(location.hash).toBe("#group=g1");
});

it("requires a new valid rotation after a new round without extending the seven-day deadline", async () => {
  groups = [];
  const user = userEvent.setup();
  render(<GroupApp />);
  await user.type(screen.getByLabelText("计划名称"), "梧桐周末");
  await user.type(screen.getByLabelText("我的昵称"), "小林");
  await user.click(screen.getByRole("button", { name: "创建并邀请" }));
  await user.click(screen.getByRole("button", { name: "开启新一轮" }));
  await user.click(screen.getByRole("button", { name: "确认开启新一轮" }));
  expect(screen.queryByLabelText("邀请链接")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "更新邀请链接" })).toBeEnabled();
  await user.click(screen.getByRole("button", { name: "更新邀请链接" }));
  expect(
    (screen.getByLabelText("邀请链接") as HTMLInputElement).value,
  ).toContain("#invite=ROTATED");
});
