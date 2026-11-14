# Multi-group Planning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver independent invitation-based groups of 2–6 people, starting a persistent Agent job only when every member submits.

**Architecture:** Extend the existing Agent core to accept anonymous participant lists while retaining legacy demo contracts. A SQLite repository owns browser grants, invitations, immutable revisions and job state; the Node HTTP API and bounded worker execute those snapshots. A new group interface becomes the live entry point and retains the existing demo/read-only shares.

**Tech Stack:** TypeScript, React 19, Zod, Node 22.11 `node:sqlite`, Vitest, existing Vite/esbuild/PM2/GitHub Actions stack.

**Spec:** `docs/superpowers/specs/2026-11-14-group-planning-design.md`

## Global Constraints

- 每个出游小组有 2–6 人，创建时先确定人数。
- 全员提交完成后，服务端统一将本组填写内容交给 Agent。
- 多个小组可以同时填写、等待规划、查看各自结果，互不覆盖。
- 原始偏好只允许本人读取和修改，服务端从登录凭据确定成员身份。
- Agent 并发执行数初始设为 2，其余任务按入队时间等待。
- 数据库记录保留到创建后 30 天；邀请在创建 7 天后或进入规划阶段时失效。
- 总预算范围为 100 元到 `人数 × 2,000 元`。
- 使用 Node 内置 `node:sqlite`；Node 22.11 仅服务器启动参数启用 `--experimental-sqlite`。
- 数据文件位于 `/home/admin/apps/weekend-merge/data-runtime/groups.sqlite`，不放进每次替换的 `.deploy/releases` 目录。
- 模型方案失败而使用规则规划时必须如实展示来源与降级。
- No paid service, no API keys/capabilities/raw preferences in logs, no destructive migration or unrelated changes.
- Every task uses test-first changes, focused verification then a full test/build check before its commit. All local edits use apply_patch. Do not dispatch subagents from a worker.

## File responsibilities and shared interfaces

- `src/contracts/agent.ts`: accepts legacy `{a,b}` and new `{participants:[{id,preferences}]}` through a normalized helper; all consumers use the helper. Existing exported types remain backward compatible.
- `src/contracts/groups.ts`: public group/create/save/action schemas and view types; no server secrets.
- `server/groups/database.ts`, `repository.ts`, `auth.ts`: migrations, synchronous short transactions, credentials and persistent state. Never network inside a transaction.
- `server/groups/worker.ts`, `api.ts`: leased queue, streamed event persistence, authorization, bounded HTTP and origin/rate policies.
- `src/features/groups/client.ts`, `GroupApp.tsx`, supporting components/style: browser API, invite/recovery exchange, own-form state, lobby and shared results.
- `scripts/server.ts`, `scripts/deploy.mjs`, `scripts/backup-groups.mjs`, CI and deployment docs: production integration, stable paths, consistent online backups and runtime compatibility.

### Task 1: Multi-person Agent contracts and behavior

**Files:** Modify `src/contracts/agent.ts`, `netlify/functions/agent/{deepseek,orchestrator,model}.ts`, `netlify/functions/agent/tools/{preferences,budget,validator,registry,contracts}.ts`, `netlify/functions/agent/fallbacks/{consensus,rulePlanner}.ts`, `netlify/functions/replan.ts`; add `netlify/functions/agent/groups.test.ts`; modify related existing tests as necessary.

**Interfaces:** Export `Participant = {id:string;preferences:PersonPreferences}`, `PlanningPreferences` (legacy a/b OR participants), `getParticipants(preferences:PlanningPreferences):Participant[]`. PlanRequest/ReplanRequest accept either representation; all fresh group snapshots use participants only. Keep existing demo imports/tests working. PlanSetup budget protocol ceiling increases to 12000; group-count ceiling is enforced by group API (legacy HTTP must retain appropriate 2-person limits).

- [ ] Write failing tests for six-person venue/transport costs, strictest walking limit, union of avoidances, support-count interests, anonymous complete model input, replan using the same members and truthful fallback. Start with a real six-person request and compare validated totals to `venue.max * 6 + legs * 4 * 6`, plus 10% budget buffer.

```ts
const people = Array.from({length:6}, (_,i) => ({id:`member-${i}`,preferences:basePreferences}));
const input = {...baseRequest, preferences:{participants:people}};
expect(getParticipants(input.preferences)).toHaveLength(6);
```

- [ ] Run `npm test -- --run netlify/functions/agent/groups.test.ts` and record missing multi-person behavior before changing implementation.
- [ ] Normalize preferences once through `getParticipants`; replace hardcoded a/b, quantity 2, dual-person prompts and fairness logic across planning/replanning with that list. Member IDs sent to the model must be opaque anonymous IDs, never nicknames. Costs use actual participant count; hard avoidances use union and walking uses minimum. Interest ordering accounts for coverage count and rank, and reasons describe coverage honestly.

```ts
const participants = getParticipants(request.preferences);
const walkingCap = Math.min(...participants.map(p=>p.preferences.walkingLimitKm));
const avoidance = [...new Set(participants.flatMap(p=>p.preferences.avoid))];
```

- [ ] Preserve three distinct legal candidates or explicit constraint failure. When model proposals/repair fail and rules run, emit `run.degraded`; never suppress it. Do not accept ISO stop times from the wrong outing date.
- [ ] Run focused Agent tests, full suite and build; commit `feat: support two to six participants throughout agent planning` and write report with commands/results.

### Task 2: SQLite repository and capability isolation

**Files:** Create `src/contracts/groups.ts`, `server/groups/{database,repository,auth}.ts`, `server/groups/repository.test.ts`; modify `.gitignore` and `tsconfig.functions.json` for server sources.

**Interfaces:** Export `GroupRepository` constructed with `{path:string, now?:()=>number}` and `close()`. Repository methods: `create(session,name,nickname,targetCount,setup)`, `join(session,token,nickname,{handoff?:boolean})`, `recover(session,token)`, `list(session)`, `view(session,groupId,memberId?)`, `save(session,groupId,{memberId,version,preferences,submit,idempotencyKey})`, `rotateInvite(session,groupId)`, `removeMember(session,groupId,memberId)`, `newRound(session,groupId,setup,targetCount)`, `retry(session,groupId)`, `claimJob()`, `appendEvent(jobId,lease,event)`, `finishJob(jobId,lease,state,error?)`, `recoverInterrupted()`, `cleanup()`. `session` is a credential digest; raw tokens only returned at create/rotate/new recovery issuance. It is acceptable to refine exact argument shapes when typed public contracts carry the final interface to later tasks; document changes in report.

**Public view:** `{id,name,targetCount,setup,revision,state,createdAt,expiresAt,inviteExpiresAt,members:[{id,nickname,submitted,owner}],myMembers:[{id,nickname,version,preferences?,submitted,owner}],job?:{id,state,attempt,events,result?,error?},finalPlanId?,selectedPlanId?,lockedStopIds?,replanCount}`. No other member raw answers or credentials. Persist browser selected member separately client-side; requests selecting a member still require corresponding grant.

- [ ] Write real in-memory/temp-file DB tests: unauthorized other-group/member access, duplicate final submit queues one snapshot/job, exact target count, 2/6 people, capacity, invite rotation/expiry, recovery with new session, handoff creates new blank member, version conflicts, remove revokes grants, new round invalidates submissions, persistence/restart and expiry cleanup.

```ts
const a=repo.create('browser-a','周末组','小王',2,setup);
repo.join('browser-b',a.inviteToken,'小李');
expect(()=>repo.view('browser-c',a.group.id)).toThrow();
```

- [ ] Run `npm test -- --run server/groups/repository.test.ts` and confirm missing repository fails before implementation.
- [ ] Implement versioned additive schema with WAL, foreign keys, unique group/revision snapshot and attempt constraints, hashed capabilities/sessions, cryptographic random IDs/tokens. Every multi-step mutation uses an immediate transaction with rollback. Validate target and budget server-side. Final submit atomically freezes anonymous participants and enqueues exactly one job; duplicate submit retries return original successful result without overwriting later edits.
- [ ] Store sessions/grants, recovery permissions separately for owner/member, 7-day invites/30-day groups; no raw token persistence. Enforce all expiry checks on reads and writes. Owner manages membership/conditions but cannot read others' raw preferences. Invite reopen for existing browser restores authorized member unless explicit handoff. New rounds require re-submission, immutable old snapshots remain unchanged.
- [ ] Implement lease-fenced job claim/events/result storage, retry attempts, interrupted-running failure and queued recovery. Store replan/final selection mutations with owner checks and version/race fencing; preserve snapshots.
- [ ] Run repository tests, full suite/build, commit `feat: persist isolated groups invitations and planning snapshots`, report final typed interfaces and migration details.

### Task 3: Authorized HTTP API and persistent worker

**Files:** Create `server/groups/{api,worker}.ts`, `server/groups/{api,worker}.test.ts`; modify `scripts/server.ts`, `scripts/local-functions.ts` as necessary.

**Interfaces:** `createGroupApi(repo, options?):{handle(request:Request,clientKey:string):Promise<Response>,close():void}`; `GroupWorker(repo,{concurrency?:number,run?:GroupRunner})` with `start()/stop()/tick()`; runner obtains immutable snapshot and emits AgentEvents, initial default uses `createModelAdapter`/existing orchestrator. API base `/api/groups`; GET list/detail/events, POST create/join/recover/save/rotate/remove/round/retry/select/replan/finalize. Exact paths documented in report for frontend. Store typed public contracts shared with UI. Cookie contains random browser credential with Secure HttpOnly SameSite=Lax Path=/, local HTTP permits non-Secure cookie only on loopback development. Production proxy origin uses a configured canonical `PUBLIC_ORIGIN`, not an unchecked forwarded header.

- [ ] Write failing API tests with independent cookie jars and real repository: cross-group 403, other-member 403, raw answers redacted, CSRF/missing/foreign origin rejection, body limit (32 KiB), rate limit, malformed/unknown paths, concurrent last submits. Worker tests use controlled runner to assert two groups get separate snapshots/events/results, concurrency 2 and third queued, refresh never re-enqueues, restart queued recovery/interrupted retry, stale-lease writes rejected.

```ts
await Promise.all([worker.tick(),worker.tick()]);
expect(started.map(x=>x.groupId)).toEqual(expect.arrayContaining([group1,group2]));
expect(started[0].snapshot.preferences).not.toEqual(started[1].snapshot.preferences);
```

- [ ] Run focused tests to observe missing HTTP/worker behavior.
- [ ] Wire persistent worker to Agent core with task-local model adapter, sanitized events, group/revision/attempt fencing and bounded concurrency. Avoid holding DB transaction over network. Persist emitted results before marking successful. Expose consensus only after freeze; before that do not leak derived private preferences.
- [ ] Implement all API operations with digest cookie authorization, same-origin checks, bounded streaming request read, browser/IP limit with bounded memory, structured Chinese error responses and no credential/body logging. Group actions rebuild requests from DB; owner cannot upload arbitrary full-group preferences. Replan uses locked stored plan and snapshot, serialized against other owner actions. Finalize persists selected legal plan. Graceful shutdown avoids closing DB under active tasks; startup marks interrupted work retryable and resumes queued tasks. Periodic expiry cleanup.
- [ ] Route `/api/groups` before static fallback. Keep legacy demo and read-only shares; reject old live plan/replan public requests in server production so group controls cannot be bypassed. Unknown API paths return JSON 404, never SPA HTML.
- [ ] Run focused tests/full suite/build and commit `feat: run authorized group jobs through persistent agent queue`. Report API route/payload/view examples for UI.

### Task 4: Invitation, independent forms, lobby and shared results UI

**Files:** Create `src/features/groups/{client,GroupApp,GroupCreate,GroupLobby,GroupResults}.tsx` (client `.ts`), `src/features/groups/groups.css`, `src/features/groups/GroupApp.test.tsx`; modify `src/app/App.tsx`, `src/features/wizard/PreferenceStep.tsx`, `src/state/usePlanningStore.ts`, tests and export/share as needed.

**Interfaces:** Existing App retains demo and share decoding; default live UI uses GroupApp. Client matches Task 3 API, `credentials:'same-origin'`, fragment invite/recover exchange through POST with history replaceState to remove credential. Use own member ID only for granted same-device switch; group state keyed by server ID/revision. Keep form labels accessible and existing design tokens/typography. Reuse itinerary/map/event renderers when compatible, but never invoke old public live endpoints from group pages.

- [ ] Write failing UI tests: create 2/6 group adjusts default/max total budget and shows per-person; invitation joins independently; submitting one waits and final submit shows queue; new group has blank preferences; switch own member/group/revision remounts blank or own server draft only; recovery error; nonowner cannot select/replan/finalize; selected/final plan synchronizes from server. Add store regression proving saveSetup clears previous a/b data.

```ts
store.getState().saveSetup(newSetup);
expect(store.getState().preferences).toEqual({});
```

- [ ] Run new UI/store tests and observe failures before implementation.
- [ ] Implement create form (2–6 members, creator nickname/name, dates/time/Shanghai area), list my groups, lobby showing status only, invitation/recovery copying and recovery warning, rotation/removal/new round, explicit same-device handoff and identity switch. Surface errors and expiry accurately; support refresh/deep-link recovery without storing capability in localStorage. Keep forms keyed `groupId:memberId:revision` with server version conflict notice and explicit sync action, no implicit reset of dirty edits on polling.
- [ ] Poll every 3 s, hidden 15 s, immediate visibility refresh with cancellation/stale response protection. Own submitted draft can be edited only before queued. Everyone sees persistent events, honest tool/model fallback source, consensus interest support and same candidate set. Owners select/lock/replan/finalize; others view. Show actual headcount/total and per-person costs, member interest coverage and honest static catalog/route estimate labels. Export/share actual headcount; maintain old share snapshots parsing.
- [ ] Preserve existing demo, UI responsive to 360px, keyboard labels and reduced motion. Run UI suite/full tests/build, commit `feat: add independent group invitation and planning interface`.

### Task 5: Production persistence, backups, CI and full-flow verification

**Files:** Modify `package.json`, `.github/workflows/ci.yml`, `scripts/{deploy,verify-deploy,setup-deploy}.mjs`, `docs/DEPLOYMENT.md`, `README.md`, `.env.example`; create `scripts/backup-groups.mjs`, production-runtime integration tests under `tests/`; update approved spec status with actual evidence only.

**Interfaces:** `GROUP_DB_PATH` stable absolute runtime path; `GROUP_JOB_CONCURRENCY` default 2 (bounded 1–4); `PUBLIC_ORIGIN=https://weekendmerge.ailoong.net.cn`. PM2 startup passes `--experimental-sqlite` only to server. Existing credential whitelist includes new settings. Backup uses `VACUUM INTO`/SQLite consistent online mechanism with unique timestamp destination; deployment performs backup before migrations and never deletes DB on rollback. CI must run Node 22.11 production process with flag.

- [ ] Write failing runtime tests that launch bundled server with temporary DB/static paths: two independent groups/2 and 6 members, no Agent before all submit, cookies/HTTP policy, persistent data after restart, unknown APIs 404, static path cannot serve database/backups, unauthorized legacy live endpoint blocked. Deploy tests check stable path across releases, backups and production node flags, environment preservation and rollback.
- [ ] Run focused runtime/deploy tests and confirm expected preintegration failures.
- [ ] Implement startup/config/backup and CI Node 22.11 runtime coverage. Startup fails clearly on missing required production origin or invalid concurrency/path, never silently creates DB inside release. Migration backs up existing DB consistently; operator script restore instructions verify integrity before restore. Concurrency and cleanup intervals unref on shutdown.
- [ ] Run complete tests/build and controlled multi-context browser verification with real HTTP/SQLite; record 2/6-member and two-group results. Check deployment dry run and backup restore. No live model billing until code review and deployment authority resolved.
- [ ] Update README feature/API/deployment/retention/privacy and frontend collaboration notes, explain invitations vs recovery links and queue capacity, actual weather/static places/estimated routes. Commit `ops: preserve group database across deployments with tested backups`.
- [ ] Complete independent whole-branch review, fix all significant issues, rerun affected checks. Push feature branch/create attached PR; perform merge/deploy if authorized. After deployment verify existing site health and persisted groups; two controlled live groups must show real DeepSeek/weather source and binding, measure elapsed time/memory and state remaining limitations honestly.

## Plan self-review

All spec sections map to tasks: 1/8→T1; 5/6/7→T2/T3; 3/4/9→T3/T4; 10→T5; 11→tests in T1–T5. Cross-task interfaces flow T1 participant protocol → T2 snapshot → T3 runner/API → T4 client. T5 modifies deployment/server config without changing API. Node22 types may need a narrow local sqlite declaration if installed @types lacks it; no new runtime dependency. Exact new endpoint details may be settled within T3 and reported before T4 begins.
