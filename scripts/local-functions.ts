import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { loadEnv, type Plugin } from "vite";
import type { createGroupRuntime } from "../server/groups/runtime";

function toRequest(request: IncomingMessage, url: URL) {
  const method = request.method ?? "GET";
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }
  const init: RequestInit & { duplex?: "half" } = { method, headers };
  if (method !== "GET" && method !== "HEAD") {
    init.body = Readable.toWeb(request) as ReadableStream<Uint8Array>;
    init.duplex = "half";
  }
  return new Request(url, init);
}

async function sendResponse(response: Response, target: ServerResponse) {
  target.writeHead(response.status, Object.fromEntries(response.headers));
  if (!response.body) {
    target.end();
    return;
  }
  await pipeline(Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>), target);
}

export function localFunctions(): Plugin {
  return {
    name: "weekend-merge-local-functions",
    apply: "serve",
    configureServer(server) {
      const { mode, envDir } = server.config;
      const env = { ...process.env, ...loadEnv(mode, envDir, ["DEEPSEEK_", "QWEATHER_", "GROUP_DB_PATH", "GROUP_JOB_CONCURRENCY", "PUBLIC_ORIGIN"]) };
      let runtime: Promise<ReturnType<typeof createGroupRuntime>> | undefined;
      let selectedOrigin: string | undefined;
      let closed = false;
      server.httpServer?.once("close", () => { closed = true; void runtime?.then(app => app.close()); });
      server.middlewares.use((incoming, outgoing, next) => {
        const path = (incoming.url ?? "/").split("?")[0];
        if (!path.startsWith("/api") && !path.startsWith("/.netlify/functions/")) {
          next();
          return;
        }
        const execute = async () => {
          if (closed) throw new Error("SERVER_CLOSED");
          // The runtime accepts HTTP only for explicit loopback development.
          const publicOrigin = env.PUBLIC_ORIGIN || `http://${incoming.headers.host ?? "localhost:5173"}`;
          if (!runtime) {
            runtime = server.ssrLoadModule("/server/groups/runtime.ts").then(module =>
              (module.createGroupRuntime as typeof createGroupRuntime)({ env, publicOrigin, development: true }));
            selectedOrigin = new URL(publicOrigin).origin;
          }
          const request = toRequest(incoming, new URL(incoming.url ?? "/", selectedOrigin));
          const ip = createHash("sha256").update(String(incoming.socket.remoteAddress ?? "unknown")).digest("hex");
          return (await runtime).handle(request, ip);
        };
        void execute()
          .then((response) => response ? sendResponse(response, outgoing) : next())
          .catch(() => {
            if (outgoing.destroyed || outgoing.headersSent) return;
            outgoing.writeHead(500, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
            outgoing.end(JSON.stringify({ error: { code: "SERVICE_UNAVAILABLE", message: "本地服务无法完成请求，请检查Node SQLite与来源配置。", retryable: true } }));
          });
      });
    },
  };
}
