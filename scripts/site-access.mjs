// Server-side only. The same credentials are used by deploy checks and site entry points.
export function siteAuthorization(env = {}) {
  if (env.WEEKEND_AUTH_ENABLED?.trim().toLowerCase() !== 'true' || !env.WEEKEND_AUTH_PASSWORD) return;
  const credentials = `${env.WEEKEND_AUTH_USERNAME || 'admin'}:${env.WEEKEND_AUTH_PASSWORD}`;
  return `Basic ${btoa(Array.from(new TextEncoder().encode(credentials), byte => String.fromCharCode(byte)).join(''))}`;
}

export function loginChallenge(header, env) {
  if (header === siteAuthorization(env)) return;
  return new Response('请登录周末共识局。', { status: 401, headers: {
    'WWW-Authenticate': 'Basic realm="Weekend Merge", charset="UTF-8"',
    'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store',
  } });
}
