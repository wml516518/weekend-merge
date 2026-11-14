# Weekend Merge / 周末共识局

2–6 人各自填写偏好的上海周末规划应用。发起人设置人数、日期、时间和总预算，通过邀请链接让大家在各自浏览器加入；所有席位都提交后，服务器才冻结本轮偏好并生成三套方案。

- [生产域名](https://weekendmerge.ailoong.net.cn/)（公网 HTTPS 证书/代理修复与本分支上线验证尚待运维完成）
- [个人主页中的项目介绍](https://menglong-build-log.netlify.app/#projects)

默认首页为小组流程。`/#demo` 是不调用模型的固定演示；只读分享不携带成员偏好。旧 Netlify Functions 及 A/B 演示不提供小组持久化能力；生产小组功能需要下述单进程 Node/SQLite 服务。

## 使用与隐私

创建 2–6 人计划后保存邀请链接、我的恢复链接和管理恢复链接。邀请用于新增独立席位，七天内有效，开始规划即失效；恢复链接用于找回已有身份或管理权，有效期随小组的三十天保留期结束。个人恢复不会恢复管理权，管理恢复不会自动取得任何人的原始答案。链接是访问凭据，请只交给对应的人；原始恢复链接仅签发时显示，刷新后无法重新读取。

成员只可填写自己的草稿，看其他成员的昵称和提交状态。草稿不会因轮询而丢失；同一身份两页编辑遇到版本冲突时，须明确同步服务器草稿。同设备交接会新增一个空白身份，不能替代独立浏览器的身份隔离。新计划从空白开始，新一轮保留本人草稿但要求重新确认提交。

所有成员提交后，数据库保存不可变快照、任务及事件。默认同时运行两个小组任务，`GROUP_JOB_CONCURRENCY` 可设整数 1–4；超出容量排队。刷新、断线、只读查询不会再次调用 Agent。异常中断的运行任务显示失败，须发起人明确重试；不承诺上游计费的 exactly-once。发起人可选方案、锁定站点、最多两次局部调整及确认最终行程；成员只读结果。最终行程、PNG 长图和分享均按实际人数显示总计与人均。

数据自创建起保留三十天，运行期间每分钟清理过期组及关联授权、答案、快照、事件。数据库和备份属于服务器私有数据；备份由运维单独管理，不随线上过期自动删除。不要把恢复凭据、数据库、备份、API Key 或 PM2 dump 上传到公开日志。

## 本地运行

要求 Node.js **22.11.0 或更高**；22.11 的 SQLite 需显式实验参数，`npm start` 已包含。依赖安装、构建进程不需全局 `NODE_OPTIONS`。

```bash
npm ci
PUBLIC_ORIGIN=http://127.0.0.1:5173 GROUP_DB_PATH=/absolute/private/groups.sqlite npm run dev -- --host 127.0.0.1
npm run test:node22
npm run build
NODE_ENV=development PUBLIC_ORIGIN=http://127.0.0.1:8787 GROUP_DB_PATH=/absolute/private/groups.sqlite npm start
```

Vite 与 Node 服务共用真实小组 API 和 SQLite；开发 HTTP 只接受明确的 loopback origin。请始终使用同一个主机名（`127.0.0.1` 或 `localhost`）以保持 Cookie 授权。`.env.example` 列出服务端配置。生产必须提供 HTTPS `PUBLIC_ORIGIN` 和绝对 `GROUP_DB_PATH`，缺失、无效并发、静态/发布目录中的数据库路径会拒绝启动。

`DEEPSEEK_API_KEY`、`DEEPSEEK_MODEL`（默认 `deepseek-flash`）以及可选 `QWEATHER_API_HOST`、`QWEATHER_API_KEY` 只放服务端。没有模型 Key 或模型失败会明确显示 `rule-planner` 降级；规则降级不请求天气、不编造预报。真实模型路径的天气工具优先 Open-Meteo，可回退到已配置和风天气，事件展示实际来源。和风启用前的署名及额度要求见[天气说明](docs/WEATHER.md)。本分支本地验证不证明真实模型/天气服务或公网 TLS 可用。

## API 与数据边界

小组 API 统一为 `/api/groups`。创建 `POST /api/groups`，加入 `POST /api/groups/join`，恢复 `POST /api/groups/recover`；`GET /api/groups` 列出当前 Cookie 授权的计划。详情及事件为 `GET /api/groups/:id`、`GET /api/groups/:id/events?after=N`。成员保存/提交使用 `POST /api/groups/:id/preferences`；管理接口后缀为 `invite`、`members/:memberId/remove`、`round`、`retry`、`select`、`replan`、`finalize`。

写请求必须是 JSON、同源 `Origin`，最多 32 KiB；身份只来自 HttpOnly Cookie，生产使用 `__Host-weekend_group`、Secure、SameSite=Lax。原始邀请/恢复 token 经 URL fragment 进入浏览器，立即从地址栏移除，再在 POST body 交换，不放 query 或 localStorage。成员保存用成员 `version`，管理操作用 `stateVersion`。轮询事件是读取，不触发任务。未知 API 返回 JSON 404；生产和 Vite 的旧公开 live plan/replan 返回 403 `GROUP_REQUIRED`，仅显式 `mode:demo` 保留旧演示接口。

独立 IP 和浏览器各限 120 请求/分钟，创建/新轮次/重试/重排各限 5 次/10 分钟；单进程内存限流不提供跨进程/重启的全局配额。反向代理只可信 loopback 对端，`TRUSTED_PROXY_DEPTH` 为 1–5，不能透传客户端伪造的转发链。

日期须是上海今天起 180 天内的周六/周日，时段为 3–12 小时。兴趣最多五项，愿望最多 80 字符，局部调整理由最多 160 字符。工具包括天气、地点搜索、路线、预算、方案验证；事件仅公开白名单依据，不公开原始偏好、模型提示词或 API 错误。上海地点为带核实日期的静态目录，路线/交通/费用为估算，出发前应核对营业时间、价格和交通。

## 部署与协作

[部署、在线备份、离线恢复与回滚](docs/DEPLOYMENT.md)规定固定数据目录、单进程 PM2 和 Node 22.11 验证。GitHub Actions 在发布前运行全套测试、构建以及独立 PM2_HOME 的发布/崩溃回滚/恢复干跑。发布产物不包含数据库；应用回滚保留当前数据库，不恢复旧快照覆盖新数据。

Docker 需外置私有卷和明确 origin（先在宿主机创建归属容器 uid1000、模式700的数据目录）：

```bash
docker build -t weekend-merge .
docker run --rm -p 127.0.0.1:8787:8787 --env-file .env \
  -e PUBLIC_ORIGIN=https://weekendmerge.ailoong.net.cn \
  -e GROUP_DB_PATH=/data/groups.sqlite \
  -v /absolute/private/weekend-data:/data weekend-merge
```

前端入口是 `src/features/groups/GroupApp.tsx`；小组页面调用 `client.ts` 中的 Cookie API。组件不能聚合其他人的私有答案或把 job 的单次重排结果替代顶层三个候选。保留现有纸张/墨色/苔绿 token、可见焦点及 360px 布局，异步结果必须校验当前组/导航代数，表单同步需明确操作。共享契约在 `src/contracts/groups.ts`，持久化和 Worker 在 `server/groups/`；修改这些边界时同步测试。

- [架构](docs/ARCHITECTURE.md)
- [固定演示 API](docs/DEMO.md)（历史 Function 示例不用于小组生产实时调用）
- [天气说明](docs/WEATHER.md)
- [产品需求](docs/PRD.md)
- [前端设计参考](docs/FRONTEND.md)
