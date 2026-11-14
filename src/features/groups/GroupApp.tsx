import { useCallback, useEffect, useRef, useState } from "react";
import { Leaf } from "lucide-react";
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
type IssuedLinks = {
  invite?: string;
  personal?: Record<string, string>;
  owner?: string;
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
  const [memberId, setMember] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [nickname, setNickname] = useState("");
  const [handoff, setHandoff] = useState(false);
  const [issued, setIssued] = useState<Record<string, IssuedLinks>>({});
  const requestVersion = useRef(0);
  const mounted = useRef(true);
  const exchanged = useRef<string>("");
  const mutating = useRef(false);
  const pollAbort = useRef<AbortController | null>(null);
  const loadList = useCallback(async (signal?: AbortSignal) => {
    try {
      const result = await groupClient.list(signal);
      if (!signal?.aborted && mounted.current) setGroups(result.groups);
    } catch (e) {
      if (!signal?.aborted && mounted.current)
        setError(e instanceof Error ? e.message : "无法读取我的计划。");
    } finally {
      if (!signal?.aborted && mounted.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    void loadList(controller.signal);
    return () => {
      mounted.current = false;
      requestVersion.current++;
      controller.abort();
    };
  }, [loadList]);
  function open(value: GroupView, ownMemberId?: string) {
    requestVersion.current++;
    pollAbort.current?.abort();
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
    setBusy(true);
    setError("");
    void groupClient
      .recover(entry.token)
      .then((value) => {
        if (mounted.current) open(value);
      })
      .catch((e) => {
        if (mounted.current) {
          setError(e instanceof Error ? e.message : "恢复失败。");
          setEntry(null);
        }
      })
      .finally(() => {
        if (mounted.current) setBusy(false);
      });
  }, [entry]);
  useEffect(() => {
    const listener = () => {
      const next = readEntry();
      setEntry(next);
      if (next?.kind === "group") {
        setActiveId(next.token);
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
    const refresh = async () => {
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
        )
          setError(e instanceof Error ? e.message : "更新失败。");
      } finally {
        if (!disposed)
          timer = setTimeout(refresh, document.hidden ? 15000 : 3000);
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
  async function action(operation: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    mutating.current = true;
    setError("");
    setMessage("");
    try {
      await operation();
    } catch (e) {
      if (mounted.current)
        setError(e instanceof Error ? e.message : "请求失败，请重试。");
    } finally {
      mutating.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function mutate(operation: () => Promise<GroupView>) {
    if (busy) return false;
    const sourceId = activeRef.current;
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
        requestVersion.current === version
      ) {
        setGroup(value);
        setGroups((old) => old.map((g) => (g.id === value.id ? value : g)));
        return true;
      }
      return false;
    } catch (e) {
      if (mounted.current && activeRef.current === sourceId)
        setError(
          e instanceof GroupApiError
            ? `${e.message}${e.code === "VERSION_CONFLICT" ? " 请同步服务器内容后重试。" : ""}`
            : e instanceof Error
              ? e.message
              : "保存失败。",
        );
      return false;
    } finally {
      mutating.current = false;
      if (mounted.current) setBusy(false);
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
  const joinToken =
    entry?.kind === "invite" ? entry.token : handoff ? links.invite : undefined;
  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setMessage("链接已复制。");
    } catch {
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
        <button className="text-button" onClick={() => copy(value)}>
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
          onClick={() => {
            requestVersion.current++;
            setActiveId("");
            setGroup(undefined);
            setEntry(null);
            history.replaceState(null, "", location.pathname);
            void loadList();
          }}
        >
          <span className="brand-mark">
            <Leaf size={21} />
          </span>
          <span>
            weekend<span className="brand-light">merge</span>
            <small>周末共识局</small>
          </span>
        </button>
        <nav aria-label="应用导航" className="group-actions">
          <button
            className="text-button"
            onClick={() => {
              setActiveId("");
              setGroup(undefined);
              setEntry(null);
              history.replaceState(null, "", location.pathname);
              void loadList();
            }}
          >
            我的计划
          </button>
          <a className="text-button" href="#demo">
            体验演示
          </a>
        </nav>
      </header>
      <div className="group-content">
        {error && (
          <div className="group-notice" role="alert">
            {error}
            {activeId && (
              <button
                className="text-button"
                onClick={() =>
                  action(async () => {
                    const value = await groupClient.get(activeId);
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
        {message && <p role="status">{message}</p>}
        {joinToken && (
          <form
            className="group-join"
            onSubmit={(e) => {
              e.preventDefault();
              void action(async () => {
                const value = await groupClient.join(
                  joinToken,
                  nickname.trim(),
                  handoff,
                );
                remember(value.group.id, {
                  invite: joinToken,
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
            <button className="button primary" disabled={busy}>
              {handoff ? "确认新增独立成员" : "加入计划"}
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
              onMember={setMember}
              busy={busy}
              mutate={mutate}
              expired={Date.now() >= group.expiresAt}
              inviteAvailable={
                !!links.invite && Date.now() < group.inviteExpiresAt
              }
              handoff={() => {
                setNickname("");
                setHandoff(true);
              }}
              rotate={() =>
                action(async () => {
                  const value = await groupClient.invite(group.id);
                  remember(group.id, { invite: value.inviteToken });
                  setGroup(value.group);
                })
              }
            />
            {(links.invite || links.personal?.[memberId] || links.owner) && (
              <section className="group-links" aria-label="邀请与恢复链接">
                <h2>把邀请发给同行的人</h2>
                {linkField("邀请链接", "invite", links.invite)}
                {linkField(
                  "我的恢复链接",
                  "recover",
                  links.personal?.[memberId],
                )}
                {linkField("管理恢复链接", "recover", links.owner)}
                <p>
                  请现在妥善保存恢复链接，刷新后不会再次显示。个人链接可恢复本人的答案；管理链接可操作整个计划，请勿发到群聊。链接不写入本地存储。
                </p>
              </section>
            )}
          </>
        )}
        {!activeId && !joinToken && entry?.kind !== "recover" && (
          <main className="group-home">
            <section className="group-home-intro">
              <small>上海 · 2–6 人的周末</small>
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
              <section className="group-list" aria-label="我的计划">
                <h2>我的计划</h2>
                {loading ? (
                  <p>正在读取计划…</p>
                ) : groups.length ? (
                  groups.map((g) => (
                    <div key={g.id}>
                      <h3>{g.name}</h3>
                      <p>
                        {g.targetCount} 人 · 第 {g.revision} 轮 ·{" "}
                        {g.members.filter((m) => m.submitted).length} 人已提交
                      </p>
                      <button className="text-button" onClick={() => open(g)}>
                        打开 {g.name}
                      </button>
                    </div>
                  ))
                ) : (
                  <p>此设备还没有参与的计划。创建一个，或打开朋友的邀请。</p>
                )}
              </section>
            </section>
            <GroupCreate
              busy={busy}
              onSubmit={(value) =>
                action(async () => {
                  const result = await groupClient.create(value);
                  remember(result.group.id, {
                    invite: result.inviteToken,
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
