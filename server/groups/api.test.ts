// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GroupRepository } from './repository';
import { createGroupApi } from './api';
import type { GroupCreated, GroupJoined, GroupView } from '../../src/contracts/groups';
import { GroupWorker } from './worker';
import { shanghaiPlaces } from '../../netlify/functions/agent/tools/places';
import type { Itinerary } from '../../src/contracts/agent';

const instant = Date.parse('2026-11-14T01:00:00Z');
const setup = { city: '上海', date: '2026-11-15', startTime: '13:00', endTime: '20:00', budget: 300, startingArea: '徐汇' };
const preferences = { interests: ['咖啡'], pace: '平衡', walkingLimitKm: 3, indoorPreference: '均可', foodTags: [], budgetStyle: '平衡', avoid: [], wish: 'ONLY_MY_PRIVATE_WISH' };
const cleanups: (() => void)[] = [];
function fixture(options: { publicOrigin?: string; development?: boolean; now?: () => number } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'group-api-'));
  const repo = new GroupRepository({ path: join(root, 'groups.sqlite'), now: options.now ?? (() => instant) });
  const api = createGroupApi(repo, { publicOrigin: 'https://weekend.example', now: () => instant, ...options });
  cleanups.push(() => { api.close(); repo.close(); rmSync(root, { recursive: true, force: true }); });
  function jar(ip = 'ip-1') {
    let cookie = '';
    return {
      get cookie() { return cookie; },
      async request(path = '', body?: unknown, headers: Record<string, string> = {}, method = body === undefined ? 'GET' : 'POST') {
        const response = await api.handle(new Request(`https://weekend.example/api/groups${path}`, {
          method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body !== undefined ? { Origin: 'https://weekend.example', 'Content-Type': 'application/json' } : {}), ...headers },
          ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
        }), ip);
        const issued = response.headers.get('set-cookie');
        if (issued) cookie = issued.split(';')[0];
        return response;
      },
    };
  }
  return { api, repo, jar };
}
async function create(browser: ReturnType<ReturnType<typeof fixture>['jar']>) {
  const response = await browser.request('', { name: '周末小组', nickname: '甲', targetCount: 2, setup });
  expect(response.status).toBe(201);
  return await response.json() as GroupCreated;
}
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

describe('authorized group HTTP', () => {
  it('issues a secure browser credential and rejects cross-group and other-member reads/writes', async () => {
    const { jar } = fixture(); const owner = jar(); const member = jar('ip-2'); const outsider = jar('ip-3');
    const a = await create(owner);
    expect(owner.cookie).toMatch(/^__Host-weekend_group=[A-Za-z0-9_-]{43}$/);
    const joined = await member.request('/join', { token: a.inviteToken, nickname: '乙' });
    const b = await joined.json() as GroupJoined;
    const saved = await member.request(`/${a.group.id}/preferences`, { memberId: b.memberId, version: 0, preferences, submit: false, idempotencyKey: 'b-draft' });
    expect(saved.status).toBe(200);
    expect(JSON.stringify(await (await owner.request(`/${a.group.id}`)).json())).not.toContain('ONLY_MY_PRIVATE_WISH');
    expect((await outsider.request(`/${a.group.id}`)).status).toBe(403);
    expect((await owner.request(`/${a.group.id}/preferences`, { memberId: b.memberId, version: 1, preferences, submit: true, idempotencyKey: 'steal' })).status).toBe(403);
    const c = await create(outsider);
    expect((await member.request(`/${c.group.id}/preferences`, { memberId: b.memberId, version: 1, preferences, submit: true, idempotencyKey: 'foreign' })).status).toBe(403);
    expect(await (await member.request()).json()).toMatchObject({ groups: [{ id: a.group.id, canManage: false }] });
  });
  it('returns raw recovery tokens only when issued, and restores owner and personal powers independently', async () => {
    const { jar } = fixture(); const owner = jar(); const a = await create(owner); const browser = jar('ip-2');
    const ownerRecovery = await browser.request('/recover', { token: a.ownerRecoveryToken });
    expect(await ownerRecovery.json()).toMatchObject({ id: a.group.id, canManage: true, myMembers: [] });
    const personal = jar('ip-3');
    expect(await (await personal.request('/recover', { token: a.memberRecoveryToken })).json()).toMatchObject({ canManage: false, myMembers: [{ id: a.memberId }] });
    const joined = await (await browser.request('/join', { token: a.inviteToken, nickname: '乙' })).json() as GroupJoined;
    expect(joined.memberRecoveryToken).toBeTypeOf('string');
    expect(await (await browser.request('/join', { token: a.inviteToken, nickname: '重复' })).json()).not.toHaveProperty('memberRecoveryToken');
    const text = JSON.stringify(await (await owner.request(`/${a.group.id}`)).json());
    for (const token of [a.inviteToken, a.ownerRecoveryToken, a.memberRecoveryToken]) expect(text).not.toContain(token);
  });
  it('requires the exact canonical origin on every write, even without credentials', async () => {
    const { jar } = fixture(); const browser = jar();
    for (const origin of ['', 'https://evil.example', 'null', 'https://weekend.example.evil.test']) {
      const response = await browser.request('', { name: '组', nickname: '甲', targetCount: 2, setup }, { Origin: origin });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: { code: 'ORIGIN_FORBIDDEN', retryable: false } });
    }
    expect((await browser.request('', { name: '组', nickname: '甲', targetCount: 2, setup }, { Origin: 'https://evil.example', 'X-Forwarded-Host': 'evil.example' })).status).toBe(403);
  });
  it('refuses insecure production origins and permits HTTP only in explicit loopback development', () => {
    const { repo } = fixture();
    for (const publicOrigin of [undefined, 'http://weekend.example', 'https://weekend.example/path', 'https://user:pass@weekend.example', 'https://weekend.example?x=1']) {
      expect(() => createGroupApi(repo, { publicOrigin })).toThrow();
    }
    expect(() => createGroupApi(repo, { publicOrigin: 'http://192.168.1.4:5173', development: true })).toThrow();
    expect(() => createGroupApi(repo, { publicOrigin: 'http://localhost:5173', development: true })).not.toThrow();
  });
  it('bounds streaming bodies without relying on Content-Length', async () => {
    const { api } = fixture(); let cancelled = false;
    const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(32769)); }, cancel() { cancelled = true; } });
    const request = new Request('https://weekend.example/api/groups', { method: 'POST', headers: { Origin: 'https://weekend.example', 'Content-Type': 'application/json' }, body, duplex: 'half' } as RequestInit);
    const response = await api.handle(request, 'ip');
    expect(response.status).toBe(413); expect(cancelled).toBe(true);
    expect(await response.json()).toMatchObject({ error: { code: 'REQUEST_TOO_LARGE' } });
  });
  it('rejects malformed bodies, unsupported methods, bad pagination and unknown API routes as sanitized JSON', async () => {
    const { jar } = fixture(); const browser = jar(); const a = await create(browser);
    for (const body of ['{bad', '{}', JSON.stringify({ name: '组', nickname: '甲', targetCount: 2, setup, preferences })]) {
      const response = await browser.request('', body); expect(response.status).toBe(400);
      expect(JSON.stringify(await response.json())).not.toContain('ONLY_MY_PRIVATE_WISH');
    }
    expect((await browser.request('/unknown/extra')).status).toBe(404);
    expect((await browser.request(`/${a.group.id}`, {}, {}, 'DELETE')).status).toBe(405);
    expect((await browser.request(`/${a.group.id}/events?after=-1`)).status).toBe(400);
    expect((await browser.request(`/${a.group.id}/events?limit=100000`)).status).toBe(400);
    const response = await browser.request(`/${a.group.id}`);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });
  it('enforces Shanghai dates on create, round and submission', async () => {
    const { jar } = fixture(); const browser = jar();
    const response = await browser.request('', { name: '组', nickname: '甲', targetCount: 2, setup: { ...setup, date: '2026-11-07' } });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'INVALID_DATE' } });
    const a = await create(browser);
    expect((await browser.request(`/${a.group.id}/round`, { setup: { ...setup, date: '2027-11-14' }, targetCount: 2 })).status).toBe(400);
  });
  it('queues exactly one immutable job under concurrent final submissions; refresh and paging are read-only', async () => {
    const { repo, jar } = fixture(); const owner = jar(); const member = jar('other-ip'); const a = await create(owner);
    const b = await (await member.request('/join', { token: a.inviteToken, nickname: '乙' })).json() as GroupJoined;
    const replies = await Promise.all([
      owner.request(`/${a.group.id}/preferences`, { memberId: a.memberId, version: 0, preferences, submit: true, idempotencyKey: 'a' }),
      member.request(`/${a.group.id}/preferences`, { memberId: b.memberId, version: 0, preferences: { ...preferences, wish: 'different' }, submit: true, idempotencyKey: 'b' }),
    ]);
    expect(replies.map(r => r.status)).toEqual([200, 200]);
    const job = repo.claimJob()!; expect(job.request.preferences.participants.map(p => p.id)).toEqual(['member-1', 'member-2']);
    repo.appendEvent(job.id, job.lease, { type: 'run.started', runId: 'public-run', at: new Date(instant).toISOString() });
    repo.appendEvent(job.id, job.lease, { type: 'step.started', step: 'VALIDATE', at: new Date(instant).toISOString() });
    expect(await (await owner.request(`/${a.group.id}/events?after=1&limit=1`)).json()).toMatchObject({ jobId: job.id, events: [{ sequence: 2, event: { type: 'step.started' } }], nextAfter: 2 });
    for (let i = 0; i < 3; i++) expect((await member.request(`/${a.group.id}`)).status).toBe(200);
    expect(repo.claimJob()).toBeUndefined();
  });
  it('rotates invitations, removes members, opens rounds and rejects owner mutation by a member', async () => {
    const { jar } = fixture(); const owner = jar(); const member = jar('other-ip'); const a = await create(owner);
    const b = await (await member.request('/join', { token: a.inviteToken, nickname: '乙' })).json() as GroupJoined;
    expect((await member.request(`/${a.group.id}/invite`, {})).status).toBe(403);
    const rotated = await (await owner.request(`/${a.group.id}/invite`, {})).json(); expect(rotated.inviteToken).not.toBe(a.inviteToken);
    expect((await owner.request(`/${a.group.id}/members/${b.memberId}/remove`, {})).status).toBe(200);
    expect((await member.request(`/${a.group.id}`)).status).toBe(403);
    const view = await (await owner.request(`/${a.group.id}/round`, { setup, targetCount: 2 })).json() as GroupView;
    expect(view.revision).toBe(2); expect(view.candidates).toEqual([]);
  });
  it('limits model-affecting writes by IP independently of reset cookies', async () => {
    const { jar } = fixture();
    for (let i = 0; i < 5; i++) await create(jar('shared-ip'));
    const blocked = await jar('shared-ip').request('', { name: '组', nickname: '甲', targetCount: 2, setup });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).toBeTruthy();
    expect((await jar('different-ip').request('', { name: '组', nickname: '甲', targetCount: 2, setup })).status).toBe(201);
  });
  it('limits inexpensive reads without adding jobs', async () => {
    const { jar } = fixture(); const browser = jar(); await create(browser);
    let response: Response | undefined;
    for (let i = 0; i < 121; i++) response = await browser.request();
    expect(response!.status).toBe(429);
  });
  it('rejects stale-date submissions and retries without sending the snapshot upstream', async () => {
    let clock = instant; const { jar } = fixture({ now: () => clock }); const owner = jar(); const a = await create(owner);
    clock += 2 * 86400000;
    const response = await owner.request(`/${a.group.id}/preferences`, { memberId: a.memberId, version: 0, preferences, submit: true, idempotencyKey: 'late' });
    expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ error: { code: 'INVALID_DATE' } });
    expect((await owner.request(`/${a.group.id}/preferences`, { memberId: a.memberId, version: 0, preferences, submit: false, idempotencyKey: 'draft' })).status).toBe(200);
  });
  it('runs selection, failed attempt retry, both local adjustments and finalization from stored data only', async () => {
    let clock = instant; const { jar, repo } = fixture({ now: () => clock }); const owner = jar(); const member = jar('member-ip'); const a = await create(owner);
    const b = await (await member.request('/join', { token: a.inviteToken, nickname: '乙' })).json() as GroupJoined;
    for (const [browser, memberId] of [[owner, a.memberId], [member, b.memberId]] as const) {
      expect((await browser.request(`/${a.group.id}/preferences`, { memberId, version: 0, preferences, submit: true, idempotencyKey: memberId })).status).toBe(200);
    }
    let worker = new GroupWorker(repo, { run: async () => { throw new Error('external failure'); } }); await worker.tick(); await worker.stop();
    expect((await member.request(`/${a.group.id}/retry`, {})).status).toBe(403);
    expect((await owner.request(`/${a.group.id}/retry`, {})).status).toBe(200);
    const initial = repo.claimJob()!;
    const candidates: Itinerary[] = ['shanghai-book-city', 'shanghai-museum-east', 'fuxing-park'].map((venue, i) => {
      const p = shanghaiPlaces.find(p => p.placeId === venue)!;
      return { id: `plan-${i}`, title: p.name, summary: '周末', matchScore: 80, totalCost: p.priceRange.max * 2 * 1.1, totalDistanceKm: 0, indoorRatio: p.indoor ? 100 : 0, transfers: 0, reasons: ['阅读'], stops: [{ id: 'stop-1', placeId: p.placeId, name: p.name, area: p.area, startTime: '14:00', endTime: '16:00', cost: p.priceRange.max * 2, latitude: p.latitude, longitude: p.longitude, tags: p.tags, locked: false }] };
    });
    for (const plan of candidates) repo.appendEvent(initial.id, initial.lease, { type: 'plan.proposed', plan });
    repo.appendEvent(initial.id, initial.lease, { type: 'run.completed', result: { runId: initial.id, consensus: { shared: [], conflicts: [], constraints: [] }, candidateIds: candidates.map(p => p.id) } });
    repo.finishJob(initial.id, initial.lease, 'succeeded');
    let view = await (await owner.request(`/${a.group.id}`)).json() as GroupView;
    expect((await member.request(`/${a.group.id}/select`, { version: view.stateVersion, planId: 'plan-0', lockedStopIds: [] })).status).toBe(403);
    view = await (await owner.request(`/${a.group.id}/select`, { version: view.stateVersion, planId: 'plan-0', lockedStopIds: [] })).json() as GroupView;
    expect((await owner.request(`/${a.group.id}/replan`, { version: view.stateVersion, rejectedStopId: 'stop-1', reason: '换个地点', reasonCode: 'CHANGE_PLACE', preferences })).status).toBe(400);
    view = await (await owner.request(`/${a.group.id}/replan`, { version: view.stateVersion, rejectedStopId: 'stop-1', reason: '换个地点', reasonCode: 'CHANGE_PLACE' })).json() as GroupView;
    expect(view.state).toBe('queued'); expect(view.replanCount).toBe(1);
    const { createDefaultGroupRunner } = await import('./worker');
    worker = new GroupWorker(repo, { run: createDefaultGroupRunner({ now: () => new Date(instant), env: {} }) }); await worker.tick(); await worker.stop();
    view = await (await owner.request(`/${a.group.id}`)).json() as GroupView;
    expect(view.candidates).toHaveLength(3); expect(view.job?.plans).toHaveLength(1);
    clock += 600001;
    const selectedStop = view.candidates.find(p => p.id === view.selectedPlanId)!.stops[0].id;
    view = await (await owner.request(`/${a.group.id}/replan`, { version: view.stateVersion, rejectedStopId: selectedStop, reason: '再换个地点', reasonCode: 'CHANGE_PLACE' })).json() as GroupView;
    expect(view.replanCount).toBe(2);
    worker = new GroupWorker(repo, { run: createDefaultGroupRunner({ now: () => new Date(clock), env: {} }) }); await worker.tick(); await worker.stop();
    view = await (await owner.request(`/${a.group.id}`)).json() as GroupView;
    expect(view.candidates).toHaveLength(3);
    expect((await owner.request(`/${a.group.id}/replan`, { version: view.stateVersion, rejectedStopId: selectedStop, reason: '第三次', reasonCode: 'CHANGE_PLACE' })).status).toBe(409);
    const selected = view.selectedPlanId!;
    expect((await owner.request(`/${a.group.id}/finalize`, { version: view.stateVersion - 1, planId: selected })).status).toBe(409);
    const final = await owner.request(`/${a.group.id}/finalize`, { version: view.stateVersion, planId: selected });
    expect(final.status).toBe(200); expect(await final.json()).toMatchObject({ state: 'finalized', finalPlanId: selected });
    expect((await owner.request(`/${a.group.id}/select`, { version: view.stateVersion, planId: 'plan-0', lockedStopIds: [] })).status).toBe(409);
  });
});
