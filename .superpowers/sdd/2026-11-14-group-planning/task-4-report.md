# Task 4 report — independent group invitation and planning interface

Date: 2026-11-14, Asia/Shanghai. Base: `1622036`. Status: implemented, self-reviewed and locally verified. No subagents, network requests, provider billing, push, deployment, or real-browser writes. Task 5 owns browser/HTTP deployment verification.

## Implementation

Added group-specific `client.ts`, `GroupApp.tsx`, `GroupCreate.tsx`, `GroupLobby.tsx`, `GroupResults.tsx`, `groups.css` and `GroupApp.test.tsx` under `src/features/groups`.

- Default application entry always opens the cookie-authorized group flow, including with old persisted live or A/B store state. Explicit `#demo` opens the fixture demo. Existing read-only `#share=` decoding is preserved. Removed the legacy App live planning request path; group pages call only `/api/groups` routes.
- Creation supports 2–6 seats, creator nickname, name, weekend date, time, Shanghai area and budget. Default totals scale from ¥300/2 to ¥900/6 (¥150 each); the total ceiling scales to headcount × ¥2000. Shows total and per-person values.
- Invitation and recovery credentials are read from fragments, removed with `replaceState`, and exchanged in POST bodies. Cookie fetches use `credentials: same-origin`. Issued credentials remain only in component memory, keyed by group and, for personal recovery, member; ordinary polling never overwrites them. Copy fields remain actionable with manual-copy fallback. Recovery warning explains one-time issuance and separates personal and management links.
- My plans lists server-granted groups. Nonsecret `#group=ID` supports detail refresh. Explicit same-device handoff adds a blank identity with `handoff:true`; only `myMembers` appear in the identity selector. Personal recovery of the creator does not imply management. Management-only recovery with `myMembers:[]` exposes management without a preference form.
- Lobby displays exactly targetCount seats with named submitted/pending members, real empty seats, and accessible submitted count. No other member's answer is displayed. Desktop common details sit beside seats and own action; mobile stacks them. Existing paper/ink/moss tokens and display/body families remain. Visible focus, wrapping, 360px CSS breakpoint and reduced motion are included.
- Own form is keyed by group/member/revision, initialized only from own authorized draft, and never silently reset by polling. Save uses member version and a fresh idempotency key; selection/replan/finalize use stateVersion. Dirty edits survive detail refresh; changed server versions block saves and offer explicit `同步服务器草稿`, which actively fetches latest state before remounting. Submitted preferences can be edited only while collecting. New round preserves own server draft for explicit reconfirmation and resets submission/results.
- Detail polls every 3 seconds, every 15 seconds hidden, and immediately on visibility changes. Abort controllers, generation checks and mutation fencing suppress stale poll responses and prevent polls from discarding in-flight saves. Unmount cancels polling; switching groups suppresses late old-group results.
- Persistent events are rendered from detail's complete authorized `job.events`; no extra events endpoint call is needed. Tool names, actual source, evidence, duration, failures and model/rule fallback remain visible, including alongside finalized results. Consensus all-member interests show N/N support only from persisted completed consensus. Candidate reasons include the core's member interest coverage. No frontend inference from private drafts.
- Results use top-level `candidates`, retaining all three alternatives even when latest replan `job.plans` has one. Nonowners view server selection/final state. Owners select, lock/unlock stops, request up to two local adjustments, retry failures and finalize. Failed replan retains old candidates but disables selection/finalization. UI limits reasons to 160 and shows the counter. New round and separate invite rotation/removal are exposed; target count cannot be below present membership.
- Reused RouteMap and compatible FinalItinerary renderers. Group final/export/share use actual participant count, total and per-person costs, with static catalog and route/price estimate labels. Share version 1 accepts optional count and defaults old snapshots to two. `saveSetup` now clears both previous a/b preferences; regression added.

Modified existing files: `src/app/App.tsx`, `App.test.tsx`; `src/features/wizard/PreferenceStep.tsx`; `src/state/usePlanningStore.ts`, its test; `src/features/final/FinalItinerary.tsx`, `share.ts`, `share.test.ts`. No API/storage/core or deployment changes.

## TDD and verification evidence

Read brief/handoff/API report and implementer contract before edits. Applied frontend-design's existing approved token/font/seat signature plan, test-driven-development and writing-good-tests, and verification-before-completion. No new approval gate was introduced by a skill.

1. First RED command: `npm test -- --run src/features/groups/GroupApp.test.tsx src/state/usePlanningStore.test.ts src/features/final/share.test.ts`. Store assertion failed with `{a:...,b:...}` instead of `{}`; share count failed `undefined` instead of `6`; group suite reported missing GroupApp module. This explicitly distinguishes assertion-level regressions from initial new-module RED.
2. App entry tests were adapted before entry implementation. RED observed default old persisted workbench lacked `创建并邀请`; explicit group demo link was absent; group share count UI was absent. Legacy public live assumptions were removed; planner/replan coverage remains in the existing real core/Workbench suites.
3. Focused iteration first reached 10/10 group UI cases plus share/store/PreferenceStep. Test fixture corrections included supplying required demo run IDs, encoding legacy Chinese snapshots through UTF-8 bytes, using the fixture's real `雨天艺术散步` title, and modeling finalized headcount with two actual members. These were test data/assertion corrections, not claimed production regressions.
4. Added behavioral regression cases before fixes: handoff overwrote m1 recovery link with m2 token; explicit sync reused old draft without fetching; finalized view hid persisted events; shared consensus omitted N/N support. Each failed on observable UI state, was fixed and passed in focused reruns.
5. Final focused command: `DEBUG_PRINT_LIMIT=250 npm test -- --run src/features/groups/GroupApp.test.tsx src/app/App.test.tsx src/features/final/share.test.ts src/state/usePlanningStore.test.ts src/features/wizard/PreferenceStep.test.tsx` → **5 files, 35/35 passed**, no warnings. Includes 26 group cases plus App/default/demo/share, legacy share count, store reset, existing PreferenceStep behavior. External HTTP is doubled at fetch; components/client/state/renderers remain real. No tests assert mock component presence.
6. Final full verification after last production edit and local formatting:

| Command | Observed result |
| --- | --- |
| `npm test -- --run` | **35 files, 471/471 passed**, pristine output |
| `npm run build` | **exit 0**: composite app TS, function TS, Vite production (1620 modules), server bundle |
| `git diff --check` | **exit 0** |

Full suite and build ran once at the final implementation. Only this report/staging/commit followed. No real browser or paid API run is claimed.

## Task 5 browser-facing contract

All entries use the normal SPA pathname `/`; retain the exact origin/host consistently for cookie grants.

| Entry | Format and behavior |
| --- | --- |
| Default live / my plans | `/` |
| Invitation | `/#invite=URL_ENCODED_TOKEN`; hash removed immediately on mount; fill nickname then POST join; successful URL becomes `#group=ID` |
| Personal or management recovery | `/#recover=URL_ENCODED_TOKEN`; same format for either capability; hash removed then automatic POST recover; success becomes `#group=ID` |
| Existing cookie-granted group | `/#group=URL_ENCODED_GROUP_ID`; no bearer capability, authorization still server cookie |
| Explicit fixture demo | `/#demo` |
| Read-only snapshot | existing `/#share=BASE64_UTF8_JSON`; version1, optional participantCount defaults2 |

Capabilities never use query strings or localStorage. Recovery links must be captured from creation/join before a hard reload because raw token is issued once. Same-device identity switching does not add URL credentials. Browser tests should use separate contexts for separate people; handoff is a separate explicit convenience flow.

Exact accessible controls:

- Home: `计划名称`, `我的昵称`, `参与人数` select (options `2 人` … `6 人`), `日期` input[type=date], `开始时间`, `结束时间`, `出发区域`, `总预算（元）`; submit `创建并邀请`. Navigation button `我的计划`; link `体验演示`; list button `打开 ${group.name}`.
- Invitation/handoff: `加入昵称`; `加入计划`; `交给同设备另一位` → handoff explanation + `确认新增独立成员`, `取消交接`. Handoff needs current in-memory invite and a free seat; after refresh owner can `更新邀请链接` first.
- Lobby: list `参与席位`, each listitem `席位 N ${nickname}` or `席位 N 等待加入`; status shows `已提交 X / N`. Own entry `填写我的偏好` or `修改我的偏好`. Multi-grant select `当前填写身份`, option values are own member IDs and text nickname. Switching closes previous form; click own entry again.
- Own preferences: existing interest checkbox names (`展览`, `咖啡`, etc.), grouped pace/indoor/budget controls, `一句话愿望（可选）`, `保存我的草稿`, `提交我的偏好`, `返回大厅`, `同步服务器草稿` (visible for server version changes/conflict). In a new round, open form then explicitly submit preserved draft. Draft save does not submit. Final submission hides editing and shows `已进入规划队列` within status; earlier submission shows `等待其他成员提交`.
- Links: readonly inputs `邀请链接`, `我的恢复链接`, `管理恢复链接`; buttons `复制邀请链接`, `复制我的恢复链接`, `复制管理恢复链接`. Personal field follows currently selected own identity; previously issued own links survive switching. Recovery-only load does not reissue or display raw recovery token.
- Owner management: `更新邀请链接`; `移除 ${nickname}` only for nonowner while collecting; `开启新一轮` opens common setup form, submit `确认开启新一轮`. Remove before reducing below existing membership. New round does not return/create an invite; rotate separately if needed. `重试本次规划` for failed state. `刷新计划状态` within errors refreshes detail; explicit form sync remains separate.
- Results: section `共同规划结果`; event section `持久规划事件`, tool details summary `查看工具依据`. Articles `候选方案 ${title}` (three from top-level candidates). Owner buttons `选择方案 ${title}`; selected heading `已选择：${title}`; per-stop `锁定 ${name}` / `解锁 ${name}`, `换个地方 ${name}`; textarea `调整原因` maxLength160, visible N/160; submit `提交局部调整`, `取消调整`; final action `确认最终行程`. At adjustment count2, replacement buttons disabled; locked stops disabled for replacement. Nonowners have none of these management actions.
- Final/shared: heading `${title}。`, actual `${N} 人总计`, `导出行程长图`, `复制只读分享链接`; map controls retain `缩小地图`, `放大地图`, `重置地图视图`.

## Self-review and limits

Reviewed route isolation and stale legacy state, all request payload keys/version sources, canManage vs owner member flags, own-draft initialization, group/member/revision remounts, per-identity issuance retention, dirty form polling, explicit sync, cancellation and delayed old-group response, visibility/poll-vs-save races, exactly target seats, candidate-vs-job semantics, both adjustment allowances, failure preservation, expiry errors, round reconfirmation, count in final/share/export and legacy decode. All touched source formatted with already installed local Prettier; no dependency installed. Requirements remain in the specified focused file structure.

Browser screenshot/layout QA at 360px and real HTTP multi-context flow are explicitly **not executed here**; Task 5 should run them. CSS implements those constraints, but this report claims unit/component/build evidence only. A hard reload intentionally loses newly issued link text; the cookie grant continues and saved recovery links restore access. The server is authoritative for 7/30-day expiry, date horizon, rate limits, failed jobs, and authorization; server messages are shown. Last-attempt events and consensus are presented as supplied by GroupView; no private answer aggregation is invented in the browser.
