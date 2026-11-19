export function siteAuthorization(env?: Record<string, string | undefined>): string;
export function loginChallenge(header: string | undefined | null, env: Record<string, string | undefined>): Response | undefined;
