// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GroupRepository } from './repository';
import { runPlanningAgent } from '../../netlify/functions/agent/orchestrator';
import type { PersonPreferences, PlanSetup, Itinerary } from '../../src/contracts/agent';

const setup: PlanSetup = { city: '上海', date: '2026-11-14', startTime: '13:00', endTime: '20:00', budget: 300, startingArea: '徐汇' };
const preferences: PersonPreferences = { interests: ['咖啡'], pace: '平衡', walkingLimitKm: 3, indoorPreference: '均可', foodTags: [], budgetStyle: '平衡', avoid: [], wish: 'private wish' };
const roots: string[] = [];
const repos: GroupRepository[] = [];
function database(now?: () => number) {
  const root = mkdtempSync(join(tmpdir(), 'group-repository-')); roots.push(root);
  const path = join(root, 'groups.sqlite');
  const repo = new GroupRepository({ path, now }); repos.push(repo);
  return { repo, path };
}
function pair(repo: GroupRepository) {
  const a = repo.create('a', '周末', '甲', 2, setup);
  const b = repo.join('b', a.inviteToken, '乙');
  return { a, b };
}
function submit(repo: GroupRepository, session: string, groupId: string, memberId: string, key = session, version = 0) {
  return repo.save(session, groupId, { memberId, version, preferences, submit: true, idempotencyKey: key });
}
function queued(repo: GroupRepository) {
  const { a, b } = pair(repo);
  submit(repo, 'a', a.group.id, a.memberId);
  submit(repo, 'b', a.group.id, b.memberId);
  return { a, b };
}
function plan(id: string): Itinerary {
  return { id, title: '书城', summary: '看书', matchScore: 80, totalCost: 0, totalDistanceKm: 0, indoorRatio: 100, transfers: 0, reasons: ['阅读'],
    stops: [{ id: 'stop-1', placeId: 'shanghai-book-city', name: '书城', area: '黄浦', startTime: '14:00', endTime: '16:00', cost: 0, latitude: 31.2312, longitude: 121.4809, tags: ['阅读'], locked: false }] };
}
function complete(repo: GroupRepository, job: NonNullable<ReturnType<GroupRepository['claimJob']>>, ids = ['plan-1', 'plan-2', 'plan-3']) {
  for (const id of ids) repo.appendEvent(job.id, job.lease, { type: 'plan.proposed', plan: plan(id) });
  repo.appendEvent(job.id, job.lease, { type: 'run.completed', result: { runId: job.id, consensus: { shared: [], conflicts: [], constraints: [] }, candidateIds: ids,
    ...(job.kind === 'replan' ? { diff: { replacedStopIds: ['stop-1'], preservedStopIds: [], summary: '调整' } } : {}) } });
  repo.finishJob(job.id, job.lease, 'succeeded');
}
afterEach(() => { for (const repo of repos.splice(0)) repo.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('group capability isolation and submissions', () => {
  it('denies outsiders, cross-member writes and owner access to another raw draft', () => {
    const { repo } = database(); const { a, b } = pair(repo);
    expect(() => repo.view('c', a.group.id)).toThrow();
    expect(() => submit(repo, 'a', a.group.id, b.memberId)).toThrow();
    submit(repo, 'b', a.group.id, b.memberId);
    expect(repo.view('a', a.group.id).myMembers.map(m => m.id)).toEqual([a.memberId]);
    expect(JSON.stringify(repo.view('a', a.group.id))).not.toContain('private wish');
    const other = repo.create('c', '其他组', '丙', 2, setup);
    expect(() => submit(repo, 'b', other.group.id, b.memberId)).toThrow();
  });
  it('restores an existing browser, supports explicit blank handoff and enforces capacity', () => {
    const { repo } = database(); const a = repo.create('a', '周末', '甲', 3, setup);
    const b = repo.join('b', a.inviteToken, '乙');
    expect(repo.join('b', a.inviteToken, 'ignored').memberId).toBe(b.memberId);
    const c = repo.join('b', a.inviteToken, '丙', { handoff: true });
    expect(c.memberId).not.toBe(b.memberId);
    expect(c.group.myMembers.find(m => m.id === c.memberId)?.preferences).toBeUndefined();
    expect(() => repo.join('d', a.inviteToken, '丁')).toThrow();
  });
  it.each([2, 6])('freezes exactly %i participants and queues one job despite duplicate submit', target => {
    const { repo } = database(); const a = repo.create('a', '周末', '甲', target, { ...setup, budget: target * 2000 });
    const members = [{ session: 'a', memberId: a.memberId }];
    for (let i = 1; i < target; i++) members.push({ session: `s${i}`, memberId: repo.join(`s${i}`, a.inviteToken, `人${i}`).memberId });
    for (const m of members.slice(0, -1)) submit(repo, m.session, a.group.id, m.memberId);
    expect(repo.claimJob()).toBeUndefined();
    const last = members.at(-1)!; const result = submit(repo, last.session, a.group.id, last.memberId);
    expect(submit(repo, last.session, a.group.id, last.memberId).job?.id).toBe(result.job?.id);
    const job = repo.claimJob()!;
    expect(job.request.preferences.participants).toHaveLength(target);
    expect(JSON.stringify(job.request)).not.toContain('甲');
    expect(repo.claimJob()).toBeUndefined();
    expect(() => repo.join('new', a.inviteToken, '新人')).toThrow();
  });
  it('requires target occupancy and checks own edit versions and stale idempotent retries', () => {
    const { repo } = database(); const a = repo.create('a', '周末', '甲', 2, setup);
    submit(repo, 'a', a.group.id, a.memberId, 'first');
    expect(repo.claimJob()).toBeUndefined();
    repo.save('a', a.group.id, { memberId: a.memberId, version: 1, preferences: { ...preferences, wish: 'edited' }, submit: false, idempotencyKey: 'edit' });
    expect(() => submit(repo, 'a', a.group.id, a.memberId, 'stale', 0)).toThrow();
    submit(repo, 'a', a.group.id, a.memberId, 'first');
    expect(repo.view('a', a.group.id).myMembers[0].preferences?.wish).toBe('edited');
    expect(repo.view('a', a.group.id).myMembers[0].submitted).toBe(false);
  });
  it('separates invite/member/owner recovery and revokes removed-member capabilities', () => {
    const { repo } = database(); const { a, b } = pair(repo);
    expect(() => repo.recover('c', a.inviteToken)).toThrow();
    expect(repo.recover('c', b.memberRecoveryToken!).myMembers[0].id).toBe(b.memberId);
    expect(() => repo.rotateInvite('c', a.group.id)).toThrow();
    const owner = repo.recover('owner', a.ownerRecoveryToken);
    expect(owner.myMembers).toHaveLength(0);
    repo.rotateInvite('owner', a.group.id);
    repo.removeMember('owner', a.group.id, b.memberId);
    expect(() => repo.view('b', a.group.id)).toThrow();
    expect(() => repo.recover('c', b.memberRecoveryToken!)).toThrow();
  });
  it('rotates invites, expires them in seven days, and expires/cleans groups in thirty days', () => {
    let time = 1000; const { repo } = database(() => time);
    const a = repo.create('a', '周末', '甲', 2, setup);
    const rotated = repo.rotateInvite('a', a.group.id);
    expect(() => repo.join('b', a.inviteToken, '乙')).toThrow();
    time += 7 * 86400000;
    expect(() => repo.join('b', rotated.inviteToken, '乙')).toThrow();
    expect(repo.view('a', a.group.id).members).toHaveLength(1);
    time += 23 * 86400000;
    expect(() => repo.view('a', a.group.id)).toThrow();
    expect(repo.list('a')).toEqual([]);
    expect(repo.cleanup()).toBe(1);
  });
  it('validates人数/budget boundaries server-side and rejects malformed drafts', () => {
    const { repo } = database();
    for (const count of [1, 7, 2.5]) expect(() => repo.create('a', '组', '人', count, setup)).toThrow();
    expect(() => repo.create('a', '组', '人', 2, { ...setup, budget: 4001 })).toThrow();
    const a = repo.create('a', '组', '人', 2, setup);
    expect(() => repo.save('a', a.group.id, { memberId: a.memberId, version: 0, preferences: { ...preferences, walkingLimitKm: 100 } as unknown as PersonPreferences, submit: true, idempotencyKey: 'bad' })).toThrow();
  });
});

describe('persistent queue, rounds and fenced ownership', () => {
  it('persists frozen snapshots, marks interrupted work failed and rejects stale leases', () => {
    const { repo, path } = database(); const { a } = queued(repo); const job = repo.claimJob()!;
    repo.close(); const restarted = new GroupRepository({ path }); repos.push(restarted);
    expect(restarted.recoverInterrupted()).toBe(1);
    expect(() => restarted.appendEvent(job.id, job.lease, { type: 'step.started', step: 'ANALYZE', at: new Date().toISOString() })).toThrow();
    restarted.retry('a', a.group.id);
    const next = restarted.claimJob()!;
    expect(next.attempt).toBe(2); expect(next.request).toEqual(job.request);
    expect(() => restarted.finishJob(job.id, job.lease, 'succeeded')).toThrow();
    restarted.finishJob(next.id, next.lease, 'failed', 'UPSTREAM_FAILED');
    expect(restarted.view('a', a.group.id).job?.error).toBe('UPSTREAM_FAILED');
  });
  it('keeps queued work across restart and caps simultaneous claims at two', () => {
    const { repo, path } = database(); queued(repo); queued(repo); queued(repo); repo.close();
    const restarted = new GroupRepository({ path }); repos.push(restarted);
    expect(restarted.recoverInterrupted()).toBe(0);
    const first = restarted.claimJob()!; expect(restarted.claimJob()).toBeDefined(); expect(restarted.claimJob()).toBeUndefined();
    restarted.finishJob(first.id, first.lease, 'failed', 'FAILED'); expect(restarted.claimJob()).toBeDefined();
  });
  it('enforces a configurable atomic worker capacity between one and four', () => {
    const { repo } = database(); for (let i = 0; i < 5; i++) queued(repo);
    expect(() => repo.claimJob(0)).toThrow(); expect(() => repo.claimJob(5)).toThrow();
    const first = repo.claimJob(1)!; expect(repo.claimJob(1)).toBeUndefined(); repo.finishJob(first.id, first.lease, 'failed');
    for (let i = 0; i < 4; i++) expect(repo.claimJob(4)).toBeDefined(); expect(repo.claimJob(4)).toBeUndefined();
  });
  it('starts a fresh round, requires resubmission and fences late old results', () => {
    const { repo } = database(); const { a } = queued(repo); const old = repo.claimJob()!;
    const round = repo.newRound('a', a.group.id, { ...setup, budget: 600 }, 3);
    expect(round.revision).toBe(2); expect(round.members.every(m => !m.submitted)).toBe(true);
    expect(round.myMembers[0].preferences?.wish).toBe('private wish');
    expect(() => repo.finishJob(old.id, old.lease, 'failed', 'LATE')).toThrow();
    expect(old.request.setup.budget).toBe(300);
    expect(() => repo.newRound('a', a.group.id, setup, 1)).toThrow();
  });
  it('stores no raw capabilities on disk', () => {
    const { repo, path } = database(); const a = repo.create('raw-browser-secret', '组', '甲', 2, setup); repo.close();
    const content = readFileSync(path).toString('utf8');
    for (const token of [a.inviteToken, a.memberRecoveryToken, a.ownerRecoveryToken, 'raw-browser-secret']) expect(content).not.toContain(token);
  });
  it('makes a consistent pre-migration backup containing committed WAL data and preserves old tables', () => {
    const { path, repo } = database(); repo.close();
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
    const legacyRoot = mkdtempSync(join(tmpdir(), 'group-legacy-')); roots.push(legacyRoot); const legacyPath = join(legacyRoot, 'groups.sqlite');
    const legacy = new DatabaseSync(legacyPath); legacy.exec("PRAGMA journal_mode=WAL; CREATE TABLE old_data(value TEXT); INSERT INTO old_data VALUES('committed WAL');");
    const migrated = new GroupRepository({ path: legacyPath }); repos.push(migrated);
    const { readdirSync } = createRequire(import.meta.url)('node:fs') as typeof import('node:fs');
    const backups = readdirSync(legacyRoot).filter(f => f.endsWith('.bak')); expect(backups).toHaveLength(1);
    const backup = new DatabaseSync(join(legacyRoot, backups[0]));
    expect(backup.prepare('SELECT value FROM old_data').get()).toEqual({ value: 'committed WAL' }); backup.close();
    expect(legacy.prepare('SELECT value FROM old_data').get()).toEqual({ value: 'committed WAL' }); legacy.close();
    expect(readFileSync(path).length).toBeGreaterThan(0);
  });
  it('serializes two connections final submissions and exposes a single immutable job', () => {
    const { repo, path } = database(); const { a, b } = pair(repo); const second = new GroupRepository({ path }); repos.push(second);
    submit(repo, 'a', a.group.id, a.memberId); submit(second, 'b', a.group.id, b.memberId);
    expect(submit(repo, 'b', a.group.id, b.memberId).job?.id).toBe(second.view('b', a.group.id).job?.id);
    expect(repo.claimJob()).toBeDefined(); expect(second.claimJob()).toBeUndefined();
  });
  it('does not replay another handoff member raw answers through a recovered member idempotency key', () => {
    const { repo } = database(); const a = repo.create('a', '组', '甲', 2, setup); const b = repo.join('a', a.inviteToken, '乙', { handoff: true });
    submit(repo, 'a', a.group.id, a.memberId, 'owner-save'); const saved = submit(repo, 'a', a.group.id, b.memberId, 'member-save');
    expect(saved.myMembers).toHaveLength(2);
    repo.recover('new-browser', b.memberRecoveryToken!);
    const replay = submit(repo, 'new-browser', a.group.id, b.memberId, 'member-save');
    expect(replay.canManage).toBe(false); expect(replay.myMembers.map(m => m.id)).toEqual([b.memberId]);
  });
  it('expires worker leases when a group expires and removes all associated rows', () => {
    let now = 1000; const { repo, path } = database(() => now); queued(repo); const job = repo.claimJob()!; now += 30 * 86400000;
    expect(() => repo.appendEvent(job.id, job.lease, { type: 'step.started', step: 'ANALYZE', at: new Date().toISOString() })).toThrow();
    expect(repo.cleanup()).toBe(1);
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite'); const inspection = new DatabaseSync(path);
    for (const table of ['members', 'preferences', 'jobs', 'events', 'planning_snapshots', 'access_grants', 'recovery_capabilities', 'idempotency']) expect(inspection.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 }); inspection.close();
  });
  it('enforces snapshot immutability and composite member/job group ownership in SQLite', () => {
    const { repo, path } = database(); const { a, b } = queued(repo); const other = repo.create('other', '其他', '丙', 2, setup); const job = repo.claimJob()!;
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite'); const db = new DatabaseSync(path); db.exec('PRAGMA foreign_keys=ON');
    try {
      expect(() => db.prepare("UPDATE planning_snapshots SET payload='{}' WHERE group_id=?").run(a.group.id)).toThrow();
      expect(() => db.prepare('INSERT INTO preferences(group_id,member_id,revision) VALUES(?,?,1)').run(other.group.id, b.memberId)).toThrow();
      expect(() => db.prepare("INSERT INTO access_grants VALUES('bad-grant','session',?,?,'member',9999999999999)").run(other.group.id, b.memberId)).toThrow();
      expect(() => db.prepare("INSERT INTO events VALUES(?,?,1,'{}')").run(other.group.id, job.id)).toThrow();
    } finally { db.close(); }
  });
});

describe('owner selection, replan and finalization', () => {
  it('accepts the actual Agent fallback event stream and persists its honest degraded source', async () => {
    const { repo } = database(); const { a } = queued(repo); const job = repo.claimJob()!;
    const events = await runPlanningAgent(job.request, { onEvent: event => repo.appendEvent(job.id, job.lease, event) });
    expect(events.at(-1)?.type).toBe('run.completed');
    repo.finishJob(job.id, job.lease, 'succeeded');
    const view = repo.view('a', a.group.id);
    expect(view.state).toBe('ready'); expect(view.job?.plans).toHaveLength(3);
    expect(view.job?.events.some(row => row.event.type === 'run.degraded' && row.event.fallback === 'rule-planner')).toBe(true);
  });
  it('rejects foreign plan IDs, duplicate/unknown locks, stale versions and member management', () => {
    const { repo } = database(); const { a } = queued(repo); complete(repo, repo.claimJob()!);
    const view = repo.view('a', a.group.id);
    expect(() => repo.select('b', a.group.id, { version: view.stateVersion, planId: 'plan-1', lockedStopIds: [] })).toThrow();
    for (const lockedStopIds of [['missing'], ['stop-1', 'stop-1']]) expect(() => repo.select('a', a.group.id, { version: view.stateVersion, planId: 'plan-1', lockedStopIds })).toThrow();
    expect(() => repo.select('a', a.group.id, { version: view.stateVersion, planId: 'foreign', lockedStopIds: [] })).toThrow();
    const selected = repo.select('a', a.group.id, { version: view.stateVersion, planId: 'plan-1', lockedStopIds: ['stop-1'] });
    expect(selected.selectedPlanId).toBe('plan-1'); expect(selected.lockedStopIds).toEqual(['stop-1']);
    expect(() => repo.finalize('a', a.group.id, { version: view.stateVersion, planId: 'plan-1' })).toThrow();
    const final = repo.finalize('a', a.group.id, { version: selected.stateVersion, planId: 'plan-1' });
    expect(final.state).toBe('finalized'); expect(repo.view('b', a.group.id).finalPlanId).toBe('plan-1');
    expect(() => repo.select('a', a.group.id, { version: final.stateVersion, planId: 'plan-2', lockedStopIds: [] })).toThrow();
  });
  it('derives a persistent replan from original participants and owner selection, retrying same request', () => {
    const { repo, path } = database(); const { a } = queued(repo); complete(repo, repo.claimJob()!);
    let view = repo.view('a', a.group.id); view = repo.select('a', a.group.id, { version: view.stateVersion, planId: 'plan-2', lockedStopIds: ['stop-1'] });
    expect(() => repo.replan('a', a.group.id, { version: view.stateVersion, rejectedStopId: 'stop-1', reason: '换一个' })).toThrow();
    view = repo.select('a', a.group.id, { version: view.stateVersion, planId: 'plan-2', lockedStopIds: [] });
    expect(() => repo.replan('b', a.group.id, { version: view.stateVersion, rejectedStopId: 'stop-1', reason: '换一个' })).toThrow();
    const pending = repo.replan('a', a.group.id, { version: view.stateVersion, rejectedStopId: 'stop-1', reason: '换一个', reasonCode: 'CHANGE_PLACE' });
    expect(pending.state).toBe('queued'); repo.close(); const resumed = new GroupRepository({ path }); repos.push(resumed);
    const job = resumed.claimJob()!;
    expect(job.kind).toBe('replan'); expect(job.replanRequest?.plan.id).toBe('plan-2');
    expect(job.replanRequest?.preferences.participants).toHaveLength(2);
    expect(job.replanRequest?.lockedStopIds).toEqual([]); expect(job.replanRequest?.replanCount).toBe(0);
    expect(() => resumed.finalize('a', a.group.id, { version: pending.stateVersion, planId: 'plan-2' })).toThrow();
    resumed.finishJob(job.id, job.lease, 'failed', 'REPLAN_FAILED'); resumed.retry('a', a.group.id); const retry = resumed.claimJob()!;
    expect(retry.attempt).toBe(2); expect(retry.replanRequest).toEqual(job.replanRequest);
    complete(resumed, retry, ['plan-revised']);
    const ready = resumed.view('a', a.group.id); expect(ready.replanCount).toBe(1); expect(ready.selectedPlanId).toBe('plan-revised');
    expect(() => resumed.replan('a', a.group.id, { version: ready.stateVersion, rejectedStopId: 'stop-1', reason: '再改' })).toThrow();
    expect(() => resumed.finalize('a', a.group.id, { version: ready.stateVersion, planId: 'plan-2' })).toThrow();
    expect(resumed.finalize('a', a.group.id, { version: ready.stateVersion, planId: 'plan-revised' }).state).toBe('finalized');
  });
  it('refuses success without the correct candidate set and prevents illegal stored plan finalization', () => {
    const { repo } = database(); queued(repo); const job = repo.claimJob()!;
    expect(() => repo.finishJob(job.id, job.lease, 'succeeded')).toThrow();
    repo.appendEvent(job.id, job.lease, { type: 'plan.proposed', plan: { ...plan('invalid'), totalCost: 999 } });
    repo.appendEvent(job.id, job.lease, { type: 'run.completed', result: { runId: job.id, consensus: { shared: [], conflicts: [], constraints: [] }, candidateIds: ['invalid', 'invalid', 'invalid'] } });
    expect(() => repo.finishJob(job.id, job.lease, 'succeeded')).toThrow();
  });
  it('rejects underreported catalog prices even when the claimed total fits the group budget', () => {
    const { repo } = database(); queued(repo); const job = repo.claimJob()!;
    for (const id of ['p1', 'p2', 'p3']) repo.appendEvent(job.id, job.lease, { type: 'plan.proposed', plan: { ...plan(id),
      stops: [{ ...plan(id).stops[0], placeId: 'west-bund-museum', latitude: 31.1744, longitude: 121.4605, cost: 0 }] } });
    repo.appendEvent(job.id, job.lease, { type: 'run.completed', result: { runId: job.id, consensus: { shared: [], conflicts: [], constraints: [] }, candidateIds: ['p1', 'p2', 'p3'] } });
    expect(() => repo.finishJob(job.id, job.lease, 'succeeded')).toThrow();
  });
});
