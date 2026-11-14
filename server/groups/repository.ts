import { createHash } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { AgentEventSchema, PersonPreferencesSchema, PlanSetupSchema, ReplanRequestSchema } from '../../src/contracts/agent';
import type { AgentEvent, PersonPreferences, PlanSetup, Itinerary, PlanDiff, ReplanRequest } from '../../src/contracts/agent';
import type { ClaimedGroupJob, FinalizeGroup, GroupCreated, GroupJoined, GroupJobView, GroupMember, GroupView, ReplanGroup, SaveGroupPreferences, SelectGroupPlan } from '../../src/contracts/groups';
import { shanghaiPlaces } from '../../netlify/functions/agent/tools/places';
import { estimateRoute } from '../../netlify/functions/agent/tools/route';
import { calculateBudget } from '../../netlify/functions/agent/tools/budget';
import type { CalculateBudgetInput } from '../../netlify/functions/agent/tools/contracts';
import { validatePlan } from '../../netlify/functions/agent/tools/validator';
import { check, digest, newId, newToken } from './auth';
import { openDatabase, transaction } from './database';

const DAY = 86_400_000;
interface GroupRow {
  id: string; name: string; owner_id: string; target_count: number; setup: string; revision: number; state_version: number;
  state: GroupView['state']; created_at: number; expires_at: number; invite_hash: string | null; invite_expires_at: number;
  selected_plan_id: string | null; final_plan_id: string | null; locked_stop_ids: string; replan_count: number;
}
interface MemberRow { id: string; nickname: string; owner: number; version: number; payload: string | null; submitted: number }
interface GrantRow { member_id: string | null; role: 'owner' | 'member' }
interface JobRow {
  id: string; group_id: string; revision: number; kind: 'plan' | 'replan'; attempt: number; state: GroupJobView['state'];
  lease: string | null; request: string; result: string | null; error: string | null;
}

/** All transactions are short, synchronous and contain no upstream work. */
export class GroupRepository {
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  private closed = false;
  constructor(options: { path: string; now?: () => number }) { this.db = openDatabase(options.path); this.now = options.now ?? Date.now; }
  close(): void { if (!this.closed) { this.db.close(); this.closed = true; } }
  private one<T>(sql: string, ...params: SQLInputValue[]): T | undefined { return this.db.prepare(sql).get(...params) as T | undefined; }
  private all<T>(sql: string, ...params: SQLInputValue[]): T[] { return this.db.prepare(sql).all(...params) as T[]; }
  private run(sql: string, ...params: SQLInputValue[]) { return this.db.prepare(sql).run(...params); }
  private tx<T>(action: () => T): T { return transaction(this.db, action); }
  private group(id: string): GroupRow {
    const group = this.one<GroupRow>('SELECT * FROM groups WHERE id=? AND expires_at>?', id, this.now());
    check(group, 'GROUP_UNAVAILABLE'); return group;
  }
  private grants(session: string, groupId: string): GrantRow[] {
    return this.all<GrantRow>('SELECT member_id,role FROM access_grants WHERE session_hash=? AND group_id=? AND expires_at>?', digest(session), groupId, this.now());
  }
  private authorized(session: string, groupId: string, memberId?: string): GroupRow {
    const group = this.group(groupId); const grants = this.grants(session, groupId);
    check(memberId ? grants.some(g => g.role === 'member' && g.member_id === memberId) : grants.length, 'FORBIDDEN'); return group;
  }
  private owner(session: string, groupId: string): GroupRow {
    const group = this.group(groupId); check(this.grants(session, groupId).some(g => g.role === 'owner'), 'FORBIDDEN'); return group;
  }
  private grant(session: string, group: GroupRow, role: 'owner' | 'member', memberId: string | null): void {
    this.run('INSERT OR IGNORE INTO access_grants(id,session_hash,group_id,member_id,role,expires_at) VALUES(?,?,?,?,?,?)', newId(), digest(session), group.id, memberId, role, group.expires_at);
  }
  private capability(group: GroupRow, role: 'owner' | 'member', memberId: string | null): string {
    const token = newToken(); this.run('INSERT INTO recovery_capabilities VALUES(?,?,?,?,?)', digest(token), group.id, memberId, role, group.expires_at); return token;
  }
  private validateSetup(setup: PlanSetup, targetCount: number): PlanSetup {
    check(Number.isInteger(targetCount) && targetCount >= 2 && targetCount <= 6, 'INVALID_TARGET');
    const result = PlanSetupSchema.parse(setup); check(result.budget <= targetCount * 2000, 'INVALID_BUDGET'); return result;
  }
  private name(value: string): string { check(typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 40, 'INVALID_NAME'); return value.trim(); }
  private addMember(session: string, group: GroupRow, nickname: string, owner: boolean): { memberId: string; memberRecoveryToken: string } {
    const memberId = newId();
    this.run('INSERT INTO members VALUES(?,?,?,?)', group.id, memberId, this.name(nickname), owner ? 1 : 0);
    this.run('INSERT INTO preferences(group_id,member_id,revision) VALUES(?,?,?)', group.id, memberId, group.revision);
    this.grant(session, group, 'member', memberId);
    return { memberId, memberRecoveryToken: this.capability(group, 'member', memberId) };
  }

  create(session: string, name: string, nickname: string, targetCount: number, setup: PlanSetup): GroupCreated {
    return this.tx(() => {
      const conditions = this.validateSetup(setup, targetCount); const id = newId(); const inviteToken = newToken(); const now = this.now();
      this.run('INSERT INTO groups(id,name,owner_id,target_count,setup,created_at,expires_at,invite_hash,invite_expires_at) VALUES(?,?,?,?,?,?,?,?,?)', id, this.name(name), '', targetCount, JSON.stringify(conditions), now, now + 30 * DAY, digest(inviteToken), now + 7 * DAY);
      const group = this.group(id); const member = this.addMember(session, group, nickname, true);
      this.run('UPDATE groups SET owner_id=? WHERE id=?', member.memberId, id);
      this.grant(session, group, 'owner', null);
      return { group: this.view(session, id), ...member, inviteToken, ownerRecoveryToken: this.capability(group, 'owner', null) };
    });
  }
  join(session: string, token: string, nickname: string, options: { handoff?: boolean } = {}): GroupJoined {
    return this.tx(() => {
      const group = this.one<GroupRow>("SELECT * FROM groups WHERE invite_hash=? AND invite_expires_at>? AND expires_at>? AND state='collecting'", digest(token), this.now(), this.now());
      check(group, 'INVITE_UNAVAILABLE');
      const existing = this.grants(session, group.id).find(g => g.role === 'member');
      if (existing && !options.handoff) return { group: this.view(session, group.id), memberId: existing.member_id! };
      const count = this.one<{ count: number }>('SELECT COUNT(*) AS count FROM members WHERE group_id=?', group.id)!.count;
      check(count < group.target_count, 'GROUP_FULL');
      const member = this.addMember(session, group, nickname, false);
      this.run('UPDATE groups SET state_version=state_version+1 WHERE id=?', group.id);
      return { group: this.view(session, group.id), ...member };
    });
  }
  recover(session: string, token: string): GroupView {
    return this.tx(() => {
      const capability = this.one<{ group_id: string; member_id: string | null; role: 'owner' | 'member' }>('SELECT * FROM recovery_capabilities WHERE token_hash=? AND expires_at>?', digest(token), this.now());
      check(capability, 'RECOVERY_UNAVAILABLE'); const group = this.group(capability.group_id);
      this.grant(session, group, capability.role, capability.member_id); return this.view(session, group.id);
    });
  }
  list(session: string): GroupView[] {
    return this.all<{ id: string }>('SELECT DISTINCT g.id,g.created_at FROM groups g JOIN access_grants a ON a.group_id=g.id WHERE a.session_hash=? AND a.expires_at>? AND g.expires_at>? ORDER BY g.created_at,g.id', digest(session), this.now(), this.now()).map(g => this.view(session, g.id));
  }
  view(session: string, groupId: string, memberId?: string): GroupView {
    const group = this.authorized(session, groupId, memberId); const grants = this.grants(session, groupId);
    const members = this.all<MemberRow>('SELECT m.*,p.version,p.payload,p.submitted FROM members m JOIN preferences p ON p.group_id=m.group_id AND p.member_id=m.id WHERE m.group_id=? AND p.revision=? ORDER BY m.owner DESC,m.rowid', groupId, group.revision);
    const publicMember = (m: MemberRow): GroupMember => ({ id: m.id, nickname: m.nickname, owner: !!m.owner, submitted: !!m.submitted });
    return {
      id: group.id, name: group.name, targetCount: group.target_count, setup: JSON.parse(group.setup), revision: group.revision, stateVersion: group.state_version,
      state: group.state, createdAt: group.created_at, expiresAt: group.expires_at, inviteExpiresAt: group.invite_expires_at,
      canManage: grants.some(g => g.role === 'owner'), members: members.map(publicMember),
      myMembers: members.filter(m => (!memberId || memberId === m.id) && grants.some(g => g.role === 'member' && g.member_id === m.id)).map(m => ({ ...publicMember(m), version: m.version, ...(m.payload ? { preferences: JSON.parse(m.payload) as PersonPreferences } : {}) })),
      job: this.jobView(this.latestJob(group)), candidates: this.currentCandidates(group),
      ...(group.selected_plan_id ? { selectedPlanId: group.selected_plan_id } : {}), ...(group.final_plan_id ? { finalPlanId: group.final_plan_id } : {}),
      lockedStopIds: JSON.parse(group.locked_stop_ids), replanCount: group.replan_count,
    };
  }
  save(session: string, groupId: string, input: SaveGroupPreferences): GroupView {
    return this.tx(() => {
      const group = this.authorized(session, groupId, input.memberId);
      check(typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0 && input.idempotencyKey.length <= 128, 'INVALID_IDEMPOTENCY_KEY');
      const previous = this.one<{ response: string }>('SELECT response FROM idempotency WHERE group_id=? AND member_id=? AND revision=? AND key=?', groupId, input.memberId, group.revision, input.idempotencyKey);
      if (previous) {
        const result = JSON.parse(previous.response) as GroupView; const grants = this.grants(session, groupId);
        result.myMembers = result.myMembers.filter(m => grants.some(g => g.member_id === m.id && g.role === 'member'));
        result.canManage = grants.some(g => g.role === 'owner'); return result;
      }
      check(group.state === 'collecting', 'ROUND_FROZEN');
      check(Number.isInteger(input.version) && input.version >= 0 && typeof input.submit === 'boolean', 'INVALID_VERSION');
      const preferences = PersonPreferencesSchema.parse(input.preferences);
      const updated = this.run('UPDATE preferences SET payload=?,submitted=?,version=version+1 WHERE group_id=? AND member_id=? AND revision=? AND version=?', JSON.stringify(preferences), input.submit ? 1 : 0, groupId, input.memberId, group.revision, input.version);
      check(Number(updated.changes) === 1, 'VERSION_CONFLICT');
      const count = this.one<{ count: number; submitted: number }>('SELECT COUNT(*) AS count,COALESCE(SUM(submitted),0) AS submitted FROM preferences WHERE group_id=? AND revision=?', groupId, group.revision)!;
      if (count.count === group.target_count && count.submitted === group.target_count) {
        const participants = this.all<{ payload: string }>('SELECT p.payload FROM preferences p JOIN members m ON p.group_id=m.group_id AND p.member_id=m.id WHERE p.group_id=? AND p.revision=? ORDER BY m.owner DESC,m.rowid', groupId, group.revision).map((p, index) => ({ id: `member-${index + 1}`, preferences: JSON.parse(p.payload) as PersonPreferences }));
        const request: ClaimedGroupJob['request'] = { sessionId: newId(), mode: 'live', setup: JSON.parse(group.setup), preferences: { participants } };
        const payload = JSON.stringify(request);
        this.run('INSERT INTO planning_snapshots VALUES(?,?,?,?,?)', groupId, group.revision, payload, createHash('sha256').update(payload).digest('hex'), this.now());
        this.enqueue(group, 'plan', 1, payload);
        this.run("UPDATE groups SET state='queued',invite_hash=NULL,invite_expires_at=MIN(invite_expires_at,?),state_version=state_version+1 WHERE id=?", this.now(), groupId);
      }
      const response = this.view(session, groupId);
      this.run('INSERT INTO idempotency VALUES(?,?,?,?,?)', groupId, input.memberId, group.revision, input.idempotencyKey, JSON.stringify(response));
      return response;
    });
  }
  rotateInvite(session: string, groupId: string): { group: GroupView; inviteToken: string } {
    return this.tx(() => {
      const group = this.owner(session, groupId); check(group.state === 'collecting', 'ROUND_FROZEN'); const inviteToken = newToken();
      this.run('UPDATE groups SET invite_hash=?,invite_expires_at=?,state_version=state_version+1 WHERE id=?', digest(inviteToken), Math.min(group.created_at + 7 * DAY, group.expires_at), groupId);
      return { group: this.view(session, groupId), inviteToken };
    });
  }
  removeMember(session: string, groupId: string, memberId: string): GroupView {
    return this.tx(() => {
      const group = this.owner(session, groupId); check(group.state === 'collecting', 'ROUND_FROZEN'); check(memberId !== group.owner_id, 'CANNOT_REMOVE_OWNER');
      check(Number(this.run('DELETE FROM members WHERE group_id=? AND id=?', groupId, memberId).changes) === 1, 'MEMBER_UNAVAILABLE');
      this.run('UPDATE groups SET state_version=state_version+1 WHERE id=?', groupId); return this.view(session, groupId);
    });
  }
  newRound(session: string, groupId: string, setup: PlanSetup, targetCount: number): GroupView {
    return this.tx(() => {
      const group = this.owner(session, groupId); const conditions = this.validateSetup(setup, targetCount);
      const count = this.one<{ count: number }>('SELECT COUNT(*) AS count FROM members WHERE group_id=?', groupId)!.count;
      check(count <= targetCount, 'REMOVE_MEMBERS_FIRST');
      this.run("UPDATE jobs SET state='cancelled',lease=NULL,error='NEW_ROUND' WHERE group_id=? AND state IN ('queued','running')", groupId);
      this.run('INSERT INTO preferences(group_id,member_id,revision,payload,version) SELECT group_id,member_id,revision+1,payload,version+1 FROM preferences WHERE group_id=? AND revision=?', groupId, group.revision);
      // A new invitation must be explicitly issued; a prior round token never reopens.
      this.run("UPDATE groups SET revision=revision+1,state_version=state_version+1,target_count=?,setup=?,state='collecting',invite_hash=NULL,invite_expires_at=MIN(invite_expires_at,?),selected_plan_id=NULL,final_plan_id=NULL,locked_stop_ids='[]',replan_count=0 WHERE id=?", targetCount, JSON.stringify(conditions), this.now(), groupId);
      return this.view(session, groupId);
    });
  }

  private readyOwner(session: string, groupId: string, version: number): GroupRow {
    const group = this.owner(session, groupId);
    check(Number.isInteger(version) && group.state_version === version, 'VERSION_CONFLICT');
    check(group.state === 'ready', 'RESULT_NOT_READY'); return group;
  }
  private storedPlan(group: GroupRow, planId: string): Itinerary {
    const plan = this.currentCandidates(group).find(p => p.id === planId); check(plan, 'PLAN_UNAVAILABLE'); return plan;
  }
  private successfulJobs(group: GroupRow): JobRow[] {
    return this.all<JobRow>("SELECT * FROM jobs WHERE group_id=? AND revision=? AND state='succeeded' ORDER BY rowid", group.id, group.revision);
  }
  /** A successful local adjustment replaces its saved base, preserving the other two alternatives. */
  private currentCandidates(group: GroupRow): Itinerary[] {
    let plans: Itinerary[] = [];
    for (const job of this.successfulJobs(group)) {
      const result = this.jobView(job)!;
      if (job.kind === 'plan') plans = result.plans;
      else {
        const request = JSON.parse(job.request) as ReplanRequest;
        plans = plans.map(plan => plan.id === request.plan.id ? result.plans[0] : plan);
      }
    }
    return plans;
  }
  select(session: string, groupId: string, input: SelectGroupPlan): GroupView {
    return this.tx(() => {
      const group = this.readyOwner(session, groupId, input.version); const plan = this.storedPlan(group, input.planId);
      check(Array.isArray(input.lockedStopIds) && input.lockedStopIds.length <= 10 && new Set(input.lockedStopIds).size === input.lockedStopIds.length && input.lockedStopIds.every(id => plan.stops.some(s => s.id === id)), 'INVALID_LOCKS');
      this.run('UPDATE groups SET selected_plan_id=?,locked_stop_ids=?,state_version=state_version+1 WHERE id=?', plan.id, JSON.stringify(input.lockedStopIds), groupId);
      return this.view(session, groupId);
    });
  }
  replan(session: string, groupId: string, input: ReplanGroup): GroupView {
    return this.tx(() => {
      const group = this.readyOwner(session, groupId, input.version);
      check(group.replan_count < 2 && group.selected_plan_id, 'REPLAN_UNAVAILABLE');
      const plan = this.storedPlan(group, group.selected_plan_id); const lockedStopIds: string[] = JSON.parse(group.locked_stop_ids);
      check(plan.stops.some(stop => stop.id === input.rejectedStopId) && !lockedStopIds.includes(input.rejectedStopId), 'INVALID_REJECTED_STOP');
      const snapshot = this.one<{ payload: string }>('SELECT payload FROM planning_snapshots WHERE group_id=? AND revision=?', groupId, group.revision)!;
      const original = JSON.parse(snapshot.payload) as ClaimedGroupJob['request'];
      const request = ReplanRequestSchema.parse({ sessionId: newId(), plan, lockedStopIds, rejectedStopId: input.rejectedStopId, reason: input.reason, reasonCode: input.reasonCode,
        replanCount: group.replan_count, setup: original.setup, preferences: original.preferences });
      const attempt = this.one<{ attempt: number }>("SELECT COALESCE(MAX(attempt),0)+1 AS attempt FROM jobs WHERE group_id=? AND revision=? AND kind='replan'", groupId, group.revision)!.attempt;
      this.enqueue(group, 'replan', attempt, JSON.stringify(request));
      this.run("UPDATE groups SET state='queued',replan_count=replan_count+1,state_version=state_version+1 WHERE id=?", groupId);
      return this.view(session, groupId);
    });
  }
  finalize(session: string, groupId: string, input: FinalizeGroup): GroupView {
    return this.tx(() => {
      const group = this.readyOwner(session, groupId, input.version); const plan = this.storedPlan(group, input.planId);
      check(group.selected_plan_id === plan.id, 'SELECT_PLAN_FIRST');
      this.run("UPDATE groups SET state='finalized',final_plan_id=?,state_version=state_version+1 WHERE id=?", plan.id, groupId);
      return this.view(session, groupId);
    });
  }

  private latestJob(group: GroupRow): JobRow | undefined {
    return this.one<JobRow>('SELECT * FROM jobs WHERE group_id=? AND revision=? ORDER BY rowid DESC LIMIT 1', group.id, group.revision);
  }
  private jobView(job?: JobRow): GroupJobView | undefined {
    if (!job) return undefined;
    const events = this.all<{ sequence: number; payload: string }>('SELECT sequence,payload FROM events WHERE job_id=? ORDER BY sequence', job.id).map(e => ({ sequence: e.sequence, event: JSON.parse(e.payload) as AgentEvent }));
    return { id: job.id, kind: job.kind, attempt: job.attempt, state: job.state, events,
      plans: events.flatMap(e => e.event.type === 'plan.proposed' ? [e.event.plan] : []), ...(job.result ? { result: JSON.parse(job.result) } : {}), ...(job.error ? { error: job.error } : {}) };
  }
  private enqueue(group: GroupRow, kind: JobRow['kind'], attempt: number, request: string): void {
    this.run('INSERT INTO jobs(id,group_id,revision,kind,attempt,request,created_at) VALUES(?,?,?,?,?,?,?)', newId(), group.id, group.revision, kind, attempt, request, this.now());
  }
  retry(session: string, groupId: string): GroupView {
    return this.tx(() => {
      const group = this.owner(session, groupId); const previous = this.latestJob(group);
      check(group.state === 'failed' && previous?.state === 'failed', 'NOT_RETRYABLE');
      this.enqueue(group, previous.kind, previous.attempt + 1, previous.request);
      this.run("UPDATE groups SET state='queued',state_version=state_version+1 WHERE id=?", groupId); return this.view(session, groupId);
    });
  }
  claimJob(limit = 2): ClaimedGroupJob | undefined {
    return this.tx(() => {
      check(Number.isInteger(limit) && limit >= 1 && limit <= 4, 'INVALID_CONCURRENCY');
      const running = this.one<{ count: number }>("SELECT COUNT(*) AS count FROM jobs j JOIN groups g ON g.id=j.group_id AND g.revision=j.revision WHERE j.state='running' AND g.expires_at>?", this.now())!.count;
      if (running >= limit) return undefined;
      const job = this.one<JobRow>("SELECT j.* FROM jobs j JOIN groups g ON g.id=j.group_id AND g.revision=j.revision WHERE j.state='queued' AND g.expires_at>? ORDER BY j.created_at,j.rowid LIMIT 1", this.now());
      if (!job) return undefined;
      const lease = newToken(); this.run("UPDATE jobs SET state='running',lease=?,started_at=? WHERE id=?", digest(lease), this.now(), job.id);
      this.run("UPDATE groups SET state='running',state_version=state_version+1 WHERE id=?", job.group_id);
      const snapshot = this.one<{ payload: string }>('SELECT payload FROM planning_snapshots WHERE group_id=? AND revision=?', job.group_id, job.revision)!;
      return { id: job.id, groupId: job.group_id, revision: job.revision, kind: job.kind, attempt: job.attempt, lease, request: JSON.parse(snapshot.payload), ...(job.kind === 'replan' ? { replanRequest: JSON.parse(job.request) } : {}) };
    });
  }
  private leased(jobId: string, lease: string): { job: JobRow; group: GroupRow } {
    const job = this.one<JobRow>("SELECT * FROM jobs WHERE id=? AND state='running' AND lease=?", jobId, digest(lease));
    check(job, 'STALE_LEASE'); const group = this.group(job.group_id); check(group.revision === job.revision, 'STALE_LEASE'); return { job, group };
  }
  appendEvent(jobId: string, lease: string, event: AgentEvent): number {
    return this.tx(() => {
      const { job } = this.leased(jobId, lease); const parsed = AgentEventSchema.parse(event);
      const sequence = this.one<{ sequence: number }>('SELECT COALESCE(MAX(sequence),0)+1 AS sequence FROM events WHERE job_id=?', jobId)!.sequence;
      this.run('INSERT INTO events VALUES(?,?,?,?)', job.group_id, jobId, sequence, JSON.stringify(parsed)); return sequence;
    });
  }
  private validateReplacement(plan: Itinerary, diff: PlanDiff, request: ReplanRequest): void {
    const original = request.plan;
    const rejectedIndex = original.stops.findIndex(stop => stop.id === request.rejectedStopId);
    const originalIds = original.stops.map(stop => stop.id);
    const preservedIds = originalIds.filter(id => id !== request.rejectedStopId);
    const sameIds = (actual: string[], expected: string[]) => actual.length === expected.length && new Set(actual).size === actual.length && expected.every(id => actual.includes(id));
    check(rejectedIndex >= 0 && plan.id !== original.id && plan.stops.length === original.stops.length &&
      sameIds(diff.replacedStopIds, [request.rejectedStopId]) && sameIds(diff.preservedStopIds, preservedIds), 'INVALID_REPLAN');
    const replacement = plan.stops[rejectedIndex];
    check(!originalIds.includes(replacement.id) && !original.stops.some(stop => stop.placeId === replacement.placeId), 'INVALID_REPLAN');
    const locked = new Set([...request.lockedStopIds, ...original.stops.filter(stop => stop.locked).map(stop => stop.id)]);
    check(!locked.has(request.rejectedStopId), 'INVALID_REPLAN');
    const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
    const duration = (stop: Itinerary['stops'][number]) => minutes(stop.endTime) - minutes(stop.startTime);
    for (const [index, before] of original.stops.entries()) {
      const after = plan.stops[index];
      check(duration(after) === duration(before), 'INVALID_REPLAN');
      if (index === rejectedIndex) continue;
      const mayShift = Math.abs(index - rejectedIndex) === 1 && !locked.has(before.id);
      // Only immediate unlocked neighbors may change timing; every other field/position is preserved.
      const comparable = mayShift ? { ...after, startTime: before.startTime, endTime: before.endTime } : after;
      check(JSON.stringify(comparable) === JSON.stringify(before), 'INVALID_REPLAN');
    }
    if (plan.stops.length > 1) {
      const route = estimateRoute({ stops: plan.stops, mode: 'mixed' });
      for (const [index, leg] of route.legs.entries()) {
        check(minutes(plan.stops[index + 1].startTime) >= minutes(plan.stops[index].endTime) + leg.durationMinutes, 'INVALID_REPLAN');
      }
    }
  }
  finishJob(jobId: string, lease: string, state: 'succeeded' | 'failed', error?: string): void {
    this.tx(() => {
      const { job, group } = this.leased(jobId, lease); check(state === 'succeeded' || state === 'failed', 'INVALID_JOB_STATE');
      const events = this.jobView(job)!;
      const completed = events.events.filter(e => e.event.type === 'run.completed').at(-1)?.event;
      if (state === 'succeeded') {
        check(completed?.type === 'run.completed', 'INCOMPLETE_RESULT');
        const ids = completed.result.candidateIds;
        check(new Set(ids).size === ids.length && events.plans.length === ids.length && new Set(events.plans.map(p => p.id)).size === ids.length && ids.every(id => events.plans.some(p => p.id === id)) && !!completed.result.diff === (job.kind === 'replan'), 'INCOMPLETE_RESULT');
        const snapshot = this.one<{ payload: string }>('SELECT payload FROM planning_snapshots WHERE group_id=? AND revision=?', job.group_id, job.revision)!;
        const request = JSON.parse(snapshot.payload) as ClaimedGroupJob['request'];
        const replan = job.kind === 'replan' ? JSON.parse(job.request) as ReplanRequest : undefined;
        if (!replan) {
          const combinations = events.plans.map(plan => JSON.stringify([...new Set(plan.stops.map(stop => stop.placeId))].sort()));
          check(new Set(combinations).size === 3, 'INVALID_CANDIDATES');
        } else {
          check(completed.result.diff, 'INVALID_REPLAN');
          this.validateReplacement(events.plans[0], completed.result.diff, replan);
          const current = this.currentCandidates(group);
          check(current.length === 3 && JSON.stringify(current.find(plan => plan.id === replan.plan.id)) === JSON.stringify(replan.plan), 'INVALID_REPLAN');
          const priorIds = this.successfulJobs(group).flatMap(previous => this.jobView(previous)!.plans.map(plan => plan.id));
          check(!priorIds.includes(events.plans[0].id), 'INVALID_REPLAN');
        }
        for (const plan of events.plans) {
          const venues = plan.stops.map(stop => shanghaiPlaces.find(place => place.placeId === stop.placeId));
          check(venues.every(Boolean), 'INVALID_PLAN');
          const participantCount = request.preferences.participants.length;
          const items: CalculateBudgetInput['items'] = [];
          for (const [index, venue] of venues.entries()) {
            check(venue, 'INVALID_PLAN');
            const stop = plan.stops[index];
            check(stop.cost === venue.priceRange.max * participantCount && stop.latitude === venue.latitude && stop.longitude === venue.longitude, 'INVALID_PLAN');
            items.push({ category: venue.category, label: venue.name, unitPrice: venue.priceRange.max, quantity: participantCount });
          }
          const route = plan.stops.length > 1 ? estimateRoute({ stops: plan.stops, mode: 'mixed' }) : { legs: [], totalDistanceKm: 0 };
          const legs = route.legs;
          for (const leg of legs) if (leg.mode === 'transit') items.push({ category: 'transport', label: '交通预算', unitPrice: 4, quantity: participantCount });
          const cost = calculateBudget({ items, budgetLimit: request.setup.budget, bufferRate: 0.1 });
          check(plan.totalCost === cost.total && plan.totalDistanceKm === route.totalDistanceKm && cost.withinBudget, 'INVALID_PLAN');
          const walkingDistanceKm = legs.filter(leg => leg.mode === 'walking').reduce((sum, leg) => sum + leg.distanceKm, 0);
          check(new Set(plan.stops.map(s => s.id)).size === plan.stops.length && validatePlan({ plan, setup: request.setup, preferences: request.preferences, places: shanghaiPlaces,
            walkingDistanceKm, lockedStopIds: replan?.lockedStopIds ?? [], originalPlan: replan?.plan }).valid, 'INVALID_PLAN');
        }
      }
      if (error !== undefined) check(/^[A-Z0-9_]{1,80}$/.test(error), 'INVALID_ERROR_CODE');
      this.run('UPDATE jobs SET state=?,lease=NULL,error=?,result=? WHERE id=?', state, state === 'failed' ? error ?? 'PLANNING_FAILED' : null, state === 'succeeded' && completed?.type === 'run.completed' ? JSON.stringify(completed.result) : null, jobId);
      if (state === 'succeeded' && job.kind === 'replan' && completed?.type === 'run.completed') {
        this.run("UPDATE groups SET state='ready',selected_plan_id=?,state_version=state_version+1 WHERE id=?", completed.result.candidateIds[0], job.group_id);
      } else {
        this.run('UPDATE groups SET state=?,state_version=state_version+1 WHERE id=?', state === 'succeeded' ? 'ready' : 'failed', job.group_id);
      }
    });
  }
  recoverInterrupted(): number {
    return this.tx(() => {
      this.run("UPDATE groups SET state='failed',state_version=state_version+1 WHERE expires_at>? AND EXISTS(SELECT 1 FROM jobs j WHERE j.group_id=groups.id AND j.revision=groups.revision AND j.state='running')", this.now());
      return Number(this.run("UPDATE jobs SET state='failed',lease=NULL,error='INTERRUPTED' WHERE state='running'").changes);
    });
  }
  cleanup(): number { return this.tx(() => Number(this.run('DELETE FROM groups WHERE expires_at<=?', this.now()).changes)); }
}
