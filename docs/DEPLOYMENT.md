# GitHub Actions → 阿里云服务器

生产地址为 `https://weekendmerge.ailoong.net.cn/`。应用使用 Node.js 22+ 和用户 `admin` 的 PM2 进程 `weekend-merge`，监听 `127.0.0.1:8787`，由现有 Nginx 代理。GitHub 执行测试与构建，服务器仅解压产物并启动 Node，不运行 npm 安装或前端构建。

## 一次性准备

在 GitHub 仓库 Settings → Secrets and variables → Actions 配置：

| 类型 | 名称 | 内容 |
| --- | --- | --- |
| Secret | `DEPLOY_SSH_KEY` | 专用 Ed25519 私钥；公钥由服务器用户授权 |
| Secret | `DEPLOY_KNOWN_HOSTS` | 已核实的服务器 SSH 主机公钥行；禁止关闭主机校验 |
| Variable | `DEPLOY_HOST` | `8.148.30.195` |
| Variable | `DEPLOY_USER` | `admin` |
| Variable | `DEPLOY_PORT` | `22`，如修改 SSH 端口则相应调整 |
| Variable | `DEPLOY_PATH` | `/home/admin/apps/weekend-merge` |
| Variable | `DEPLOY_ENABLED` | 准备期间为 `false`，授权完成后设为 `true` |

Environment 使用 `production`，建议只允许 `main` 分支部署。DeepSeek Key 留在服务器 PM2 环境中，无需复制到 GitHub。私钥、`.env`、`.deploy/` 均不得提交到仓库。

在服务器以当前管理 PM2 的 `admin` 用户进入项目目录，拉取包含此流程的 `main`，运行一次：

```bash
cd /home/admin/apps/weekend-merge
git pull --ff-only origin main
node scripts/setup-deploy.mjs 'ssh-ed25519 此处替换为专用公钥 github-actions-weekend-merge'
```

初始化脚本要求 Node.js 22+、可访问 PM2，且已有唯一的 `weekend-merge` 进程。它保留已有 SSH 公钥，追加带 `restrict` 选项的部署公钥，并记录当前 Node/PM2 所在路径，解决非交互式 SSH 的 PATH 不同问题。它不重启网站，不需要 sudo。

若项目存在本地已跟踪文件的修改，`git pull --ff-only` 可能拒绝更新；先检查 `git status --short`，保留这些修改后再继续。服务器的 `.env` 不受 Git 管理。

确认 GitHub Actions 能经服务器 SSH 端口连接。准备完成后，将 `DEPLOY_ENABLED` 设为 `true`，到 Actions → `test-and-build` → Run workflow，选择 `main`。以后每次推送或合并到 `main` 都会自动测试、构建和部署。PR 只运行测试和构建，不连接服务器。

## 发布过程

1. CI 使用 `npm ci`、`npm test -- --run`、`npm run build`，并在独立 PM2_HOME 中验证真实 PM2 的版本切换与崩溃回滚，任一步失败都不会部署。
2. 打包 `dist/`、独立的 `dist-server/server.mjs`、部署脚本和演示请求 fixture。构建产物保留七天。
3. 通过校验服务器主机公钥的 SSH/SCP 上传。发布任务串行执行，重跑旧提交不会覆盖已更新的 `main`。
4. 产物放入 `.deploy/releases/<commit>-<run>-<attempt>/`。原仓库、`.env` 和其他网站不被覆盖。
5. 从现有 PM2 进程继承 DeepSeek Key、模型名等应用配置，切换 `weekend-merge` 的脚本及工作目录。
6. 检查 `/healthz` 的版本标识、首页 HTML、演示规划 API 的 NDJSON 和三个候选方案，然后保存 PM2 状态。检查失败则恢复部署前的脚本、工作目录和应用环境，工作流报告失败。

这是单进程部署，切换期间可能有短暂不可用，不承诺无中断。部署检查使用 `mode: "demo"`，不会消耗模型额度，也不能证明 DeepSeek 或天气上游服务可用。

PM2 切换用的临时配置包含运行环境，仅写入权限为 `700` 的 `.deploy/` 下，文件权限 `600`，结束后移除。不要打印 `pm2 jlist` 的完整结果或上传 PM2 dump，它们可能包含 Key。

## 检查与故障处理

在服务器运行：

```bash
curl -fsS http://127.0.0.1:8787/healthz
pm2 status weekend-merge
cat /home/admin/apps/weekend-merge/.deploy/current.json
```

`/healthz` 只返回状态和版本，不包含 Key。`current.json` 记录最近成功发布标识及之前的脚本路径。旧版本保留在 `releases/`，便于人工恢复；目前不自动删除旧版本，定期查看该目录占用。

若 Actions SSH 认证失败，检查部署公钥是否属于同一用户、GitHub 私钥是否匹配、`.ssh` 为 `700`、`authorized_keys` 为 `600`。主机校验失败时应核实服务器主机指纹后更新 `DEPLOY_KNOWN_HOSTS`。

若提示 Node/PM2 不可用，以正常管理网站的 SSH 交互式终端重新运行初始化脚本。若部署进程被强制终止，确认没有发布正在进行后，才可移除 `.deploy/deploy.lock` 并重新部署。

自动回滚失败时，工作流会明确报告。此时先在服务器检查 `pm2 status weekend-merge` 和错误日志，保留旧版本目录。不要删除原项目或执行强制 Git 重置。

真实 Agent 验证应额外发送一次 `mode: "live"` 请求：无 `run.degraded` 表示模型候选通过校验；`tool.completed` 中的 `get_weather` 且来源为 `open-meteo` 或 `qweather` 表示取得对应上游的真实预报或其成功缓存。和风天气凭据、免费额度与启用前署名要求见[天气接入说明](WEATHER.md)。部署和回滚均保留 PM2 中的 `QWEATHER_API_HOST`、`QWEATHER_API_KEY`；修改 `.env` 后需按说明更新 PM2 环境。地图、地点目录、路线估算的能力边界不因部署方式改变。
