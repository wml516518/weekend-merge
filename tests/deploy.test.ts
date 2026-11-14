// @vitest-environment node
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { deployRelease } from "../scripts/deploy.mjs";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "weekend-deploy-test-"));
  roots.push(root);
  const release = `${"a".repeat(40)}-123-1`;
  const upload = join(root, ".deploy", "uploads", release);
  await mkdir(join(upload, "dist"), { recursive: true });
  await mkdir(join(upload, "dist-server"));
  await mkdir(join(upload, "tests", "fixtures"), { recursive: true });
  await writeFile(join(upload, "dist", "index.html"), "<!doctype html>");
  await writeFile(join(upload, "dist-server", "server.mjs"), "// bundled server");
  await writeFile(join(upload, "tests", "fixtures", "plan-request.demo.json"), JSON.stringify({ setup: {} }));
  await writeFile(join(root, ".env"), "server-only-secret");
  let active: Record<string, any> | undefined = {
    name: "weekend-merge", script: join(root, "dist-server", "server.mjs"), cwd: root,
    env: { DEEPSEEK_API_KEY: "private-test-key", DEEPSEEK_MODEL: "deepseek-flash", PORT: "8787",
      QWEATHER_API_KEY: "private-weather-key", QWEATHER_API_HOST: "example.qweatherapi.com" },
  };
  const operations: string[] = [];
  const pm2 = (args: string[]) => {
    operations.push(args[0]);
    if (args[0] === "jlist") return JSON.stringify(active ? [{ name: active.name, pm2_env: {
      ...active.env, pm_exec_path: active.script, pm_cwd: active.cwd, exec_interpreter: process.execPath,
    } }] : []);
    if (args[0] === "startOrReload") {
      const config = JSON.parse(requireRead(args[1]));
      // Existing-name reload merges env but retains PM2's resolved executable.
      active = active ? { ...active, env: config.apps[0].env } : config.apps[0];
    }
    if (args[0] === "delete") active = undefined;
    if (args[0] === "start") active = JSON.parse(requireRead(args[1])).apps[0];
    return "";
  };
  return { root, release, pm2, operations, active: () => active! };
}

// PM2 reads its configuration synchronously, as the real CLI does.
import { readFileSync as requireRead } from "node:fs";

describe("server artifact deployment", () => {
  it("switches to the verified artifact and preserves the existing model environment and source", async () => {
    const f = await fixture();
    const paths: string[] = [];
    const fetcher = async (url: string, options?: RequestInit) => {
      paths.push(new URL(url).pathname);
      if (url.endsWith("/healthz")) return Response.json({ status: "ok", release: f.active().env.APP_RELEASE });
      if (options?.method === "POST") {
        expect(JSON.parse(String(options.body))).toMatchObject({ mode: "demo" });
        return new Response([
          ...[1, 2, 3].map(i => JSON.stringify({ type: "plan.proposed", plan: { id: `p${i}` } })),
          JSON.stringify({ type: "run.completed", result: { candidateIds: ["p1", "p2", "p3"] } }),
        ].join("\n"), { headers: { "content-type": "application/x-ndjson" } });
      }
      return new Response("<!doctype html>");
    };
    await deployRelease({ ...f, fetch: fetcher, pause: async () => {} });
    expect(f.active().script).toBe(join(f.root, ".deploy", "releases", f.release, "dist-server", "server.mjs"));
    expect(f.active().cwd).toBe(join(f.root, ".deploy", "releases", f.release));
    expect(f.active().env).toMatchObject({ DEEPSEEK_API_KEY: "private-test-key", DEEPSEEK_MODEL: "deepseek-flash", APP_RELEASE: f.release });
    expect(f.active().env).toMatchObject({ QWEATHER_API_KEY: "private-weather-key", QWEATHER_API_HOST: "example.qweatherapi.com" });
    expect(await readFile(join(f.root, ".env"), "utf8")).toBe("server-only-secret");
    expect(paths).toContain("/.netlify/functions/plan");
    expect(f.operations.at(-1)).toBe("save");
    expect(JSON.parse(await readFile(join(f.root, ".deploy", "current.json"), "utf8")).release).toBe(f.release);
  });

  it("restores the previous script and environment when the new release fails its health check", async () => {
    const f = await fixture();
    const fetcher = async () => new Response("failed", { status: f.active().env.APP_RELEASE ? 503 : 200 });
    await expect(deployRelease({ ...f, fetch: fetcher, pause: async () => {} })).rejects.toThrow(/rolled back/i);
    expect(f.active().script).toBe(join(f.root, "dist-server", "server.mjs"));
    expect(f.active().env.DEEPSEEK_API_KEY).toBe("private-test-key");
    expect(f.active().env.QWEATHER_API_KEY).toBe("private-weather-key");
    expect(f.active().env.APP_RELEASE).toBeFalsy();
    expect(f.operations.filter(x => x === "start")).toHaveLength(2);
    await expect(readFile(join(f.root, ".deploy", "current.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects path traversal release names before touching PM2", async () => {
    const f = await fixture();
    await expect(deployRelease({ ...f, release: "../../outside" })).rejects.toThrow(/release/i);
    expect(f.operations).toEqual([]);
    expect(await readFile(join(f.root, ".env"), "utf8")).toBe("server-only-secret");
  });

  it("rolls back if the API smoke response fails despite a healthy static site", async () => {
    const f = await fixture();
    const fetcher = async (url: string) => url.endsWith("/healthz")
      ? Response.json({ status: "ok", release: f.release }) : new Response("<!doctype html>");
    await expect(deployRelease({ ...f, fetch: fetcher, pause: async () => {} })).rejects.toThrow(/rolled back/i);
    expect(f.active().script).toBe(join(f.root, "dist-server", "server.mjs"));
  });
});
