// @vitest-environment node
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import fixture from './fixtures/plan-request.demo.json';

const root = mkdtempSync(join(tmpdir(), 'bundled-runtime-'));
let child: ChildProcess | undefined; let port: number; let output = '';
const origin = 'https://weekendmerge.ailoong.net.cn';
const jars = new Map<string, string>();
async function request(session: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: jars.get(session) ?? '', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const cookie = response.headers.get('set-cookie'); if (cookie) jars.set(session, cookie.split(';')[0]);
  return response;
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  const current = child; const exited = new Promise<void>(done => current.once('exit', () => done())); current.kill('SIGTERM'); await exited;
}
async function start() {
  child = spawn(process.execPath, ['--experimental-sqlite', join(root, 'server.mjs')], { env: { ...process.env, DEEPSEEK_API_KEY: '', QWEATHER_API_KEY: '', NODE_ENV: 'production', PUBLIC_ORIGIN: origin, STATIC_ROOT: join(root, 'dist'), GROUP_DB_PATH: join(root, 'data-runtime', 'groups.sqlite'), HOST: '127.0.0.1', PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout!.on('data', value => { output += value; }); child.stderr!.on('data', value => { output += value; });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return; } catch {}
    if (child.exitCode !== null) throw new Error(`Bundled server exited: ${output}`);
    await new Promise(done => setTimeout(done, 30));
  }
  throw new Error('Bundled server did not start');
}
beforeAll(async () => {
  execFileSync(resolve('node_modules/esbuild/bin/esbuild'), ['scripts/server.ts', '--bundle', '--platform=node', '--format=esm', `--outfile=${join(root, 'server.mjs')}`, '--log-level=warning']);
  mkdirSync(join(root, 'dist')); writeFileSync(join(root, 'dist', 'index.html'), '<!doctype html><title>runtime</title>');
  writeFileSync(join(root, 'private.txt'), 'private-proof'); symlinkSync(join(root, 'private.txt'), join(root, 'dist', 'leak.txt'));
  const socket = createServer(); await new Promise<void>(done => socket.listen(0, '127.0.0.1', done)); port = (socket.address() as { port: number }).port; await new Promise<void>(done => socket.close(() => done()));
  await start();
});
afterAll(async () => { await stop(); rmSync(root, { recursive: true, force: true }); });
it('enforces production cookie, origin, API routing and static database/backup isolation', async () => {
  const list = await request('policy', '/api/groups');
  expect(list.status).toBe(200); expect(list.headers.get('set-cookie')).toContain('__Host-weekend_group=');
  for (const flag of ['Secure', 'HttpOnly', 'SameSite=Lax', 'Path=/']) expect(list.headers.get('set-cookie')).toContain(flag);
  expect(list.headers.get('cache-control')).toBe('no-store');
  expect((await request('policy', '/api/unknown')).status).toBe(404);
  expect((await request('policy', '/api/groups', {}, { Origin: 'https://foreign.example' })).status).toBe(403);
  expect((await request('policy', '/.netlify/functions/plan', { mode: 'live' })).status).toBe(403);
  expect((await request('policy', '/.netlify/functions/replan', {})).status).toBe(403);
  for (const path of ['/groups.sqlite', '/data-runtime/groups.sqlite-wal', '/backups/group.sqlite.bak', '/leak.txt']) {
    const response = await request('policy', path); expect(response.status).toBeGreaterThanOrEqual(400); expect(await response.text()).not.toContain('private-proof');
  }
});
it('persists independent two- and six-person groups across restart and never runs until all submit', async () => {
  const date = new Date(Date.now() + 8 * 3600_000); date.setUTCDate(date.getUTCDate() + ((6 - date.getUTCDay() + 7) % 7 || 7));
  const ids: string[] = [];
  for (const count of [2, 6]) {
    const owner = `owner${count}`;
    const created = await (await request(owner, '/api/groups', { name: `Group${count}`, nickname: 'Owner', targetCount: count, setup: { ...fixture.setup, date: date.toISOString().slice(0, 10), budget: count * 150 } })).json();
    ids.push(created.group.id); const members = [{ session: owner, memberId: created.memberId }];
    for (let index = 1; index < count; index++) { const session = `member${count}-${index}`; const joined = await (await request(session, '/api/groups/join', { token: created.inviteToken, nickname: `Member${index}` })).json(); members.push({ session, memberId: joined.memberId }); }
    for (const [index, member] of members.entries()) {
      const response = await request(member.session, `/api/groups/${created.group.id}/preferences`, { memberId: member.memberId, version: 0, preferences: { ...fixture.preferences.a, avoid: [], walkingLimitKm: 5 }, submit: true, idempotencyKey: `submit-${index}` });
      expect(response.status).toBe(200);
      const view = await response.json();
      if (index < count - 1) { expect(view.state).toBe('collecting'); expect(view.job).toBeUndefined(); }
    }
  }
  expect((await request('owner2', `/api/groups/${ids[1]}`)).status).toBe(403);
  for (let i = 0; i < 150; i++) {
    const views = await Promise.all(ids.map((id, index) => request(`owner${index ? 6 : 2}`, `/api/groups/${id}`).then(r => r.json())));
    if (views.every(view => view.state === 'ready')) {
      for (const [index, view] of views.entries()) { expect(view.members).toHaveLength(index ? 6 : 2); expect(view.candidates).toHaveLength(3); expect(view.job.events.some((entry: any) => entry.event.type === 'run.degraded')).toBe(true); expect(view.myMembers).toHaveLength(1); }
      break;
    }
    if (i === 149) throw new Error(`Groups did not complete: ${JSON.stringify(views.map(v => ({ state: v.state, job: v.job?.error })))}`);
    await new Promise(done => setTimeout(done, 40));
  }
  await stop(); await start();
  for (const [index, id] of ids.entries()) { const view = await (await request(`owner${index ? 6 : 2}`, `/api/groups/${id}`)).json(); expect(view.state).toBe('ready'); expect(view.candidates).toHaveLength(3); }
  expect(output).not.toContain('private-proof'); expect(output).not.toContain(jars.get('owner2'));
}, 15000);
