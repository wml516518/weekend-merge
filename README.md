# Weekend Merge / 周末共识局

一个面向两人周末决策的可观察 AI Agent。双方分别填写兴趣、预算和雷区，系统通过天气、地点、路线与预算工具生成三套折中方案；否决某一站后，只重新规划受影响区段。

- [在线演示](https://weekendmerge.ailoong.net.cn/)
- [个人主页中的项目介绍](https://menglong-build-log.netlify.app/#projects)

## 当前可用

- 创建上海周末计划。
- A / B 分别填写偏好，中间经过隐私交接遮罩。
- 展示共同偏好、冲突和硬约束。
- 在规划工作台比较三个候选方案。
- 查看天气、地点、路线和预算工具的执行证据。
- 切换方案，点赞、锁定、按理由局部替换，并保存协商状态。
- 最终行程、PNG 长图和不含个人偏好的只读分享。
- 浏览器刷新后恢复当前步骤。
- `POST /.netlify/functions/plan` 支持演示模式和受控实时 Agent；未配置 DeepSeek 时会显式降级为确定性规则方案。
- `POST /.netlify/functions/replan` 支持保留锁定站点的局部重排，并返回变更差异。
- 两个端点均使用共享 Schema 校验 NDJSON 事件；`plan` 逐行推送进度，`replan` 返回有界响应。

## 快速开始

要求 Node.js 22 或更高版本。

```bash
npm install
npm run dev
```

打开 `http://localhost:5173` 调试前端、实时规划和局部重排。Vite 开发服务器会调用仓库内的两个 Function handler；未配置模型密钥时会显示规则降级。要验证 Netlify 自身的路由和运行环境，可另用 `netlify dev`（默认 `http://localhost:8888`）。API 请求示例见 [演示步骤](docs/DEMO.md)。

```bash
npm test -- --run
npm run build
```

## 服务端配置

`.env.example` 列出 `DEEPSEEK_API_KEY` 和可选的 `DEEPSEEK_MODEL`。需要 DeepSeek 时将它们配置为 Netlify Function 的服务端环境变量；本地开发可放在未提交的 `.env` 中。`DEEPSEEK_MODEL` 未配置时默认使用 `deepseek-flash`。不要使用 `VITE_` 前缀或将密钥放进浏览器代码。未配置 Key 或模型失败时，`mode: "live"` 会显式降级为规则规划；规则规划不请求天气，也不伪造预报。

部署需提供 Node.js 22+、Netlify Functions，以及可选的服务端 DeepSeek 配置。`netlify.toml` 已设置构建命令和 Node 版本。DeepSeek API 按 Token 计费；天气优先使用 Open-Meteo，失败时可切换到已配置的和风天气，返回实际来源。和风天气免费额度、服务器配置与上线前署名要求见[天气接入说明](docs/WEATHER.md)，服务价格、配额和使用政策需按实际部署核对。

## Netlify 部署

当前生产站点：[weekend-merge-wml516518.netlify.app](https://weekend-merge-wml516518.netlify.app)。未配置 DeepSeek Key 时也可完整体验演示流程，并可通过实时请求观察显式规则降级。

从 GitHub 导入 `wml516518/weekend-merge`，生产分支选择 `main`。仓库中的 `netlify.toml` 已固定以下设置：

- 构建命令：`npm run build`
- 发布目录：`dist`
- Functions 目录：`netlify/functions`
- Node.js 版本：`22`

`DEEPSEEK_API_KEY` 与 `DEEPSEEK_MODEL` 只应配置为 Netlify Functions 的服务端环境变量，不能使用 `VITE_` 前缀。没有密钥时生产站仍可运行，并会明确降级到确定性规则规划；添加密钥后启用 DeepSeek Tool Calls。基础响应安全头由 `netlify.toml` 统一设置，CSP 将在地图瓦片来源确定后单独收紧。

## 自有服务器部署

仓库提供 GitHub Actions 到阿里云的自动部署流程。完成服务器授权并启用后，`main` 测试、构建通过就会上传产物，检查新版本和 API，失败自动恢复旧进程。服务器准备、GitHub Secrets 和启用步骤见 [自动部署说明](docs/DEPLOYMENT.md)。

仓库内置 Node 服务器入口，同时托管 Vite 静态产物和两个 API handler，保留前端已使用的 `/.netlify/functions/plan` 与 `/.netlify/functions/replan` 路径：

```bash
npm ci
npm run build
HOST=127.0.0.1 PORT=8787 npm run start
```

`dist-server/server.mjs` 只读取 `dist` 静态产物、处理 SPA 回退并调用两个 Function；`DEEPSEEK_API_KEY` 和 `DEEPSEEK_MODEL` 仍是服务器进程环境变量。服务器已有 Node.js 22+ 时，建议用最小运行时依赖启动：

```bash
npm ci --omit=dev
npm run build:server
HOST=127.0.0.1 PORT=8787 npm run start
```

注意：完整前端构建仍需要开发依赖；上一条 `npm ci --omit=dev` 适用于部署已在本机构建好的 `dist/` 和 `dist-server/` 产物。默认 `TRUSTED_PROXY_DEPTH=1` 表示只信任直接反向代理写入的最右侧 `X-Forwarded-For` 值；有固定多层代理时，把它设置为可信代理层数。也可使用 Docker：

```bash
docker build -t weekend-merge .
docker run --rm -p 127.0.0.1:8787:8787 --env-file .env weekend-merge
```

反向代理必须开启 HTTP/1.1、关闭缓冲并透传 `Content-Type`、`Connection` 和一个可信的 `X-Forwarded-For` 首值。Nginx 示例：

```nginx
location / {
  proxy_pass http://127.0.0.1:8787;
  proxy_http_version 1.1;
  proxy_set_header Connection "";
  proxy_set_header X-Forwarded-For $remote_addr;
  proxy_buffering off;
}
```

Cloudflare 把子域 A/AAAA/CNAME 记录指向服务器并开启代理即可；SSL/TLS 使用 Full (strict)。不要缓存 `/.netlify/functions/` 路径。实时限流按请求处理器见到的首个可信 IP 与 `sessionId` 组合计算，反向代理不能透传任意客户端伪造的转发头。

## 接口与数据边界

| 路径 | 职责 |
| --- | --- |
| `src/contracts/agent.ts` | 前后端共享的请求、行程和事件 Schema |
| `netlify/functions/plan.ts` | 演示/实时规划入口与 NDJSON 响应 |
| `netlify/functions/replan.ts` | 确定性局部重排入口 |
| `netlify/functions/agent/` | DeepSeek 适配器、状态机、规则降级与五个工具 |
| `data/places.shanghai.json` | 带来源、开放时间及 `lastVerifiedAt` 的静态上海地点目录 |
| `src/demo/demoRun.ts` | 前端展示 fixture，不保证地点 ID 均在服务端目录中 |

请求体在 JSON 解析前按实际 UTF-8 字节数限制为 32 KiB，超限返回 `413 REQUEST_TOO_LARGE`。设定只接受周六/周日、3–12 小时（结束可为 `24:00`）及共享上海区域白名单；HTTP 另按上海日期检查今天至未来 180 天。兴趣仅限界面九项、最多五项；饮食/避让各最多十项、每项最多 30 字符，愿望最多 80 字符。

实时 `plan` 按可信 Netlify IP（`x-nf-client-connection-ip`，其次首个 `x-forwarded-for`，最后 `unknown`）和已验证的 `sessionId` 组合，每十分钟最多五次；演示请求不占用额度。计数器为模块级内存，最多保存 5,000 个键，清除过期/最早记录。受限时在创建 DeepSeek 模型或调用天气前返回 `429 RATE_LIMITED`、`retryable: true`。这只是 **warm-instance guard**，不提供跨实例、重启后或更换会话的持久分布式限流；生产配额仍需在提供商或持久网关层配置。

重排支持可选 `reasonCode`：`CHANGE_PLACE`、`TOO_CROWDED`、`TOO_EXPENSIVE`、`TOO_MUCH_WALKING`、`PREFER_INDOOR`、`PREFER_OUTDOOR`、`CHANGE_ACTIVITY`。未提供时只按受支持中英文关键词解析；不识别的自由文本返回 `400 UNSUPPORTED_REPLAN_REASON`，不是通用自然语言理解。例：`不要再安排展览，想喝咖啡` 选择非展览咖啡地点，`想换成另一个展览` 选择另一展览。

五个白名单工具是 `get_weather`、`search_places`、`estimate_route`、`calculate_budget`、`validate_plan`。天气范围由服务端依据请求日期/时间固定为上海人民广场坐标；地点资料和路线、费用是静态数据或估算，不是实时营业、交通或票价信息。出发前应核对地点营业时间、票价和路线。详见 [架构](docs/ARCHITECTURE.md)。

模型工具的时间参数要求带秒和时区的 ISO 日期时间。地点搜索还兼容 `13:00` 和未携带时区的本地日期时间：服务端按请求日期及上海 `+08:00` 补全，再校验日期和区间；倒序、超过一天及无法解释的时间仍拒绝，不会丢弃过滤条件。

工具事件仅公开白名单摘要：上海天气区间/温度/降雨范围、目录地点 ID/名称/核实日期、路线/步行/费用范围，以及按候选 ID 标记的验证/陈旧数据警告；不返回原始工具输出、自由文本偏好、提示词、API 错误或隐藏推理。`run.failed.constraintCodes` 可携带封闭枚举中的时间、预算、避让等无方案原因。

成功响应的事件类型为 `run.started`、`step.started`、`tool.completed` / `tool.failed`、`plan.proposed`、`run.degraded`，并以一个 `run.completed` 或 `run.failed` 结束。初始规划完成事件的 `candidateIds` 有三个元素，没有 `diff`；重排完成事件的 `candidateIds` 有一个元素和必需的 `diff`。展示 fixture 中的候选地点并非全都收录于服务端目录，因此不能直接拿 `createDemoRun()` 的方案提交给重排接口。

## 文档

- [架构与降级路径](docs/ARCHITECTURE.md)
- [本地 API 演示](docs/DEMO.md)
- [服务器自动部署](docs/DEPLOYMENT.md)
- [天气接口与和风天气配置](docs/WEATHER.md)
- [产品需求与系统设计](docs/PRD.md)
- [前端设计、模块入口与接入边界](docs/FRONTEND.md)
- [Agent 事件契约](src/contracts/agent.ts)

## 项目状态

- [x] 协作骨架与共享契约
- [x] 双人偏好向导
- [x] 演示模式规划工作台
- [x] 测试、构建和 CI
- [x] 真实 Agent 工具链与规则降级
- [x] 局部重新规划 API
- [x] 响应式工作台与手机详情/轨迹切换
- [x] 锁定保护、局部替换演示与差异显示
- [x] 最终分享页与 PNG 长图
- [x] Netlify 在线部署与个人主页集成
- [x] 浏览器工作台接入实时 Agent 与重排 API
- [ ] Leaflet 真实地图
