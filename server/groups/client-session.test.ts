// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { GroupRepository } from './repository';
import { createGroupApi } from './api';
import type { GroupCreated, GroupJoined, GroupView } from '../../src/contracts/groups';

const origin = 'https://weekend.example';
const setup = { city: '上海', date: '2026-11-15', startTime: '13:00', endTime: '20:00', budget: 300, startingArea: '徐汇' };
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

it.each(['recover', 'create', 'join'] as const)('fences a late fresh-cookie list before %s and keeps the resulting grant usable', async (kind) => {
  const repo = new GroupRepository({ path: ':memory:' });
  const api = createGroupApi(repo, { publicOrigin: origin, now: () => Date.parse('2026-11-14T00:00:00Z') });
  const source = repo.create('owner-session', '已有计划', '甲', 2, setup);
  let cookie = ''; let issued = 0; let release!: () => void; let initial = true;
  const delayed = new Promise<void>(done => { release = done; });
  vi.stubGlobal('fetch', async (path: string, options: RequestInit = {}) => {
    const hold = initial && path === '/api/groups' && !options.method;
    if (hold) initial = false;
    const response = await api.handle(new Request(origin + path, { ...options,
      headers: { ...options.headers, Origin: origin, ...(cookie ? { Cookie: cookie } : {}) } }), 'same-ip');
    // Model browser Set-Cookie application at response delivery, not request start.
    if (hold) await delayed;
    const next = response.headers.get('set-cookie');
    if (next) { cookie = next.split(';')[0]; issued++; }
    return response;
  });
  try {
    vi.resetModules();
    const { groupClient } = await import('../../src/features/groups/client');
    const listing = groupClient.list();
    const mutation = kind === 'recover' ? groupClient.recover(source.ownerRecoveryToken)
      : kind === 'join' ? groupClient.join(source.inviteToken, '乙')
        : groupClient.create({ name: '新计划', nickname: '甲', targetCount: 2, setup });
    let mutationFinished = false;
    void mutation.then(() => { mutationFinished = true; });
    // Attempt the problematic order: deliver mutation while the cookieless list is held.
    await new Promise(done => setTimeout(done, 10));
    const crossedBootstrap = mutationFinished;
    release();
    const result = await mutation as GroupCreated | GroupJoined | GroupView;
    await listing;
    const view = 'group' in result ? result.group : result;
    const subsequent = await groupClient.get(view.id);
    expect(subsequent.id).toBe(view.id);
    expect(subsequent.canManage).toBe(kind !== 'join');
    expect(subsequent.myMembers).toHaveLength(kind === 'recover' ? 0 : 1);
    expect(crossedBootstrap).toBe(false);
    expect(issued).toBe(1);
  } finally { release(); api.close(); repo.close(); }
});
