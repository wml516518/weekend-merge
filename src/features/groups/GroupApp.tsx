import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  CalendarDays,
  CheckCircle2,
  Compass,
  Leaf,
  LockKeyhole,
  ShieldCheck,
  Sparkles,
  UsersRound,
} from "lucide-react";
import type { GroupView } from "@/contracts/groups";
import { GroupCreate } from "./GroupCreate";
import { GroupLobby } from "./GroupLobby";
import { capabilityLink, groupClient, GroupApiError } from "./client";
import "./groups.css";

type Entry = { kind: "invite" | "recover" | "group"; token: string } | null;
function readEntry(): Entry {
  const values = new URLSearchParams(location.hash.slice(1));
  for (const kind of ["invite", "recover", "group"] as const) {
    const token = values.get(kind);
    if (token) return { kind, token };
  }
  return null;
}
function readPreferenceMember() {
  const params = new URLSearchParams(location.hash.slice(1));
  return params.get("view") === "preferences" ? params.get("member") ?? "" : "";
}
type IssuedLinks = {
  invite?: string;
  inviteRevision?: number;
  personal?: Record<string, string>;
  owner?: string;
};
const groupStateLabels: Record<GroupView["state"], string> = {
  collecting: "收集期待中",
  queued: "等待规划",
  running: "Agent 规划中",
  ready: "方案已就绪",
  failed: "需要重试",
  finalized: "行程已确认",
};
export function GroupApp() {
  const [entry, setEntry] = useState(readEntry);
  const [groups, setGroups] = useState<GroupView[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeId, setActiveId] = useState(
    entry?.kind === "group" ? entry.token : "",
  );
  const activeRef = useRef(activeId);
  activeRef.current = activeId;
  const [group, setGroup] = useState<GroupView>();
  const [memberId, setMember] = useState(readPreferenceMember);
  const [preferencePage, setPreferencePage] = useState(() => !!readPreferenceMember());
  const [error, setError] = useState("");
  const [pollError, setPollError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [nickname, setNickname] = useState("");
  const [handoff, setHandoff] = useState(false);
  const [issued, setIssued] = useState<Record<string, IssuedLinks>>({});
  const requestVersion = useRef(0);
  const navigationVersion = useRef(0);
  const actionVersion = useRef(0);
  const listVersion = useRef(0);
  const mounted = useRef(true);
  const exchanged = useRef<string>("");
  const mutating = useRef(false);
  const pollAbort = useRef<AbortController | null>(null);
  const loadList = useCallback(async (signal?: AbortSignal) => {
    const version = ++listVersion.current;
    try {
      const result = await groupClient.list(signal);
      if (
        !signal?.aborted &&
        mounted.current &&
        listVersion.current === version
      )
        setGroups(result.groups);
    } catch (e) {
      if (
        !signal?.aborted &&
        mounted.current &&
        listVersion.current === version
      )
        setError(e instanceof Error ? e.message : "无法读取我的计划。");
    } finally {
      if (
        !signal?.aborted &&
        mounted.current &&
        listVersion.current === version
      )
        setLoading(false);
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    void loadList(controller.signal);
    return () => {
      mounted.current = false;
      controller.abort();
    };
  }, [loadList]);
  function leaveContext() {
    setPollError("");
    navigationVersion.current++;
    actionVersion.current++;
    requestVersion.current++;
    pollAbort.current?.abort();
    mutating.current = false;
    setBusy(false);
  }
  function home() {
    setPreferencePage(false);
    leaveContext();
    activeRef.current = "";
    setActiveId("");
    setGroup(undefined);
    setEntry(null);
    setHandoff(false);
    setError("");
    history.replaceState(null, "", location.pathname);
    void loadList();
  }
  function open(value: GroupView, ownMemberId?: string) {
    setPreferencePage(false);
    leaveContext();
    activeRef.current = value.id;
    setActiveId(value.id);
    setGroup(value);
    setMember(ownMemberId ?? value.myMembers[0]?.id ?? "");
    setEntry(null);
    setHandoff(false);
    setError("");
    history.replaceState(
      null,
      "",
      `${location.pathname}${location.search}#group=${encodeURIComponent(value.id)}`,
    );
    setGroups((old) => [value, ...old.filter((g) => g.id !== value.id)]);
  }
  useEffect(() => {
    if (!entry) return;
    if (entry.kind !== "group")
      history.replaceState(null, "", location.pathname + location.search);
    if (entry.kind !== "recover" || exchanged.current === entry.token) return;
    exchanged.current = entry.token;
    void action(
      async (current) => {
        const value = await groupClient.recover(entry.token);
        if (current()) open(value);
      },
      () => setEntry(null),
    );
  }, [entry]);
  useEffect(() => {
    const listener = () => {
      const next = readEntry();
      setPreferencePage(!!readPreferenceMember());
      if (next?.kind === "group" && next.token === activeRef.current) {
        const requested = readPreferenceMember();
        if (requested) setMember(requested);
        return;
      }
      leaveContext();
      setEntry(next);
      if (next?.kind === "group") {
        activeRef.current = next.token;
        setActiveId(next.token);
        setGroup(undefined);
      } else {
        activeRef.current = "";
        setActiveId("");
        setGroup(undefined);
      }
    };
    window.addEventListener("hashchange", listener);
    return () => window.removeEventListener("hashchange", listener);
  }, []);
  useEffect(() => {
    if (!activeId) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    let nextPollAt = 0;
    const refresh = async () => {
      clearTimeout(timer);
      if (Date.now() < nextPollAt) {
        timer = setTimeout(refresh, nextPollAt - Date.now());
        return;
      }
      if (mutating.current) {
        timer = setTimeout(refresh, document.hidden ? 15000 : 3000);
        return;
      }
      clearTimeout(timer);
      pollAbort.current?.abort();
      const controller = new AbortController();
      pollAbort.current = controller;
      const version = ++requestVersion.current;
      try {
        const value = await groupClient.get(activeId, controller.signal);
        if (
          !disposed &&
          !controller.signal.aborted &&
          requestVersion.current === version
        ) {
          setGroup(value);
          const requested = readPreferenceMember();
          if (requested && !value.myMembers.some((m) => m.id === requested))
            setPreferencePage(false);
          setPollError("");
          setMember((old) =>
            value.myMembers.some((m) => m.id === old)
              ? old
              : (value.myMembers[0]?.id ?? ""),
          );
          setGroups((old) => old.map((g) => (g.id === value.id ? value : g)));
        }
      } catch (e) {
        if (
          !disposed &&
          !controller.signal.aborted &&
          requestVersion.current === version
        ) {
          setPollError(e instanceof Error ? e.message : "更新失败。");
          if (e instanceof GroupApiError && e.retryAfterMs)
            nextPollAt = Date.now() + e.retryAfterMs;
        }
      } finally {
        if (!disposed)
          timer = setTimeout(refresh, Math.max(nextPollAt - Date.now(), document.hidden ? 15000 : 3000));
      }
    };
    const visibility = () => {
      void refresh();
    };
    void refresh();
    document.addEventListener("visibilitychange", visibility);
    return () => {
      disposed = true;
      clearTimeout(timer);
      pollAbort.current?.abort();
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [activeId]);
  async function action(
    operation: (current: () => boolean) => Promise<void>,
    onFailure?: () => void,
  ) {
    if (mutating.current) return;
    const sourceId = activeRef.current;
    const navigation = navigationVersion.current;
    const version = ++requestVersion.current;
    const operationVersion = ++actionVersion.current;
    pollAbort.current?.abort();
    const current = () =>
      mounted.current &&
      activeRef.current === sourceId &&
      navigationVersion.current === navigation &&
      requestVersion.current === version &&
      actionVersion.current === operationVersion;
    setBusy(true);
    mutating.current = true;
    setError("");
    setMessage("");
    try {
      await operation(current);
    } catch (e) {
      if (current()) {
        setError(e instanceof Error ? e.message : "请求失败，请重试。");
        onFailure?.();
      }
    } finally {
      if (mounted.current && actionVersion.current === operationVersion) {
        mutating.current = false;
        setBusy(false);
      }
    }
  }
  async function mutate(operation: () => Promise<GroupView>) {
    if (mutating.current) return false;
    const sourceId = activeRef.current;
    const navigation = navigationVersion.current;
    const operationVersion = ++actionVersion.current;
    const version = ++requestVersion.current;
    pollAbort.current?.abort();
    setBusy(true);
    mutating.current = true;
    setError("");
    try {
      const value = await operation();
      if (
        mounted.current &&
        activeRef.current === sourceId &&
        navigationVersion.current === navigation &&
        actionVersion.current === operationVersion &&
        requestVersion.current === version
      ) {
        setGroup(value);
        setGroups((old) => old.map((g) => (g.id === value.id ? value : g)));
        return true;
      }
      return false;
    } catch (e) {
      if (
        mounted.current &&
        activeRef.current === sourceId &&
        navigationVersion.current === navigation &&
        actionVersion.current === operationVersion
      )
        setError(
          e instanceof GroupApiError
            ? `${e.message}${e.code === "VERSION_CONFLICT" ? " 请同步服务器内容后重试。" : ""}`
            : e instanceof Error
              ? e.message
              : "保存失败。",
        );
      return false;
    } finally {
      if (mounted.current && actionVersion.current === operationVersion) {
        mutating.current = false;
        setBusy(false);
      }
    }
  }
  function remember(groupId: string, value: IssuedLinks) {
    setIssued((old) => ({
      ...old,
      [groupId]: {
        ...old[groupId],
        ...value,
        personal: { ...old[groupId]?.personal, ...value.personal },
      },
    }));
  }
  const links = group ? (issued[group.id] ?? {}) : {};
  function showPreferences(value: boolean, replace = false) {
    const params = new URLSearchParams({ group: activeId });
    if (value) { params.set("view", "preferences"); params.set("member", memberId); }
    const url = `${location.pathname}${location.search}#${params}`;
    if (replace) history.replaceState(null, "", url);
    else history.pushState(null, "", url);
    setPreferencePage(value);
  }
  const editingPreferences = preferencePage && group?.state === "collecting" &&
    Date.now() < group.expiresAt && group.myMembers.some((m) => m.id === memberId);
  const inviteValid =
    !!group &&
    group.state === "collecting" &&
    Date.now() < group.expiresAt &&
    Date.now() < group.inviteExpiresAt &&
    links.inviteRevision === group.revision;
  const joinToken =
    entry?.kind === "invite"
      ? entry.token
      : handoff && inviteValid
        ? links.invite
        : undefined;
  async function copy(value: string) {
    const navigation = navigationVersion.current;
    try {
      await navigator.clipboard.writeText(value);
      if (mounted.current && navigationVersion.current === navigation)
        setMessage("链接已复制。");
    } catch {
      if (mounted.current && navigationVersion.current === navigation)
        setMessage("未能复制，请选择链接文本手动复制。");
    }
  }
  function linkField(
    label: string,
    kind: "invite" | "recover",
    token?: string,
  ) {
    if (!token) return null;
    const value = capabilityLink(kind, token);
    return (
      <div className="group-link">
        <label>
          {label}
          <input
            readOnly
            value={value}
            onFocus={(e) => e.currentTarget.select()}
          />
        </label>
        <button className="button secondary group-copy-button" onClick={() => copy(value)}>
          复制{label}
        </button>
      </div>
    );
  }
  return (
    <div className="app-shell group-shell">
      <header className="header">
        <button
          className="brand"
          aria-label="Weekend Merge 周末共识局"
          onClick={home}
        >
          <span className="brand-mark">
            <Leaf size={21} />
          </span>
          <span>
            weekend<span className="brand-light">merge</span>
            <small>周末共识局</small>
          </span>
        </button>
        <nav aria-label="应用导航" className="top-nav group-nav">
          <button className="nav-active" onClick={home}>
            我的计划
          </button>
          <a className="group-demo-link" href="#demo">
            体验演示
          </a>
        </nav>
        <div className="group-header-meta">
          <span className="demo-pill">
            <span /> 多人实时计划
          </span>
          <span className="group-header-avatar" aria-hidden="true">
            <UsersRound size={17} />
          </span>
        </div>
      </header>
      <div className="group-content">
        {(error || pollError) && (
          <div className="group-notice" role="alert">
            {error || pollError}
            {activeId && (
              <button
                className="text-button"
                onClick={() =>
                  action(async (current) => {
                    const value = await groupClient.get(activeId);
                    if (!current()) return;
                    setGroup(value);
                    setMessage("服务器内容已更新。");
                  })
                }
              >
                刷新计划状态
              </button>
            )}
          </div>
        )}
        {message && (
          <p className="group-toast" role="status">
            <CheckCircle2 size={16} aria-hidden="true" />
            {message}
          </p>
        )}
        {joinToken && (
          <form
            className="group-join"
            onSubmit={(e) => {
              e.preventDefault();
              void action(async (current) => {
                const value = await groupClient.join(
                  joinToken,
                  nickname.trim(),
                  handoff,
                );
                if (!current()) return;
                remember(value.group.id, {
                  invite: joinToken,
                  inviteRevision: value.group.revision,
                  ...(value.memberRecoveryToken
                    ? {
                        personal: {
                          [value.memberId]: value.memberRecoveryToken,
                        },
                      }
                    : {}),
                });
                open(value.group, value.memberId);
                setNickname("");
              });
            }}
          >
            <span className="group-kicker">
              <UsersRound size={14} /> 受邀加入
            </span>
            <h1>{handoff ? "交给同设备另一位" : "一起留个周末"}</h1>
            <p>
              {handoff
                ? "请把设备交给另一位。确认后新增独立成员，开始空白偏好。此设备之后可切换已授权身份。"
                : "每个人独立填写，收齐后再一起看方案。"}
            </p>
            <label>
              加入昵称
              <input
                required
                maxLength={40}
                value={nickname}
                onChange={(e) => setNickname(e.target.value)}
              />
            </label>
            <button className="button primary" disabled={busy || loading}>
              {handoff ? "确认新增独立成员" : "加入计划"}
              <ArrowRight size={16} aria-hidden="true" />
            </button>
            {handoff && (
              <button
                className="text-button"
                type="button"
                onClick={() => setHandoff(false)}
              >
                取消交接
              </button>
            )}
          </form>
        )}
        {group && !joinToken && (
          <>
            <GroupLobby
              key={`${group.id}:${memberId}:${group.revision}`}
              group={group}
              memberId={memberId}
              onMember={(id) => { showPreferences(false, true); setMember(id); }}
              preferencePage={!!editingPreferences}
              onPreferencePage={showPreferences}
              busy={busy || loading}
              mutate={mutate}
              expired={Date.now() >= group.expiresAt}
              inviteAvailable={!!links.invite && inviteValid}
              handoff={() => {
                setNickname("");
                setHandoff(true);
              }}
              rotate={() =>
                action(async (current) => {
                  const value = await groupClient.invite(group.id);
                  if (!current()) return;
                  remember(group.id, {
                    invite: value.inviteToken,
                    inviteRevision: value.group.revision,
                  });
                  setGroup(value.group);
                })
              }
            />
            {!editingPreferences && (links.invite || links.personal?.[memberId] || links.owner) && (
              <section className="group-links" aria-label="邀请与恢复链接">
                <div className="group-links-heading">
                  <span className="group-icon-box">
                    <LockKeyhole size={19} />
                  </span>
                  <div>
                    <small>邀请与恢复</small>
                    <h2>把邀请发给同行的人</h2>
                  </div>
                </div>
                {linkField(
                  "邀请链接",
                  "invite",
                  inviteValid ? links.invite : undefined,
                )}
                {linkField(
                  "我的恢复链接",
                  "recover",
                  links.personal?.[memberId],
                )}
                {linkField("管理恢复链接", "recover", links.owner)}
                <p className="group-security-note">
                  <ShieldCheck size={17} aria-hidden="true" />
                  <span>
                  请现在妥善保存恢复链接，刷新后不会再次显示。个人链接可恢复本人的答案；管理链接可操作整个计划，请勿发到群聊。链接不写入本地存储。
                  </span>
                </p>
              </section>
            )}
          </>
        )}
        {!activeId && !joinToken && entry?.kind !== "recover" && (
          <main className="group-home">
            <section className="group-home-intro">
              <span className="group-kicker">
                <Sparkles size={14} /> 上海 · 2–6 人的周末
              </span>
              <h1>
                先各自期待，
                <br />
                再一起出发。
              </h1>
              <p>
                约好共同的时间与预算，邀请朋友独立填写。
                <br />
                每一份期待到齐后，一起从三个提案里做选择。
              </p>
              <div className="group-value-list" aria-label="产品特点">
                <span><UsersRound size={15} /> 独立填写</span>
                <span><Compass size={15} /> 三套提案</span>
                <span><ShieldCheck size={15} /> 只展示共识</span>
              </div>
              <section className="group-list" aria-label="我的计划">
                <div className="group-list-heading">
                  <div>
                    <small>继续上次的约定</small>
                    <h2>我的计划</h2>
                  </div>
                  <CalendarDays size={19} aria-hidden="true" />
                </div>
                {loading ? (
                  <p>正在读取计划…</p>
                ) : groups.length ? (
                  groups.map((g) => (
                    <article className="group-list-card" key={g.id}>
                      <div>
                        <span className={`group-state group-state-${g.state}`}>
                          {groupStateLabels[g.state]}
                        </span>
                        <h3>{g.name}</h3>
                        <p>
                          {g.targetCount} 人 · 第 {g.revision} 轮 ·{" "}
                          {g.members.filter((m) => m.submitted).length} 人已提交
                        </p>
                      </div>
                      <button className="text-button" onClick={() => open(g)}>
                        打开 {g.name} <ArrowRight size={14} aria-hidden="true" />
                      </button>
                    </article>
                  ))
                ) : (
                  <p>此设备还没有参与的计划。创建一个，或打开朋友的邀请。</p>
                )}
              </section>
            </section>
            <GroupCreate
              busy={busy || loading}
              onSubmit={(value) =>
                action(async (current) => {
                  const result = await groupClient.create(value);
                  if (!current()) return;
                  remember(result.group.id, {
                    invite: result.inviteToken,
                    inviteRevision: result.group.revision,
                    personal: { [result.memberId]: result.memberRecoveryToken },
                    owner: result.ownerRecoveryToken,
                  });
                  open(result.group, result.memberId);
                })
              }
            />
          </main>
        )}
        {activeId && !group && <p role="status">正在读取计划…</p>}
      </div>
      <footer className="footer">
        <span>weekendmerge / 让“都可以”变成“一起去”。</span>
        <span>每个人，都有一个位置。</span>
      </footer>
    </div>
  );
}
