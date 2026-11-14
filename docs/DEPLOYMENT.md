# GitHub Actions → 阿里云持久化部署

目标根目录 `/home/admin/apps/weekend-merge`，PM2 名称 `weekend-merge`，单个 fork 实例，Node **22.11.0+**，监听 `127.0.0.1:8787`，Nginx 在外层提供 HTTPS。服务器仅解压已验证产物；不安装依赖、不前端构建。公网域名 `https://weekendmerge.ailoong.net.cn` 当前须先修复证书/Cloudflare 代理：直接源站的 Cloudflare Origin CA 证书不被公共浏览器信任。loopback 健康检查不等于公网 HTTPS 验证。

## 稳定数据与进程配置

```text
/home/admin/apps/weekend-merge/
  data-runtime/groups.sqlite         # 唯一生产 GROUP_DB_PATH
  data-runtime/groups.sqlite-wal     # SQLite 管理；不可单独拷贝或删除
  data-runtime/groups.sqlite-shm
  data-runtime/backups/              # 在线一致性快照
  .deploy/releases/<release>/        # 可替换的静态与服务器产物
  .deploy/uploads/
```

`data-runtime`、`backups` 模式700，数据库/WAL/SHM/备份600，归属运行服务的 admin 用户。启动校验归属并拒绝用户目录符号链接，数据库不能位于静态或发布目录，静态服务器拒绝 SQLite/备份路径及越界符号链接。不要把 static root 指向数据目录。部署固定 `GROUP_DB_PATH` 为根目录下 `data-runtime/groups.sqlite`，跨版本不变；已配置其他路径时拒绝发布，先停机迁移并核对完整性。

PM2 必须采用以下配置含义：`instances:1`、`exec_mode:fork`、`node_args:["--experimental-sqlite"]`、`kill_timeout:240000`。参数只传服务器/备份 SQLite 子进程，不设置全局 NODE_OPTIONS。默认并发2，`GROUP_JOB_CONCURRENCY` 可设1–4。关闭时停止接新请求/任务，清理 unref 定时器并等待活动任务写完再关库；发布先删除旧进程、等待停止，再启动新进程，禁止 reload/cluster 造成队列恢复重叠。停机上限240秒后 PM2 会强杀；再次启动将中断任务标记失败，发起人明确重试。不能保证上游扣费 exactly-once。

必须的服务端环境：

```bash
NODE_ENV=production
PUBLIC_ORIGIN=https://weekendmerge.ailoong.net.cn
GROUP_DB_PATH=/home/admin/apps/weekend-merge/data-runtime/groups.sqlite
GROUP_JOB_CONCURRENCY=2
HOST=127.0.0.1
PORT=8787
TRUSTED_PROXY_DEPTH=1
```

部署白名单保留上述配置以及 DeepSeek/QWeather Key/模型/host。Key 不放 GitHub、不打印 `pm2 jlist`/dump 或临时配置。发布失败恢复旧 script/cwd/env/node_args，数据库始终保留当前内容，不自动恢复旧备份。v1 迁移只增表，旧schema迁移前另做 VACUUM INTO 快照；未来不向后兼容迁移需单独维护窗口，不能假设代码回滚自动反向迁移数据库。

## 准备与发布

GitHub Actions secrets：`DEPLOY_SSH_KEY`（专用 Ed25519 私钥）、`DEPLOY_KNOWN_HOSTS`（核实后的服务器主机公钥）。Variables：`DEPLOY_HOST=8.148.30.195`、`DEPLOY_USER=admin`、`DEPLOY_PORT=22`、`DEPLOY_PATH=/home/admin/apps/weekend-merge`、`DEPLOY_ENABLED=false`（运维授权后再启用）。Environment 为 `production`，建议限制 main。

以当前 PM2 管理用户在项目根目录，确认唯一现有服务及上述 env 后运行：

```bash
node scripts/setup-deploy.mjs 'ssh-ed25519 替换成专用公钥 github-actions-weekend-merge'
```

它只追加受限 SSH 公钥、创建私有部署/数据目录、记录 Node/PM2 路径，不重启服务。首次切换前应在维护窗口为现有 PM2 服务设置240秒 kill_timeout；旧版无小组任务时也要确认没有正在进行的 live 请求。不要在任务未完成时依赖旧默认1.6秒超时。

CI 固定 Node22.11.0，`npm ci` → `npm run test:node22`（fork 启动显式 SQLite flag）→ `npm run build` → 隔离 PM2 干跑。产物包含 dist、dist-server、deploy/backup 脚本及演示 fixture，不包含数据库。main 发布串行执行，旧 workflow 重跑不会覆盖更新的 main。SSH 核对主机，上传后调用 `.deploy/run-node <upload>/scripts/deploy.mjs <root> <release>`。

发布在首次启动新 bundle 前用 VACUUM INTO 做一致性备份，包含已提交的 WAL 页；备份失败则不激活新版本。随后切换单进程，检查版本 `/healthz`、首页和显式 demo 三候选结果，成功才 PM2 save。检查使用 demo，不调用付费模型。失败恢复旧进程并报告失败；旧 release 和备份保留供人工检查。

## 在线备份与离线恢复

在应用仍运行时执行（脚本检查完整性后才报告输出路径）：

```bash
node --experimental-sqlite scripts/backup-groups.mjs \
  /home/admin/apps/weekend-merge/data-runtime/groups.sqlite
```

备份文件名带 UTC 时间与 UUID，目标必须不存在，不覆盖旧文件。不要直接复制运行中的主文件或删 WAL/SHM。备份中包含偏好与授权哈希，按私有数据存储；线上三十天清理不删除历史备份，运维需另设保留政策、磁盘告警及受控异机备份。本项目不擅自自动删除备份。

恢复必须先停止唯一实例，确认没有其他 Node/SQLite 写进程。恢复会拒绝遗留 WAL/SHM；若仍存在，先调查进程/强杀恢复问题，不要直接删除。完整性校验失败拒绝恢复，旧库另存 `before-restore-...bak`，便于回退：

```bash
pm2 stop weekend-merge
node --experimental-sqlite scripts/backup-groups.mjs --restore \
  /absolute/private/backup.sqlite.bak \
  /home/admin/apps/weekend-merge/data-runtime/groups.sqlite --service-stopped
pm2 restart weekend-merge
curl -fsS http://127.0.0.1:8787/healthz
```

`--service-stopped` 是操作者声明，不代替进程检查；恢复会回到快照时刻，之后数据只存在于保留的旧库。一般应用回滚不需要恢复数据库。

## 运维验证与边界

```bash
curl -fsS http://127.0.0.1:8787/healthz
pm2 status weekend-merge
cat /home/admin/apps/weekend-merge/.deploy/current.json
```

复查版本、唯一实例、db绝对路径/权限，再用已有 Cookie/恢复链接打开受控小组确认保留数据。Nginx 应覆盖 `X-Forwarded-For` 为可信链；`/api/`、`/.netlify/functions/` 不缓存，HTTP/1.1、关闭响应缓冲，域名证书须公开受信任。Cookie Secure 依赖正确 HTTPS。

真实 Agent 验证必须通过两个小组、各成员独立提交触发，不能调用被禁用的旧公开 live API。仅在审查和计费授权后执行。检查每组持久事件的模型来源/无降级、`get_weather` 的 open-meteo/qweather 实际来源及证据，核对结果绑定、耗时和内存。固定目录地点、路线/费用估算与天气真实来源是不同能力，不能据一次 demo 健康检查宣称全部实时。

本地可重复干跑：完成 build 后，用安装在临时目录的 PM2 将其 `.bin` 加入 PATH，再运行 `node scripts/verify-deploy.mjs`。脚本自行创建并清理一次性 PM2_HOME，只测试临时服务；不要改为现有 PM2_HOME。崩溃回滚、持久化及备份离线恢复均为本地验证，不能替代上线验收。部署锁遗留时须确认无发布正在运行，再由运维处理；保留 release、数据库和日志，不做强制 Git 重置。
