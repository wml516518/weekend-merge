import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { loadEnv, type Plugin } from "vite";

const planPath = "/.netlify/functions/plan";
const replanPath = "/.netlify/functions/replan";
type Handler = (request: Request) => Promise<Response>;

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
      const env = loadEnv(mode, envDir, ["DEEPSEEK_", "QWEATHER_"]);
      let planHandler: Promise<Handler> | undefined;
      const getPlanHandler = () => planHandler ??= server.ssrLoadModule("/netlify/functions/plan.ts")
        .then((module) => (module.createPlanHandler as (options: { env: Record<string, string> }) => Handler)({ env }));
      server.middlewares.use((incoming, outgoing, next) => {
        const url = new URL(incoming.url ?? "/", "http://localhost");
        if (url.pathname !== planPath && url.pathname !== replanPath) {
          next();
          return;
        }
        const execute = async () => {
          const request = toRequest(incoming, url);
          if (url.pathname === planPath) {
            return (await getPlanHandler())(request);
          }
          const { default: replan } = await server.ssrLoadModule("/netlify/functions/replan.ts") as { default: Handler };
          return replan(request);
        };
        void execute()
          .then((response) => sendResponse(response, outgoing))
          .catch(() => {
            if (outgoing.destroyed || outgoing.headersSent) return;
            outgoing.writeHead(500, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
            outgoing.end(JSON.stringify({ error: { code: "PLANNING_FAILED", message: "Local function could not complete the request.", retryable: true } }));
          });
      });
    },
  };
}
