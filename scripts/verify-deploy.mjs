// Runs real PM2 in a disposable PM2_HOME. Never uses the user's PM2 daemon.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
delete process.env.APP_RELEASE;
delete process.env.STATIC_ROOT;
const pm2 = args => execFileSync("pm2", args, {
  encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 45_000, killSignal: "SIGKILL",
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
  pm2(["start", join(root, "dist-server", "server.mjs"), "--name", "weekend-merge", "--cwd", root, "--interpreter", process.execPath]);
  assert.equal((await health()).release, "local");
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
  console.log("PASS: a crashing release was rolled back to the previous executable and working directory");
} finally {
  try { pm2(["kill"]); } catch { /* Best effort for this isolated daemon only. */ }
  await rm(sandbox, { recursive: true, force: true });
}
