import { useState } from "react";
import type { PersonPreferences } from "@/contracts/agent";
import type { GroupView } from "@/contracts/groups";
import { dateLabel } from "@/components/Ui";
import { PreferenceStep } from "@/features/wizard/PreferenceStep";
import { GroupCreate } from "./GroupCreate";
import { GroupResults, type GroupMutation } from "./GroupResults";
import { groupClient } from "./client";

const states = {
  collecting: "收集大家的期待",
  queued: "已进入规划队列",
  running: "正在共同规划",
  ready: "三个方案已就绪",
  failed: "规划需要重试",
  finalized: "最终行程已确认",
};
export function GroupLobby({
  group,
  memberId,
  onMember,
  busy,
  mutate,
  rotate,
  handoff,
  inviteAvailable,
  expired,
}: {
  group: GroupView;
  memberId: string;
  onMember: (id: string) => void;
  busy: boolean;
  mutate: GroupMutation;
  rotate: () => void;
  handoff: () => void;
  inviteAvailable: boolean;
  expired: boolean;
}) {
  const mine = group.myMembers.find((m) => m.id === memberId);
  const [editing, setEditing] = useState(false);
  const [round, setRound] = useState(false);
  const [base, setBase] = useState(() => ({
    version: mine?.version ?? 0,
    preferences: mine?.preferences,
  }));
  const [formSeed, setFormSeed] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [conflict, setConflict] = useState(false);
  const canEdit = group.state === "collecting" && !!mine && !expired;
  const submitted = group.members.filter((m) => m.submitted).length;
  async function save(preferences: PersonPreferences, submit: boolean) {
    if (!mine) return;
    const saved = await mutate(() =>
      groupClient.save(group.id, {
        memberId: mine.id,
        version: base.version,
        preferences,
        submit,
        idempotencyKey: crypto.randomUUID(),
      }),
    );
    if (saved) {
      setEditing(false);
      setDirty(false);
      setConflict(false);
    } else setConflict(true);
  }
  function beginEdit() {
    setBase({ version: mine?.version ?? 0, preferences: mine?.preferences });
    setDirty(false);
    setConflict(false);
    setFormSeed((s) => s + 1);
    setEditing(true);
  }
  async function sync() {
    let latest: GroupView | undefined;
    if (
      await mutate(async () => {
        latest = await groupClient.get(group.id);
        return latest;
      })
    ) {
      const member = latest?.myMembers.find((m) => m.id === memberId);
      setBase({
        version: member?.version ?? 0,
        preferences: member?.preferences,
      });
      setDirty(false);
      setConflict(false);
      setFormSeed((s) => s + 1);
    }
  }
  return (
    <>
      <div className="group-lobby">
        <section className="group-common">
          <small>上海 · 第 {group.revision} 轮</small>
          <h1>{group.name}</h1>
          <p>
            {dateLabel(group.setup.date)}
            <br />
            {group.setup.startTime}–{group.setup.endTime} ·{" "}
            {group.setup.startingArea}
          </p>
          <p>
            {group.targetCount} 人总预算 ¥{group.setup.budget}
            <br />
            人均 ¥
            {Math.round((group.setup.budget / group.targetCount) * 100) / 100}
          </p>
          <p className="group-muted">
            计划有效至 {new Date(group.expiresAt).toLocaleString("zh-CN")}
            <br />
            邀请有效至 {new Date(group.inviteExpiresAt).toLocaleString("zh-CN")}
          </p>
          <div className="group-actions">
            {group.canManage && (
              <>
                <button
                  className="button secondary"
                  disabled={busy || expired}
                  onClick={rotate}
                >
                  更新邀请链接
                </button>
                <button
                  className="text-button"
                  disabled={busy || expired}
                  onClick={() => setRound(!round)}
                >
                  开启新一轮
                </button>
              </>
            )}
          </div>
        </section>
        <section className="group-members">
          <h2>留好每个人的位置</h2>
          <p role="status">
            {expired ? "计划已过期，请创建新计划。" : states[group.state]} ·
            已提交 {submitted} / {group.targetCount}
          </p>
          <ul
            className="group-seats"
            aria-label="参与席位"
            style={{ "--seats": group.targetCount } as React.CSSProperties}
          >
            {Array.from({ length: group.targetCount }, (_, i) => {
              const member = group.members[i];
              return (
                <li
                  key={member?.id ?? i}
                  aria-label={`席位 ${i + 1}${member ? ` ${member.nickname}` : " 等待加入"}`}
                  className={
                    member?.submitted
                      ? "submitted"
                      : member
                        ? "occupied"
                        : "empty"
                  }
                >
                  <span className="group-seat-avatar">
                    {member ? member.nickname.slice(0, 1) : "+"}
                  </span>
                  <strong>{member?.nickname ?? "等待加入"}</strong>
                  <span>
                    {member
                      ? member.submitted
                        ? "已提交 ✓"
                        : "待提交"
                      : "空位"}
                  </span>
                  {group.canManage &&
                    member &&
                    !member.owner &&
                    group.state === "collecting" && (
                      <button
                        className="text-button"
                        disabled={busy || expired}
                        onClick={() =>
                          mutate(() => groupClient.remove(group.id, member.id))
                        }
                      >
                        移除 {member.nickname}
                      </button>
                    )}
                </li>
              );
            })}
          </ul>
          {group.myMembers.length > 1 && (
            <label>
              当前填写身份
              <select
                value={memberId}
                onChange={(e) => onMember(e.target.value)}
              >
                {group.myMembers.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.nickname}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="group-own-action">
            {mine ? (
              <>
                <p>
                  当前身份：{mine.nickname} ·{" "}
                  {mine.submitted ? "已提交" : "尚未提交"}
                </p>
                {canEdit && (
                  <button
                    className="button primary"
                    disabled={busy}
                    onClick={beginEdit}
                  >
                    {mine.submitted ? "修改我的偏好" : "填写我的偏好"}
                  </button>
                )}
                {mine.submitted && group.state === "collecting" && (
                  <p>等待其他成员提交</p>
                )}
              </>
            ) : (
              <p>
                {group.canManage
                  ? "此设备仅有管理权限。填写个人偏好请使用个人恢复链接或加入邀请。"
                  : "此设备没有可填写的成员身份。"}
              </p>
            )}
            {group.state === "collecting" &&
              !expired &&
              group.members.length < group.targetCount && (
                <button
                  className="text-button"
                  disabled={busy || !inviteAvailable}
                  onClick={handoff}
                >
                  交给同设备另一位
                </button>
              )}
            {group.state === "collecting" &&
              !inviteAvailable &&
              group.members.length < group.targetCount && (
                <p className="group-muted">
                  同设备交接需要本次邀请链接；发起人可更新邀请，其他成员可重新打开邀请。
                </p>
              )}
          </div>
        </section>
      </div>
      {round && group.canManage && (
        <GroupCreate
          key={group.revision}
          busy={busy || expired}
          initial={{ setup: group.setup, targetCount: group.targetCount }}
          minimumCount={Math.max(2, group.members.length)}
          onSubmit={async ({ setup, targetCount }) => {
            if (
              await mutate(() =>
                groupClient.round(group.id, setup, targetCount),
              )
            )
              setRound(false);
          }}
        />
      )}
      {editing && canEdit && (
        <>
          <p className="group-form-state">
            {dirty ? "有尚未保存的编辑" : "仅显示当前身份的草稿"}
            {mine?.preferences && " · 草稿来自本人服务器记录"}
          </p>
          <PreferenceStep
            key={`${group.id}:${memberId}:${group.revision}:${formSeed}`}
            person={mine!.nickname}
            headcount={group.targetCount}
            setup={group.setup}
            initial={base.preferences}
            onBack={() => setEditing(false)}
            onSubmit={(p) => save(p, true)}
            groupControls={{
              busy,
              onDirty: () => setDirty(true),
              onSaveDraft: (p) => save(p, false),
              changed: mine!.version !== base.version || conflict,
              onSync: sync,
            }}
          />
        </>
      )}
      <GroupResults
        key={`${group.selectedPlanId ?? ""}:${group.job?.id ?? ""}`}
        group={group}
        busy={busy || expired}
        mutate={mutate}
      />
    </>
  );
}
