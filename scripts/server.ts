import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import planHandler from "../netlify/functions/plan";
import replanHandler from "../netlify/functions/replan";

const planPath = "/.netlify/functions/plan";
const replanPath = "/.netlify/functions/replan";
const staticRoot = resolve(process.env.STATIC_ROOT ?? "dist");
const trustedProxyDepth = Math.max(1, Number(process.env.TRUSTED_PROXY_DEPTH ?? 1));
const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 8787);

const contentTypeByExtension: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

function jsonError(target: ServerResponse, status: number, code: string, message: string, retryable = false): void {
  if (target.headersSent) {
    target.end();
    return;
  }
  target.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Content-Type-Options": "nosniff",
  });
  target.end(JSON.stringify({ error: { code, message, retryable } }));
}

function toRequest(incoming: IncomingMessage, url: URL): Request {
  const method = incoming.method ?? "GET";
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }
  const init: RequestInit & { duplex?: "half" } = { method, headers };
  if (method !== "GET" && method !== "HEAD") {
    init.body = Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
    init.duplex = "half";
  }
  return new Request(url, init);
}

async function sendResponse(response: Response, target: ServerResponse): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => { headers[name] = value; });
  target.writeHead(response.status, headers);
  if (!response.body) {
    target.end();
    return;
  }
  await pipeline(Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>), target);
}

function clientKey(incoming: IncomingMessage): string {
  const forwardedValues = Array.isArray(incoming.headers["x-forwarded-for"])
    ? incoming.headers["x-forwarded-for"]
    : [incoming.headers["x-forwarded-for"] ?? ""];
  const forwardedAddresses = forwardedValues.join(",").split(",").map((value) => value.trim()).filter(Boolean);
  const trustedIp = forwardedAddresses.at(-trustedProxyDepth) ?? String(incoming.socket.remoteAddress ?? "unknown");
  return createHash("sha256").update(trustedIp).digest("hex").slice(0, 32);
}

function serveStatic(target: ServerResponse, pathname: string): void {
  const decodedPath = decodeURIComponent(pathname);
  const relativePath = normalize(decodedPath).replace(/^(\.\.[/\\])+/, "");
  let filePath = join(staticRoot, relativePath === "/" ? "index.html" : relativePath);
  if (!filePath.startsWith(staticRoot)) return jsonError(target, 403, "FORBIDDEN", "Path is outside the static root.");
  if (!existsSync(filePath)) filePath = join(staticRoot, "index.html");
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    return jsonError(target, 404, "NOT_FOUND", "Static asset is unavailable.");
  }
  const extension = extname(filePath).toLowerCase();
  const isHtml = extension === ".html";
  target.writeHead(200, {
    "Cache-Control": isHtml ? "no-cache" : "public, max-age=31536000, immutable",
    "Content-Type": contentTypeByExtension[extension] ?? "application/octet-stream",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Content-Type-Options": "nosniff",
  });
  pipeline(createReadStream(filePath), target).catch(() => target.destroy());
}

const server = createServer((incoming, target) => {
  const requestId = randomUUID();
  const startedAt = process.hrtime.bigint();
  target.setHeader("x-request-id", requestId);
  let url: URL;
  try {
    url = new URL(incoming.url ?? "/", `http://${incoming.headers.host ?? `${host}:${port}`}`);
  } catch {
    return jsonError(target, 400, "INVALID_REQUEST", "Invalid request URL.");
  }
  const finish = () => {
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    console.info(JSON.stringify({
      at: new Date().toISOString(),
      durationMs: Math.round(elapsedMs),
      method: incoming.method,
      path: url.pathname,
      requestId,
      status: target.statusCode,
    }));
  };
  target.on("finish", finish);
  if (url.pathname === "/healthz") {
    if (incoming.method !== "GET" && incoming.method !== "HEAD") return jsonError(target, 405, "METHOD_NOT_ALLOWED", "Use GET for health checks.");
    target.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    target.end(incoming.method === "HEAD" ? undefined : JSON.stringify({ status: "ok", release: process.env.APP_RELEASE || "local" }));
    return;
  }
  if (url.pathname !== planPath && url.pathname !== replanPath) {
    serveStatic(target, url.pathname);
    return;
  }
  if (incoming.method !== "POST") {
    return jsonError(target, 405, "METHOD_NOT_ALLOWED", "Use POST to call this API.");
  }
  const execute = async () => {
    const request = toRequest(incoming, url);
    request.headers.set("x-nf-client-connection-ip", clientKey(incoming));
    return url.pathname === planPath ? planHandler(request) : replanHandler(request);
  };
  void execute()
    .then(async (response) => {
      for (const [name, value] of [
        ["Permissions-Policy", "camera=(), microphone=(), geolocation=()"],
        ["Referrer-Policy", "strict-origin-when-cross-origin"],
        ["X-Content-Type-Options", "nosniff"],
      ] as const) response.headers.set(name, value);
      await sendResponse(response, target);
    })
    .catch(() => jsonError(target, 500, "PLANNING_FAILED", "Planning could not be completed.", true));
});

server.headersTimeout = 70_000;
server.keepAliveTimeout = 65_000;
server.requestTimeout = 75_000;
process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));
server.listen(port, host, () => {
  console.info(`weekend-merge server listening on http://${host}:${port}`);
});
