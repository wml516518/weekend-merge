// Runs real PM2 in a disposable PM2_HOME. Never uses the user's PM2 daemon.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deployRelease } from "./deploy.mjs";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sandbox = await mkdtemp(join(tmpdir(), "weekend-pm2-verify-"));
const root = join(sandbox, "app");
process.env.PM2_HOME = join(sandbox, "pm2");
process.env.HOST = "127.0.0.1";
process.env.PORT = "8787";
process.env.DEEPSEEK_API_KEY = "deployment-test-key-not-a-real-key";
process.env.QWEATHER_API_KEY = "weather-test-key-not-a-real-key";
process.env.QWEATHER_API_HOST = "test.qweatherapi.com";
process.env.PUBLIC_ORIGIN = 'https://weekendmerge.ailoong.net.cn';
process.env.GROUP_DB_PATH = join(root, 'data-runtime', 'groups.sqlite');
process.env.GROUP_JOB_CONCURRENCY = '2';
process.env.NODE_ENV = 'production';
delete process.env.APP_RELEASE;
delete process.env.STATIC_ROOT;
const pm2 = args => execFileSync("pm2", args, {
  encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 270_000, killSignal: "SIGKILL",
});

async function artifact(directory) {
  await mkdir(directory, { recursive: true });
  await cp(join(project, "dist"), join(directory, "dist"), { recursive: true });
  await cp(join(project, "dist-server"), join(directory, "dist-server"), { recursive: true });
  await mkdir(join(directory, "tests", "fixtures"), { recursive: true });
  await cp(join(project, "tests", "fixtures", "plan-request.demo.json"), join(directory, "tests", "fixtures", "plan-request.demo.json"));
}

async function health() {
  for (let i = 0; i < 30; i++) {
    try {
      const response = await fetch("http://127.0.0.1:8787/healthz", { signal: AbortSignal.timeout(1000) });
      if (response.ok) return await response.json();
    } catch { /* Waiting for startup. */ }
    await new Promise(done => setTimeout(done, 200));
  }
  throw new Error("Test service did not start");
}

try {
  await artifact(root);
  pm2(["start", join(root, "dist-server", "server.mjs"), "--name", "weekend-merge", "--cwd", root, "--interpreter", process.execPath, '--node-args=--experimental-sqlite', '--kill-timeout', '240000']);
  assert.equal((await health()).release, "local");
  const date = new Date(Date.now() + 8 * 3600_000); date.setUTCDate(date.getUTCDate() + ((6 - date.getUTCDay() + 7) % 7 || 7));
  const createdResponse = await fetch('http://127.0.0.1:8787/api/groups', { method: 'POST', headers: { Origin: process.env.PUBLIC_ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Persistence proof', nickname: 'Owner', targetCount: 2, setup: { city: '上海', date: date.toISOString().slice(0, 10), startTime: '13:00', endTime: '20:00', budget: 300, startingArea: '徐汇滨江' } }) });
  assert.equal(createdResponse.status, 201);
  const cookie = createdResponse.headers.get('set-cookie').split(';')[0]; const created = await createdResponse.json();
  const persisted = async () => {
    const response = await fetch(`http://127.0.0.1:8787/api/groups/${created.group.id}`, { headers: { Cookie: cookie } });
    assert.equal(response.status, 200); assert.equal((await response.json()).name, 'Persistence proof');
  };
  const release = `${"b".repeat(40)}-100-1`;
  const directory = join(root, ".deploy", "releases", release);
  await artifact(join(root, ".deploy", "uploads", release));
  await deployRelease({ root, release });
  assert.equal((await health()).release, release);
  const active = JSON.parse(pm2(["jlist"])).find(p => p.name === "weekend-merge");
  // A version env var alone could mask PM2 still executing an older bundle.
  assert.equal(active.pm2_env.pm_exec_path, join(directory, "dist-server", "server.mjs"));
  assert.equal(active.pm2_env.pm_cwd, directory);
  assert.equal(active.pm2_env.DEEPSEEK_API_KEY, "deployment-test-key-not-a-real-key");
  assert.equal(active.pm2_env.QWEATHER_API_KEY, "weather-test-key-not-a-real-key");
  assert.equal(active.pm2_env.QWEATHER_API_HOST, "test.qweatherapi.com");
  assert.equal(active.pm2_env.GROUP_DB_PATH, process.env.GROUP_DB_PATH);
  assert.equal(active.pm2_env.PUBLIC_ORIGIN, process.env.PUBLIC_ORIGIN);
  assert.equal(active.pm2_env.GROUP_JOB_CONCURRENCY, '2');
  assert.deepEqual(active.pm2_env.node_args, ['--experimental-sqlite']);
  assert.equal(active.pm2_env.kill_timeout, 240000);
  assert.equal(JSON.parse(pm2(['jlist'])).filter(p => p.name === 'weekend-merge').length, 1);
  await persisted();
  const backups = await readdir(join(root, 'data-runtime', 'backups')); assert.equal(backups.length, 1);
  console.log("PASS: PM2 activated the new executable/cwd, preserved environment, and passed static/API checks");

  const broken = `${"c".repeat(40)}-101-1`;
  const brokenDirectory = join(root, ".deploy", "uploads", broken);
  await artifact(brokenDirectory);
  await writeFile(join(brokenDirectory, "dist-server", "server.mjs"), "process.exit(1);");
  await assert.rejects(deployRelease({ root, release: broken }), /rolled back/);
  assert.equal((await health()).release, release);
  const restored = JSON.parse(pm2(["jlist"])).find(p => p.name === "weekend-merge");
  assert.equal(restored.pm2_env.pm_exec_path, join(directory, "dist-server", "server.mjs"));
  assert.equal(restored.pm2_env.pm_cwd, directory);
  assert.equal(restored.pm2_env.QWEATHER_API_KEY, "weather-test-key-not-a-real-key");
  assert.equal(restored.pm2_env.QWEATHER_API_HOST, "test.qweatherapi.com");
  assert.deepEqual(restored.pm2_env.node_args, ['--experimental-sqlite']); await persisted();
  console.log("PASS: a crashing release was rolled back to the previous executable and working directory");
  pm2(['stop', 'weekend-merge']);
  const retained = execFileSync(process.execPath, ['--experimental-sqlite', join(project, 'scripts', 'backup-groups.mjs'), '--restore', join(root, 'data-runtime', 'backups', backups[0]), process.env.GROUP_DB_PATH, '--service-stopped'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  assert.ok(retained); pm2(['restart', 'weekend-merge']); await health(); await persisted();
  console.log('PASS: group persisted across release/rollback; consistent backup integrity checked and restored offline');
} finally {
  try { pm2(["kill"]); } catch { /* Best effort for this isolated daemon only. */ }
  await rm(sandbox, { recursive: true, force: true });
}
