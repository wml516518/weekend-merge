// @vitest-environment node
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createServer } from 'node:net';
import { expect, it } from 'vitest';

it('serves the group API from the documented npm run dev entry without NODE_OPTIONS', async () => {
  const root = mkdtempSync(join(tmpdir(), 'group-dev-'));
  const socket = createServer();
  await new Promise<void>(done => socket.listen(0, '127.0.0.1', done));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>(done => socket.close(() => done()));
  const origin = `http://127.0.0.1:${port}`;
  const env = { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH}`, PUBLIC_ORIGIN: origin,
    GROUP_DB_PATH: join(root, 'groups.sqlite'), DEEPSEEK_API_KEY: '', QWEATHER_API_KEY: '' };
  delete env.NODE_OPTIONS;
  let child: ChildProcess | undefined;
  let output = '';
  try {
    child = spawn('npm', ['run', 'dev', '--', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
      { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout!.on('data', value => { output += value; });
    child.stderr!.on('data', value => { output += value; });
    let response: Response | undefined;
    for (let attempt = 0; attempt < 150; attempt++) {
      try { response = await fetch(`${origin}/api/groups`); break; } catch {}
      if (child.exitCode !== null) throw new Error(`dev exited: ${output}`);
      await new Promise(done => setTimeout(done, 40));
    }
    expect(response, output).toBeDefined();
    expect(response!.status, output).toBe(200);
    expect(await response!.json()).toEqual({ groups: [] });
    expect(response!.headers.get('set-cookie')).toContain('weekend_group_dev=');
  } finally {
    if (child?.pid && child.exitCode === null) {
      const stopped = new Promise<void>(done => child!.once('exit', () => done()));
      process.kill(-child.pid, 'SIGTERM');
      await stopped;
    }
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);
