import { z, ZodError } from 'zod';
import { PersonPreferencesSchema, PlanSetupSchema, ReplanReasonCodeSchema } from '../../src/contracts/agent';
import { validateRequestDate } from '../../netlify/functions/agent/requestProtection';
import { digest, GroupError, newToken } from './auth';
import type { GroupRepository } from './repository';

export interface GroupApiOptions {
  publicOrigin?: string;
  development?: boolean;
  now?: () => number;
}

/** Never derive the public origin from a Host or forwarded header. */
export function groupPublicOrigin(options: GroupApiOptions): string {
  let url: URL;
  try { url = new URL(options.publicOrigin ?? ''); }
  catch { throw new Error('PUBLIC_ORIGIN must be configured as a canonical HTTPS origin'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
      (url.protocol !== 'https:' && !(options.development === true && url.protocol === 'http:' && loopback))) {
    throw new Error('PUBLIC_ORIGIN must be HTTPS; explicit loopback development may use HTTP');
  }
  return url.origin;
}

const name = z.string().trim().min(1).max(40);
const token = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const version = z.number().int().nonnegative();
const targetCount = z.number().int().min(2).max(6);
const empty = z.object({}).strict();
const createSchema = z.object({ name, nickname: name, targetCount, setup: PlanSetupSchema }).strict();
const roundSchema = z.object({ targetCount, setup: PlanSetupSchema }).strict();
const joinSchema = z.object({ token, nickname: name, handoff: z.boolean().optional() }).strict();
const recoverSchema = z.object({ token }).strict();
const saveSchema = z.object({ memberId: z.string().uuid(), version, preferences: PersonPreferencesSchema, submit: z.boolean(), idempotencyKey: z.string().min(1).max(128) }).strict();
const selectSchema = z.object({ version, planId: z.string().min(1).max(200), lockedStopIds: z.array(z.string().min(1).max(200)).max(10) }).strict();
const replanSchema = z.object({ version, rejectedStopId: z.string().min(1).max(200), reason: z.string().trim().min(1).max(500), reasonCode: ReplanReasonCodeSchema.optional() }).strict();
const finalizeSchema = z.object({ version, planId: z.string().min(1).max(200) }).strict();

class HttpError extends Error { constructor(readonly status: number, readonly code: string) { super(code); } }
const messages: Record<string, string> = {
  FORBIDDEN: '没有权限访问此小组或成员。', ORIGIN_FORBIDDEN: '请从本站页面提交请求。',
  GROUP_UNAVAILABLE: '小组不存在或已过期。', INVITE_UNAVAILABLE: '邀请已失效，请联系发起人。', RECOVERY_UNAVAILABLE: '恢复码无效或已过期。',
  GROUP_FULL: '小组人数已满。', VERSION_CONFLICT: '内容已更新，请刷新后重试。', ROUND_FROZEN: '本轮已进入规划，请由发起人开始新一轮。',
  INVALID_DATE: '出游日期须为上海时间今天起的180天内，请开始新一轮修改日期。',
  REQUEST_TOO_LARGE: '请求不能超过32 KiB。', RATE_LIMITED: '操作过于频繁，请稍后重试。',
  NOT_FOUND: '接口不存在。', METHOD_NOT_ALLOWED: '此接口不支持该请求方法。', INVALID_REQUEST: '请求内容或格式不正确。',
  INTERNAL_ERROR: '服务暂时无法完成操作，请稍后重试。', RESULT_NOT_READY: '本轮结果尚不可操作，请查看当前状态。',
};
function failure(error: unknown): Response {
  let status = 500; let code = 'INTERNAL_ERROR';
  if (error instanceof HttpError) { status = error.status; code = error.code; }
  else if (error instanceof ZodError || error instanceof SyntaxError) { status = 400; code = 'INVALID_REQUEST'; }
  else if (error instanceof GroupError) {
    code = error.code;
    status = code === 'FORBIDDEN' ? 403 : ['GROUP_UNAVAILABLE', 'INVITE_UNAVAILABLE', 'RECOVERY_UNAVAILABLE', 'MEMBER_UNAVAILABLE'].includes(code) ? 404
      : code.startsWith('INVALID_') ? 400 : 409;
  }
  return Response.json({ error: { code, message: messages[code] ?? (status === 400 ? '请求参数不正确。' : '当前状态无法执行此操作，请刷新查看。'), retryable: status === 429 || status === 500 } },
    { status, headers: status === 429 ? { 'Retry-After': '60' } : undefined });
}

export async function readGroupJsonBody(request: Request): Promise<unknown> {
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new HttpError(400, 'INVALID_REQUEST');
  const length = request.headers.get('content-length');
  if (length && Number(length) > 32768) { void request.body?.cancel().catch(() => {}); throw new HttpError(413, 'REQUEST_TOO_LARGE'); }
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  if (reader) {
    try {
      while (true) {
        const chunk = await reader.read(); if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 32768) { void reader.cancel().catch(() => {}); throw new HttpError(413, 'REQUEST_TOO_LARGE'); }
        chunks.push(chunk.value);
      }
    } finally { reader.releaseLock(); }
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new HttpError(400, 'INVALID_REQUEST'); }
}

/** Fixed windows, separate IP/browser buckets, fail closed at capacity (no eviction bypass). */
function limiter() {
  const entries = new Map<string, { until: number; count: number }>();
  return {
    allow(keys: string[], now: number, max: number, windowMs: number): boolean {
      for (const [key, entry] of entries) if (entry.until <= now) entries.delete(key);
      if (keys.some(key => (entries.get(key)?.count ?? 0) >= max)) return false;
      if (entries.size + keys.filter(key => !entries.has(key)).length > 5000) return false;
      for (const key of keys) {
        const entry = entries.get(key) ?? { until: now + windowMs, count: 0 };
        entry.count++; entries.set(key, entry);
      }
      return true;
    },
    close() { entries.clear(); },
  };
}

export function createGroupApi(repo: GroupRepository, options: GroupApiOptions = {}) {
  const origin = groupPublicOrigin(options);
  const secure = new URL(origin).protocol === 'https:';
  const cookieName = secure ? '__Host-weekend_group' : 'weekend_group_dev';
  const now = options.now ?? Date.now;
  const regular = limiter(); const expensive = limiter();
  let closed = false;
  function validateDate(date: string) {
    if (validateRequestDate(date, new Date(now()))) throw new HttpError(400, 'INVALID_DATE');
  }
  return {
    close() { closed = true; regular.close(); expensive.close(); },
    async handle(request: Request, clientKey: string): Promise<Response> {
      let issued: string | undefined;
      let response: Response;
      try {
        if (closed) throw new HttpError(503, 'INTERNAL_ERROR');
        const url = new URL(request.url);
        if (url.origin !== origin) throw new HttpError(403, 'ORIGIN_FORBIDDEN');
        const segments = url.pathname.split('/').filter(Boolean);
        if (segments[0] !== 'api' || segments[1] !== 'groups' || /%|\/\//.test(url.pathname)) throw new HttpError(404, 'NOT_FOUND');
        const parts = segments.slice(2);
        const route = parts.length === 0 ? 'root' : parts.length === 1 && ['join', 'recover'].includes(parts[0]) ? parts[0]
          : /^[0-9a-f-]{36}$/.test(parts[0] ?? '') ? (parts.length === 1 ? 'detail'
            : parts.length === 2 && ['events', 'preferences', 'invite', 'round', 'retry', 'select', 'replan', 'finalize'].includes(parts[1]) ? parts[1]
              : parts.length === 4 && parts[1] === 'members' && /^[0-9a-f-]{36}$/.test(parts[2]) && parts[3] === 'remove' ? 'remove' : undefined) : undefined;
        if (!route) throw new HttpError(404, 'NOT_FOUND');
        const read = request.method === 'GET';
        const allowed = route === 'root' ? ['GET', 'POST'] : ['detail', 'events'].includes(route) ? ['GET'] : ['POST'];
        if (!allowed.includes(request.method)) throw new HttpError(405, 'METHOD_NOT_ALLOWED');
        if (!read && request.headers.get('origin') !== origin) throw new HttpError(403, 'ORIGIN_FORBIDDEN');
        const cookies = (request.headers.get('cookie') ?? '').split(';').map(c => c.trim()).filter(c => c.startsWith(`${cookieName}=`));
        let credential = cookies.length === 1 ? cookies[0].slice(cookieName.length + 1) : '';
        if (!/^[A-Za-z0-9_-]{43}$/.test(credential)) { credential = newToken(); issued = credential; }
        const session = digest(credential);
        const ip = digest(clientKey.slice(0, 512) || 'unknown');
        if (!regular.allow([`ip:${ip}`, `browser:${session}`], now(), 120, 60_000)) throw new HttpError(429, 'RATE_LIMITED');
        if (!read && (route === 'root' || ['round', 'retry', 'replan'].includes(route)) &&
            !expensive.allow([`ip:${ip}`, `browser:${session}`], now(), 5, 600_000)) throw new HttpError(429, 'RATE_LIMITED');
        const body = read ? undefined : await readGroupJsonBody(request);
        let value: unknown; let status = 200;
        if (route === 'root') {
          if (read) value = { groups: repo.list(session) };
          else { const input = createSchema.parse(body); validateDate(input.setup.date); value = repo.create(session, input.name, input.nickname, input.targetCount, input.setup); status = 201; }
        } else if (route === 'join') { const input = joinSchema.parse(body); value = repo.join(session, input.token, input.nickname, { handoff: input.handoff }); }
        else if (route === 'recover') value = repo.recover(session, recoverSchema.parse(body).token);
        else {
          const id = parts[0];
          if (route === 'detail') value = repo.view(session, id);
          else if (route === 'events') {
            const afterRaw = url.searchParams.get('after') ?? '0'; const limitRaw = url.searchParams.get('limit') ?? '100';
            if (!/^\d{1,10}$/.test(afterRaw) || !/^\d{1,3}$/.test(limitRaw) || Number(limitRaw) < 1 || Number(limitRaw) > 100) throw new HttpError(400, 'INVALID_REQUEST');
            const view = repo.view(session, id); const after = Number(afterRaw);
            const events = (view.job?.events ?? []).filter(event => event.sequence > after).slice(0, Number(limitRaw));
            value = { revision: view.revision, state: view.state, jobId: view.job?.id ?? null, events, nextAfter: events.at(-1)?.sequence ?? after };
          } else if (route === 'preferences') { const input = saveSchema.parse(body); if (input.submit) validateDate(repo.view(session, id, input.memberId).setup.date); value = repo.save(session, id, input); }
          else if (route === 'round') { const input = roundSchema.parse(body); validateDate(input.setup.date); value = repo.newRound(session, id, input.setup, input.targetCount); }
          else if (route === 'select') value = repo.select(session, id, selectSchema.parse(body));
          else if (route === 'finalize') value = repo.finalize(session, id, finalizeSchema.parse(body));
          else if (route === 'replan') { const input = replanSchema.parse(body); validateDate(repo.view(session, id).setup.date); value = repo.replan(session, id, input); }
          else {
            empty.parse(body);
            if (route === 'invite') value = repo.rotateInvite(session, id);
            else if (route === 'remove') value = repo.removeMember(session, id, parts[2]);
            else { validateDate(repo.view(session, id).setup.date); value = repo.retry(session, id); }
          }
        }
        response = Response.json(value, { status });
      } catch (error) { response = failure(error); }
      response.headers.set('Cache-Control', 'no-store');
      response.headers.set('X-Content-Type-Options', 'nosniff');
      response.headers.set('Referrer-Policy', 'no-referrer');
      if (issued) response.headers.set('Set-Cookie', `${cookieName}=${issued}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${secure ? '; Secure' : ''}`);
      return response;
    },
  };
}
