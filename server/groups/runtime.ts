import { homedir } from 'node:os';
import { join } from 'node:path';
import { createPlanHandler } from '../../netlify/functions/plan';
import { createGroupApi, groupPublicOrigin, readGroupJsonBody, type GroupApiOptions } from './api';
import { GroupRepository } from './repository';
import { GroupWorker, createDefaultGroupRunner, type GroupRunner } from './worker';

export interface GroupRuntimeOptions extends GroupApiOptions {
  path?: string;
  concurrency?: number;
  run?: GroupRunner;
  env?: Record<string, string | undefined>;
}

/** Shared Node/Vite boundary; undefined means the static/share handler may continue. */
export function createGroupRuntime(options: GroupRuntimeOptions) {
  const origin = groupPublicOrigin(options);
  const env = options.env ?? process.env;
  // A persistent user data directory, never the release or static directory.
  const path = options.path ?? env.GROUP_DB_PATH ?? join(homedir(), '.local', 'share', 'weekend-merge', 'groups.sqlite');
  const concurrency = options.concurrency ?? Number(env.GROUP_JOB_CONCURRENCY ?? 2);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new Error('INVALID_CONCURRENCY');
  const repo = new GroupRepository({ path, now: options.now });
  const api = createGroupApi(repo, { ...options, publicOrigin: origin });
  const now = options.now ? () => new Date(options.now!()) : undefined;
  const worker = new GroupWorker(repo, { concurrency, run: options.run ?? createDefaultGroupRunner({ env, now }) });
  const demo = createPlanHandler({ env: {}, now });
  worker.start();
  let closing: Promise<void> | undefined;
  function error(status: number, code: string, message: string) {
    return Response.json({ error: { code, message, retryable: false } }, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
  }
  return {
    async handle(request: Request, clientKey: string): Promise<Response | undefined> {
      const url = new URL(request.url);
      if (url.pathname === '/api/groups' || url.pathname.startsWith('/api/groups/')) return api.handle(request, clientKey);
      if (url.pathname === '/.netlify/functions/plan') {
        if (request.method !== 'POST') return error(405, 'METHOD_NOT_ALLOWED', '请使用POST请求。');
        let body: unknown;
        try { body = await readGroupJsonBody(request); }
        catch (caught) { const large = caught instanceof Error && caught.message === 'REQUEST_TOO_LARGE'; return error(large ? 413 : 400, large ? 'REQUEST_TOO_LARGE' : 'INVALID_REQUEST', '请求格式不正确或超过32 KiB。'); }
        if (!body || typeof body !== 'object' || !('mode' in body) || body.mode !== 'demo') return error(403, 'GROUP_REQUIRED', '请通过小组完成成员提交后开始规划。');
        return demo(new Request(new URL('/.netlify/functions/plan', origin), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
      }
      if (url.pathname === '/.netlify/functions/replan') return error(403, 'GROUP_REQUIRED', '请在小组内调整已保存的方案。');
      if (url.pathname === '/api' || url.pathname.startsWith('/api/') || url.pathname.startsWith('/.netlify/functions/')) return error(404, 'NOT_FOUND', '接口不存在。');
      return undefined;
    },
    close(): Promise<void> {
      if (!closing) { api.close(); closing = worker.stop().then(() => repo.close()); }
      return closing;
    },
  };
}
