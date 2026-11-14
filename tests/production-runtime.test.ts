// @vitest-environment node
import { mkdtempSync, mkdirSync, statSync, chmodSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createGroupRuntime as runtime } from '../server/groups/runtime';
const createGroupRuntime = (options: Parameters<typeof runtime>[0]) => runtime({ publicOrigin: 'https://weekendmerge.ailoong.net.cn', ...options });

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() { const root = mkdtempSync(join(tmpdir(), 'production-groups-')); roots.push(root); return root; }
const env = { NODE_ENV: 'production', PUBLIC_ORIGIN: 'https://weekendmerge.ailoong.net.cn' };
it('explains a missing production origin before creating the database', () => {
  expect(() => runtime({ env, publicOrigin: undefined })).toThrow(/PUBLIC_ORIGIN/);
});
it('requires an explicit absolute production DB outside static and releases before opening it', () => {
  expect(() => createGroupRuntime({ env })).toThrow(/GROUP_DB_PATH/);
  expect(() => createGroupRuntime({ env: { ...env, GROUP_DB_PATH: 'groups.sqlite' } })).toThrow(/GROUP_DB_PATH/);
  const root = fixture();
  expect(() => createGroupRuntime({ env: { ...env, GROUP_DB_PATH: join(root, 'dist', 'groups.sqlite'), STATIC_ROOT: join(root, 'dist') } })).toThrow(/GROUP_DB_PATH/);
  expect(() => createGroupRuntime({ env: { ...env, GROUP_DB_PATH: join(root, '.deploy', 'releases', 'one', 'groups.sqlite') } })).toThrow(/GROUP_DB_PATH/);
  mkdirSync(join(root, 'real')); symlinkSync(join(root, 'real'), join(root, 'public'));
  expect(() => createGroupRuntime({ env: { ...env, GROUP_DB_PATH: join(root, 'real', 'named.txt'), STATIC_ROOT: join(root, 'public') } })).toThrow(/GROUP_DB_PATH/);
});
it('makes database, WAL, SHM and their directory private even with permissive umask', async () => {
  const root = fixture(); const directory = join(root, 'private'); mkdirSync(directory); chmodSync(directory, 0o755);
  const runtime = createGroupRuntime({ env: { ...env, GROUP_DB_PATH: join(directory, 'groups.sqlite') } });
  for (const path of [directory, join(directory, 'groups.sqlite'), join(directory, 'groups.sqlite-wal'), join(directory, 'groups.sqlite-shm')]) {
    expect(statSync(path).mode & 0o077).toBe(0);
  }
  await runtime.close();
});
it('refuses symlinked DB directories and invalid concurrency before opening SQLite', () => {
  const root = fixture(); mkdirSync(join(root, 'real')); symlinkSync(join(root, 'real'), join(root, 'link'));
  expect(() => createGroupRuntime({ env: { ...env, GROUP_DB_PATH: join(root, 'link', 'groups.sqlite') } })).toThrow(/GROUP_DB_PATH/);
  expect(() => createGroupRuntime({ env: { ...env, GROUP_DB_PATH: join(root, 'groups.sqlite'), GROUP_JOB_CONCURRENCY: '5' } })).toThrow(/CONCURRENCY/);
  symlinkSync(join(root, 'does-not-exist'), join(root, 'dangling.sqlite'));
  expect(() => createGroupRuntime({ env: { ...env, GROUP_DB_PATH: join(root, 'dangling.sqlite') } })).toThrow(/GROUP_DB_PATH/);
});
