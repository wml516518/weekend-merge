import { execFileSync } from "node:child_process";
import { access, chmod, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appName = "weekend-merge";
const releasePattern = /^[a-f0-9]{40}-\d+-\d+$/;
const delay = ms => new Promise(done => setTimeout(done, ms));

function runPm2(args) {
  try {
    return execFileSync("pm2", args, {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 270_000, killSignal: "SIGKILL",
    });
  } catch {
    // PM2's output/configuration may contain environment secrets.
    throw new Error(`PM2 ${args[0]} failed`);
  }
}

function snapshot(pm2, root) {
  const matches = JSON.parse(pm2(["jlist"])).filter(p => p.name === appName);
  if (matches.length !== 1) throw new Error("Expected exactly one existing weekend-merge PM2 process");
  const previous = matches[0].pm2_env;
  if (!isAbsolute(previous.pm_exec_path) || !isAbsolute(previous.pm_cwd)) throw new Error("Invalid PM2 application paths");
  if ((previous.GROUP_DB_PATH || previous.env?.GROUP_DB_PATH) && Number(previous.kill_timeout ?? 1600) < 240_000) {
    throw new Error('Existing group server needs PM2 kill_timeout >= 240000 before deployment');
  }
  const env = {};
  for (const key of ["DEEPSEEK_API_KEY", "DEEPSEEK_MODEL", "QWEATHER_API_KEY", "QWEATHER_API_HOST", "HOST", "PORT", "STATIC_ROOT", "TRUSTED_PROXY_DEPTH", "APP_RELEASE", "NODE_ENV", "GROUP_DB_PATH", "GROUP_JOB_CONCURRENCY", "PUBLIC_ORIGIN"]) {
    env[key] = previous[key] ?? previous.env?.[key] ?? "";
  }
  env.HOST ||= "127.0.0.1";
  env.PORT ||= "8787";
  env.STATIC_ROOT ||= join(previous.pm_cwd, "dist");
  env.TRUSTED_PROXY_DEPTH ||= "1";
  env.NODE_ENV ||= "production";
  env.GROUP_DB_PATH ||= join(root, 'data-runtime', 'groups.sqlite');
  env.GROUP_JOB_CONCURRENCY ||= '2';
  env.PUBLIC_ORIGIN ||= 'https://weekendmerge.ailoong.net.cn';
  if (env.GROUP_DB_PATH !== join(root, 'data-runtime', 'groups.sqlite')) throw new Error('GROUP_DB_PATH must use the stable deployment data-runtime directory');
  // Do not alter unrelated processes, expose a public port, or inherit PM2 internals.
  if (!["127.0.0.1", "localhost"].includes(env.HOST) || String(env.PORT) !== "8787") {
    throw new Error("Deployment expects the existing service on 127.0.0.1:8787");
  }
  return {
    name: appName, script: previous.pm_exec_path, cwd: previous.pm_cwd,
    interpreter: previous.exec_interpreter || process.execPath,
    instances: 1, exec_mode: "fork", env,
    node_args: previous.node_args || [], kill_timeout: 240_000,
  };
}

async function waitForService(fetcher, pause, expectedRelease) {
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      const response = await fetcher(`http://127.0.0.1:8787/${expectedRelease ? "healthz" : ""}`, {
        signal: AbortSignal.timeout(3000),
      });
      if (response.ok) {
        if (!expectedRelease) return;
        const body = await response.json();
        if (body.status === "ok" && body.release === expectedRelease) return;
      }
    } catch { /* The process may still be starting. */ }
    await pause(500);
  }
  throw new Error("Service health check failed");
}

async function smokeTest(fetcher, directory) {
  const home = await fetcher("http://127.0.0.1:8787/", { signal: AbortSignal.timeout(5000) });
  if (!home.ok || !(await home.text()).toLowerCase().includes("<!doctype html>")) throw new Error("Static site smoke test failed");
  const request = JSON.parse(await readFile(join(directory, "tests", "fixtures", "plan-request.demo.json"), "utf8"));
  const date = new Date(Date.now() + 8 * 3600_000);
  date.setUTCDate(date.getUTCDate() + ((6 - date.getUTCDay() + 7) % 7 || 7));
  request.setup.date = date.toISOString().slice(0, 10);
  request.mode = "demo";
  request.sessionId = `deploy-${Date.now()}`;
  const response = await fetcher("http://127.0.0.1:8787/.netlify/functions/plan", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(request), signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok || !response.headers.get("content-type")?.startsWith("application/x-ndjson")) throw new Error("API smoke test failed");
  const events = (await response.text()).trim().split("\n").map(line => JSON.parse(line));
  const proposals = events.filter(event => event.type === "plan.proposed");
  const terminal = events.at(-1);
  if (proposals.length !== 3 || terminal?.type !== "run.completed" ||
      JSON.stringify(terminal.result?.candidateIds) !== JSON.stringify(proposals.map(event => event.plan.id))) {
    throw new Error("API smoke test did not complete three plans");
  }
}

export async function deployRelease({ root, release, pm2 = runPm2, fetch: fetcher = globalThis.fetch, pause = delay }) {
  if (!releasePattern.test(release ?? "")) throw new Error("Invalid release identifier");
  if (!isAbsolute(root ?? "") || resolve(root) === "/") throw new Error("Invalid deployment root");
  const deployment = join(root, ".deploy");
  await mkdir(deployment, { recursive: true, mode: 0o700 });
  await chmod(deployment, 0o700);
  const lockPath = join(deployment, "deploy.lock");
  const lock = await open(lockPath, "wx", 0o600);
  const configPath = join(deployment, "pm2.config.json");
  const activate = async app => {
    await writeFile(configPath, JSON.stringify({ apps: [app] }), { mode: 0o600 });
    await chmod(configPath, 0o600);
    // PM2 reload can retain the old pm_exec_path/pm_cwd for an existing name.
    // Recreate only our named process so the verified artifact really executes.
    const matches = JSON.parse(pm2(["jlist"])).filter(p => p.name === appName);
    if (matches.length > 1) throw new Error("Refusing to change duplicate PM2 process names");
    if (matches.length === 1) pm2(["delete", appName]);
    pm2(["start", configPath, "--only", appName]);
  };
  try {
    const upload = join(deployment, "uploads", release);
    for (const path of ["dist/index.html", "dist-server/server.mjs", "tests/fixtures/plan-request.demo.json", "scripts/backup-groups.mjs"]) {
      await access(join(upload, path));
    }
    const previous = snapshot(pm2, root);
    // Prepare the snapshot before promotion: a CLI loaded from uploads keeps its
    // original import.meta.url even after that directory is renamed. Preparation
    // failures must leave the healthy old process running without a restart.
    const exists = await access(previous.env.GROUP_DB_PATH).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
    if (exists) execFileSync(process.execPath, ['--experimental-sqlite', join(upload, 'scripts', 'backup-groups.mjs'), previous.env.GROUP_DB_PATH], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 });
    const directory = join(deployment, "releases", release);
    await mkdir(join(deployment, "releases"), { recursive: true });
    await rename(upload, directory);
    const next = {
      ...previous, script: join(directory, "dist-server", "server.mjs"), cwd: directory,
      interpreter: process.execPath,
      node_args: ['--experimental-sqlite'],
      env: { ...previous.env, APP_RELEASE: release, STATIC_ROOT: join(directory, "dist") },
    };
    try {
      await activate(next);
      await waitForService(fetcher, pause, release);
      await smokeTest(fetcher, directory);
      pm2(["save"]);
      await writeFile(join(deployment, "current.json.tmp"), JSON.stringify({ release, previousScript: previous.script }), { mode: 0o600 });
      await rename(join(deployment, "current.json.tmp"), join(deployment, "current.json"));
    } catch {
      try {
        await activate(previous);
        await waitForService(fetcher, pause);
        pm2(["save"]);
      } catch {
        throw new Error("Deployment failed and rollback failed; check pm2 status on the server");
      }
      throw new Error("Deployment failed; rolled back to the previous application");
    }
    // Only remove this run's upload archive. Keep all releases for manual rollback.
    await unlink(join(deployment, "uploads", `${release}.tgz`)).catch(() => {});
    return { release };
  } finally {
    await unlink(configPath).catch(() => {});
    await lock.close();
    await unlink(lockPath);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  deployRelease({ root: process.argv[2], release: process.argv[3] })
    .then(({ release }) => console.log(`Deployed ${release}; static site and demo API checks passed`))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
