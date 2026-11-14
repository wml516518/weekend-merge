// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createGroupRuntime } from './runtime';
import { GroupRepository } from './repository';
import fixture from '../../tests/fixtures/plan-request.demo.json';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });
function runtime() {
  const root = mkdtempSync(join(tmpdir(), 'group-runtime-'));
  const runtime = createGroupRuntime({ path: join(root, 'groups.sqlite'), publicOrigin: 'https://weekend.example', now: () => Date.parse('2026-11-14T01:00:00Z'), run: async () => {} });
  cleanups.push(async () => { await runtime.close(); rmSync(root, { recursive: true, force: true }); });
  return runtime;
}
it('routes group APIs ahead of fallback, rejects unknown APIs as JSON and blocks production legacy live bypass', async () => {
  const app = runtime();
  for (const path of ['/api/groups', '/api/unknown', '/.netlify/functions/unknown']) {
    const response = await app.handle(new Request(`https://weekend.example${path}`), 'ip');
    expect(response).toBeInstanceOf(Response);
    expect(response!.headers.get('content-type')).toContain('application/json');
    expect(response!.status).toBe(path === '/api/groups' ? 200 : 404);
  }
  for (const path of ['plan', 'replan']) {
    const response = await app.handle(new Request(`https://weekend.example/.netlify/functions/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...fixture, mode: 'live' }) }), 'ip');
    expect(response!.status).toBe(403);
    expect(await response!.json()).toMatchObject({ error: { code: 'GROUP_REQUIRED' } });
  }
  expect(await app.handle(new Request('https://weekend.example/share/demo'), 'ip')).toBeUndefined();
});
it('keeps the legacy demo available without exposing a live agent', async () => {
  const app = runtime();
  const response = await app.handle(new Request('https://weekend.example/.netlify/functions/plan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...fixture, setup: { ...fixture.setup, date: '2026-11-15' }, mode: 'demo' }) }), 'ip');
  expect(response!.status).toBe(200); expect(await response!.text()).toContain('run.completed');
});
it('rejects oversized legacy bypass requests with the same streaming body bound', async () => {
  const app = runtime();
  const response = await app.handle(new Request('https://weekend.example/.netlify/functions/plan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'x'.repeat(32769) }), 'ip');
  expect(response!.status).toBe(413);
});
it('validates the deployment concurrency environment before opening SQLite or starting work', () => {
  for (const value of ['0', '5', 'abc', '1.5']) {
    expect(() => createGroupRuntime({ path: ':memory:', publicOrigin: 'https://weekend.example', env: { GROUP_JOB_CONCURRENCY: value } })).toThrow('INVALID_CONCURRENCY');
  }
});
it('closes SQLite only after an active runner drains and rejects new HTTP work during close', async () => {
  const root = mkdtempSync(join(tmpdir(), 'group-runtime-drain-')); const path = join(root, 'groups.sqlite'); const now = () => Date.parse('2026-11-14T01:00:00Z');
  const seed = new GroupRepository({ path, now }); const setup = { ...fixture.setup, date: '2026-11-15' };
  const a = seed.create('a', '周末', '甲', 2, setup); const b = seed.join('b', a.inviteToken, '乙');
  for (const [session, memberId] of [['a', a.memberId], ['b', b.memberId]]) seed.save(session, a.group.id, { memberId, version: 0, preferences: fixture.preferences.a, submit: true, idempotencyKey: session });
  seed.close();
  let release!: () => void; let started!: () => void;
  const began = new Promise<void>(resolve => { started = resolve; });
  const app = createGroupRuntime({ path, publicOrigin: 'https://weekend.example', now, run: async (_job, emit) => {
    started(); await new Promise<void>(resolve => { release = resolve; });
    emit({ type: 'run.failed', code: 'PLANNING_FAILED', message: 'controlled failure' });
  } });
  let closed = false;
  await began; const closing = app.close().then(() => { closed = true; }); await Promise.resolve();
  expect(closed).toBe(false);
  expect((await app.handle(new Request('https://weekend.example/api/groups'), 'ip'))!.status).toBe(503);
  release(); await closing;
  const reopened = new GroupRepository({ path, now });
  expect(reopened.view('a', a.group.id).job).toMatchObject({ state: 'failed', error: 'PLANNING_FAILED', events: [{ event: { type: 'run.failed' } }] });
  reopened.close(); rmSync(root, { recursive: true, force: true });
});
