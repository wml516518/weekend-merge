import type { PlanSetup } from "@/contracts/agent";
import type {
  GroupCreated,
  GroupJoined,
  GroupView,
  SaveGroupPreferences,
  SelectGroupPlan,
  ReplanGroup,
  FinalizeGroup,
} from "@/contracts/groups";

export class GroupApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public retryAfterMs?: number,
  ) {
    super(message);
  }
}
async function send<T>(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`/api/groups${path}`, {
    credentials: "same-origin",
    signal,
    ...(body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  const value = await response.json();
  if (!response.ok)
    throw new GroupApiError(
      value.error?.code ?? "REQUEST_FAILED",
      value.error?.message ?? "请求失败，请稍后重试。",
      response.status === 429 ? retryDelay(response.headers.get("Retry-After")) : undefined,
    );
  return value as T;
}
function retryDelay(value: string | null): number {
  if (!value) return 60_000;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(delay) && delay > 0 ? Math.min(delay, 2_147_483_647) : 60_000;
}
// The first cookieless response must be delivered before any other request can
// receive a grant. Do not abort this shared bootstrap during StrictMode cleanup
// or navigation: aborting a fetch cannot fence browser Set-Cookie delivery.
let sessionBootstrap: Promise<{ groups: GroupView[] }> | undefined;
function bootstrap() {
  return sessionBootstrap ??= send<{ groups: GroupView[] }>("").catch(error => {
    sessionBootstrap = undefined;
    throw error;
  });
}
async function request<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  await bootstrap();
  return send<T>(path, body, signal);
}
const id = encodeURIComponent;
export const groupClient = {
  list: (signal?: AbortSignal) =>
    sessionBootstrap ? request<{ groups: GroupView[] }>("", undefined, signal) : bootstrap(),
  get: (groupId: string, signal?: AbortSignal) =>
    request<GroupView>(`/${id(groupId)}`, undefined, signal),
  create: (input: {
    name: string;
    nickname: string;
    targetCount: number;
    setup: PlanSetup;
  }) => request<GroupCreated>("", input),
  join: (token: string, nickname: string, handoff = false) =>
    request<GroupJoined>("/join", {
      token,
      nickname,
      ...(handoff ? { handoff: true } : {}),
    }),
  recover: (token: string) => request<GroupView>("/recover", { token }),
  save: (groupId: string, input: SaveGroupPreferences) =>
    request<GroupView>(`/${id(groupId)}/preferences`, input),
  invite: (groupId: string) =>
    request<{ group: GroupView; inviteToken: string }>(
      `/${id(groupId)}/invite`,
      {},
    ),
  remove: (groupId: string, memberId: string) =>
    request<GroupView>(`/${id(groupId)}/members/${id(memberId)}/remove`, {}),
  round: (groupId: string, setup: PlanSetup, targetCount: number) =>
    request<GroupView>(`/${id(groupId)}/round`, { setup, targetCount }),
  retry: (groupId: string) => request<GroupView>(`/${id(groupId)}/retry`, {}),
  select: (groupId: string, input: SelectGroupPlan) =>
    request<GroupView>(`/${id(groupId)}/select`, input),
  replan: (groupId: string, input: ReplanGroup) =>
    request<GroupView>(`/${id(groupId)}/replan`, input),
  finalize: (groupId: string, input: FinalizeGroup) =>
    request<GroupView>(`/${id(groupId)}/finalize`, input),
};
export function capabilityLink(kind: "invite" | "recover", token: string) {
  return `${location.origin}${location.pathname}#${kind}=${encodeURIComponent(token)}`;
}
