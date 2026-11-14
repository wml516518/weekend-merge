import { createHash, randomBytes, randomUUID } from 'node:crypto';

/** Input sessions are opaque credential digests supplied by the HTTP layer. */
export function digest(value: string): string {
  if (typeof value !== 'string' || !value.length || value.length > 512) throw new Error('INVALID_CREDENTIAL');
  return createHash('sha256').update(value).digest('hex');
}
export const newId = () => randomUUID();
export const newToken = () => randomBytes(32).toString('base64url');
export class GroupError extends Error {
  constructor(public readonly code: string) { super(code); this.name = 'GroupError'; }
}
export function check(condition: unknown, code: string): asserts condition {
  if (!condition) throw new GroupError(code);
}
