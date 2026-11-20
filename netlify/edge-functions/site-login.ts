import { loginChallenge } from '../../scripts/site-access.mjs';

export default async function(request: Request, context: { next(): Promise<Response> }) {
  const denied = loginChallenge(request.headers.get('authorization'), {
    WEEKEND_AUTH_ENABLED: Netlify.env.get('WEEKEND_AUTH_ENABLED'),
    WEEKEND_AUTH_USERNAME: Netlify.env.get('WEEKEND_AUTH_USERNAME'),
    WEEKEND_AUTH_PASSWORD: Netlify.env.get('WEEKEND_AUTH_PASSWORD'),
  });
  if (denied) return denied;
  const response = await context.next();
  response.headers.set('Cache-Control', 'private, no-store');
  return response;
}
