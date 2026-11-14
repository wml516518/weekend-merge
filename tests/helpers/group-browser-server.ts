// Local verification only. Never packaged/deployed. Real HTTP, API, queue and SQLite.
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { createGroupRuntime } from '../../server/groups/runtime';
import { createDefaultGroupRunner } from '../../server/groups/worker';

const port = Number(process.env.PORT ?? 8791);
const origin = `http://127.0.0.1:${port}`;
let release!: () => void;
const gate = new Promise<void>(done => { release = done; });
const started: string[] = [];
const completed: string[] = [];
const runner = createDefaultGroupRunner({ env: {} }); // No credentials or external requests.
const runtime = createGroupRuntime({ path: process.env.GROUP_DB_PATH!, publicOrigin: origin, development: true, env: {}, run: async (job, emit) => {
  started.push(job.groupId); await gate; await runner(job, emit); completed.push(job.groupId);
} });
const server = createServer(async (incoming, outgoing) => {
  try {
    const url = new URL(incoming.url ?? '/', origin);
    if (url.pathname === '/__test/release' && incoming.method === 'POST') { release(); outgoing.end('ok'); return; }
    if (url.pathname === '/__test/runs') { outgoing.setHeader('Content-Type', 'application/json'); outgoing.end(JSON.stringify({ started, completed })); return; }
    const init: RequestInit & { duplex?: 'half' } = { method: incoming.method, headers: incoming.headers as Record<string, string> };
    if (!['GET', 'HEAD'].includes(incoming.method!)) { init.body = Readable.toWeb(incoming) as ReadableStream<Uint8Array>; init.duplex = 'half'; }
    const response = await runtime.handle(new Request(url, init), 'controlled-loopback');
    if (response) { outgoing.writeHead(response.status, Object.fromEntries(response.headers)); outgoing.end(Buffer.from(await response.arrayBuffer())); return; }
    const path = url.pathname.startsWith('/assets/') ? url.pathname : '/index.html';
    outgoing.setHeader('Content-Type', ({ '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' } as Record<string, string>)[extname(path)] ?? 'application/octet-stream');
    outgoing.end(await readFile(join(process.cwd(), 'dist', path)));
  } catch { outgoing.statusCode = 500; outgoing.end('Controlled server failure'); }
});
server.listen(port, '127.0.0.1');
process.on('SIGTERM', () => { release(); server.close(() => { void runtime.close().then(() => process.exit(0)); }); });
