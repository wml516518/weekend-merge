// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GroupRepository } from './repository';
import { GroupWorker, createDefaultGroupRunner, type GroupRunner } from './worker';
import type { AgentEvent, Itinerary } from '../../src/contracts/agent';
import type { ClaimedGroupJob } from '../../src/contracts/groups';
import { shanghaiPlaces } from '../../netlify/functions/agent/tools/places';

const instant = Date.parse('2026-11-14T01:00:00Z');
const setup = { city: '上海', date: '2026-11-15', startTime: '13:00', endTime: '20:00', budget: 300, startingArea: '徐汇' };
const preferences = { interests: ['咖啡'], pace: '平衡' as const, walkingLimitKm: 3, indoorPreference: '均可' as const, foodTags: [], budgetStyle: '平衡' as const, avoid: [], wish: 'secret' };
const cleanups: (() => Promise<void> | void)[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'group-worker-')); const path = join(root, 'groups.sqlite');
  const repo = new GroupRepository({ path, now: () => instant });
  cleanups.push(() => { repo.close(); rmSync(root, { recursive: true, force: true }); });
  return { repo, path };
}
function queue(repo: GroupRepository, suffix: string) {
  const a = repo.create(`owner-${suffix}`, suffix, '甲', 2, setup); const b = repo.join(`member-${suffix}`, a.inviteToken, '乙');
  for (const [session, memberId] of [[`owner-${suffix}`, a.memberId], [`member-${suffix}`, b.memberId]]) repo.save(session, a.group.id, { memberId, version: 0, preferences: { ...preferences, wish: suffix }, submit: true, idempotencyKey: suffix });
  return a;
}
function plans(prefix: string): Itinerary[] {
  return ['shanghai-book-city', 'shanghai-museum-east', 'fuxing-park'].map((venue, i) => {
    const place = shanghaiPlaces.find(p => p.placeId === venue)!;
    return { id: `${prefix}-${i}`, title: place.name, summary: '周末', matchScore: 80, totalCost: place.priceRange.max * 2 * 1.1, totalDistanceKm: 0, indoorRatio: place.indoor ? 100 : 0, transfers: 0, reasons: ['阅读'], stops: [{ id: 'stop-1', placeId: place.placeId, name: place.name, area: place.area, startTime: '14:00', endTime: '16:00', cost: place.priceRange.max * 2, latitude: place.latitude, longitude: place.longitude, tags: place.tags, locked: false }] };
  });
}
function completion(job: ClaimedGroupJob, emit: (event: AgentEvent) => void) {
  const candidates = plans(job.groupId);
  for (const plan of candidates) emit({ type: 'plan.proposed', plan });
  emit({ type: 'run.completed', result: { runId: job.id, consensus: { shared: [], conflicts: [], constraints: [] }, candidateIds: candidates.map(p => p.id) } });
}
function controlled() {
  const started: ClaimedGroupJob[] = []; const releases: (() => void)[] = [];
  const run: GroupRunner = async (job, emit) => {
    started.push(job); emit({ type: 'run.started', runId: job.id, at: new Date(instant).toISOString() });
    await new Promise<void>(resolve => releases.push(resolve)); completion(job, emit);
  };
  return { run, started, releases };
}
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

describe('durable bounded group worker', () => {
  it('claims two separate immutable snapshots, leaves the third queued, and persists isolated results', async () => {
    const { repo } = fixture(); const a = queue(repo, 'a'); const b = queue(repo, 'b'); const c = queue(repo, 'c');
    const control = controlled(); const worker = new GroupWorker(repo, { run: control.run });
    await Promise.all([worker.tick(), worker.tick()]);
    expect(control.started.map(j => j.groupId)).toEqual([a.group.id, b.group.id]);
    expect(control.started[0].request.preferences).not.toEqual(control.started[1].request.preferences);
    expect(Object.isFrozen(control.started[0].request.preferences.participants[0].preferences)).toBe(true);
    expect(repo.view('owner-c', c.group.id).state).toBe('queued');
    expect(repo.view('owner-a', a.group.id).job?.events[0].event).toMatchObject({ type: 'run.started', runId: control.started[0].id });
    const draining = worker.stop(); for (const release of control.releases) release(); await draining;
    expect(repo.view('owner-a', a.group.id).state).toBe('ready');
    expect(repo.view('owner-b', b.group.id).candidates.map(p => p.id)).toEqual([`${b.group.id}-0`, `${b.group.id}-1`, `${b.group.id}-2`]);
    expect(repo.view('owner-c', c.group.id).state).toBe('queued');
  });
  it('recovers interrupted jobs only at first start and resumes queued work', async () => {
    const { repo } = fixture(); const a = queue(repo, 'a'); const b = queue(repo, 'b'); const interrupted = repo.claimJob()!;
    const control = controlled(); const worker = new GroupWorker(repo, { run: control.run });
    worker.start(); worker.start(); await worker.tick();
    expect(repo.view('owner-a', a.group.id).job).toMatchObject({ state: 'failed', error: 'INTERRUPTED' });
    expect(repo.view('owner-b', b.group.id).state).toBe('running'); expect(control.started).toHaveLength(1);
    expect(() => repo.appendEvent(interrupted.id, interrupted.lease, { type: 'run.started', runId: 'stale', at: new Date(instant).toISOString() })).toThrow();
    const draining = worker.stop(); control.releases[0](); await draining;
    repo.retry('owner-a', a.group.id); const restarted = new GroupWorker(repo, { run: async (job, emit) => completion(job, emit) });
    restarted.start(); await restarted.stop();
    expect(repo.view('owner-a', a.group.id).state).toBe('ready');
    expect(repo.view('owner-a', a.group.id).job?.attempt).toBe(2);
  });
  it('rejects late results after new round and keeps stale lease failures isolated', async () => {
    const { repo } = fixture(); const a = queue(repo, 'a'); const control = controlled(); const worker = new GroupWorker(repo, { run: control.run });
    await worker.tick(); repo.newRound('owner-a', a.group.id, setup, 2);
    const draining = worker.stop(); control.releases[0](); await draining;
    expect(repo.view('owner-a', a.group.id)).toMatchObject({ revision: 2, state: 'collecting', candidates: [] });
    expect(repo.view('owner-a', a.group.id).job).toBeUndefined();
  });
  it('fails malformed/unterminated results safely without leaking external exception text', async () => {
    const { repo } = fixture(); const a = queue(repo, 'a');
    const worker = new GroupWorker(repo, { run: async () => { throw new Error('private token and preferences'); } });
    await worker.tick(); await worker.stop();
    expect(repo.view('owner-a', a.group.id).job).toMatchObject({ state: 'failed', error: 'PLANNING_FAILED' });
    expect(JSON.stringify(repo.view('owner-a', a.group.id))).not.toContain('private token');
    repo.retry('owner-a', a.group.id);
    const empty = new GroupWorker(repo, { run: async () => {} }); await empty.tick(); await empty.stop();
    expect(repo.view('owner-a', a.group.id).state).toBe('failed');
  });
  it('sanitizes failure/degradation messages and validates emitted events before persistence', async () => {
    const { repo } = fixture(); const a = queue(repo, 'a');
    const worker = new GroupWorker(repo, { run: async (_job, emit) => {
      emit({ type: 'run.degraded', reason: 'https://key:secret@example', fallback: 'private contents' });
      emit({ type: 'run.failed', code: 'SECRET! token', message: 'private token' });
    } });
    await worker.tick(); await worker.stop();
    const view = repo.view('owner-a', a.group.id); expect(view.state).toBe('failed');
    const text = JSON.stringify(view); expect(text).not.toContain('private contents'); expect(text).not.toContain('private token'); expect(text).not.toContain('key:secret');
    expect(view.job?.events[0].event).toMatchObject({ type: 'run.degraded', fallback: 'rule-planner' });
  });
  it('rejects invalid concurrency before claiming work', () => {
    const { repo } = fixture();
    for (const concurrency of [0, 5, 1.5]) expect(() => new GroupWorker(repo, { concurrency })).toThrow();
  });
  it('uses a fresh model adapter per default initial run and persists truthful rule fallback', async () => {
    const { repo } = fixture(); const a = queue(repo, 'a'); const b = queue(repo, 'b'); let models = 0;
    const run = createDefaultGroupRunner({ now: () => new Date(instant), env: { DEEPSEEK_API_KEY: 'test-only' }, createModel: () => { models++; return { next: async () => { throw new Error('controlled unavailable upstream'); } }; } });
    const worker = new GroupWorker(repo, { run }); await worker.tick(); await worker.stop();
    expect(models).toBe(2);
    for (const [session, id] of [['owner-a', a.group.id], ['owner-b', b.group.id]]) {
      const view = repo.view(session, id); expect(view.state).toBe('ready'); expect(view.candidates).toHaveLength(3);
      expect(view.job?.events.some(e => e.event.type === 'run.degraded')).toBe(true);
    }
  });
  it('runs replan from the stored selected plan and frozen preferences using the real local handler', async () => {
    const { repo } = fixture(); const a = queue(repo, 'a');
    let worker = new GroupWorker(repo, { run: async (job, emit) => completion(job, emit) }); await worker.tick(); await worker.stop();
    let view = repo.view('owner-a', a.group.id); view = repo.select('owner-a', a.group.id, { version: view.stateVersion, planId: view.candidates[0].id, lockedStopIds: [] });
    repo.replan('owner-a', a.group.id, { version: view.stateVersion, rejectedStopId: 'stop-1', reason: '换个地方', reasonCode: 'CHANGE_PLACE' });
    worker = new GroupWorker(repo, { run: createDefaultGroupRunner({ now: () => new Date(instant), env: {} }) }); await worker.tick(); await worker.stop();
    const result = repo.view('owner-a', a.group.id); expect(result.state).toBe('ready'); expect(result.replanCount).toBe(1);
    expect(result.candidates).toHaveLength(3); expect(result.selectedPlanId).not.toBe(view.selectedPlanId);
  });
  it('replenishes a free slot automatically without interrupting the other running group', async () => {
    const { repo } = fixture(); queue(repo, 'a'); queue(repo, 'b'); const c = queue(repo, 'c');
    const control = controlled(); let notify!: () => void; const third = new Promise<void>(resolve => { notify = resolve; });
    const worker = new GroupWorker(repo, { run: async (job, emit) => { const running = control.run(job, emit); if (control.started.length === 3) notify(); await running; } });
    worker.start(); await worker.tick(); control.releases[0](); await third;
    expect(control.started[2].groupId).toBe(c.group.id); expect(repo.view('owner-b', control.started[1].groupId).state).toBe('running');
    const drain = worker.stop(); control.releases[1](); control.releases[2](); await drain;
  });
  it('recovers actual reopened SQLite interrupted work and resumes its immutable retry', async () => {
    const { repo, path } = fixture(); const a = queue(repo, 'a'); const original = repo.claimJob()!; repo.close();
    const reopened = new GroupRepository({ path, now: () => instant }); cleanups.push(() => reopened.close());
    let worker = new GroupWorker(reopened, { run: async (job, emit) => completion(job, emit) }); worker.start(); await worker.stop();
    expect(reopened.view('owner-a', a.group.id).job?.error).toBe('INTERRUPTED');
    reopened.retry('owner-a', a.group.id); let saved: ClaimedGroupJob | undefined;
    worker = new GroupWorker(reopened, { run: async (job, emit) => { saved = job; completion(job, emit); } }); worker.start(); await worker.stop();
    expect(saved!.request).toEqual(original.request); expect(reopened.view('owner-a', a.group.id).state).toBe('ready');
  });
  it('rejects old queued dates before constructing an upstream model adapter', async () => {
    const { repo } = fixture(); const a = queue(repo, 'a'); let models = 0;
    const worker = new GroupWorker(repo, { run: createDefaultGroupRunner({ now: () => new Date('2026-11-16T01:00:00Z'), env: { DEEPSEEK_API_KEY: 'test-only' }, createModel: () => { models++; throw new Error('must not run'); } }) });
    await worker.tick(); await worker.stop(); expect(models).toBe(0); expect(repo.view('owner-a', a.group.id).state).toBe('failed');
  });
});
