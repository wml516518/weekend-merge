# 天气接口与和风天气配置

实时 Agent 的天气工具优先请求 Open-Meteo；请求超时、响应无效或行程内没有可用小时数据时，尝试已配置的和风天气 QWeather。两者均失败时发出 `WEATHER_UNAVAILABLE` 并明确降级，不把演示天气或当前天气冒充未来行程的预报。演示模式不请求这两个接口。

## 免费额度与能力

2026-11-14 核对的[官方定价](https://dev.qweather.com/docs/finance/pricing/)：天气和基础服务价格组每个自然月前 50,000 次请求价格为 0 元，各项服务请求量合并累进，超出部分按量计费。这不是无限免费，其他项目共用账户的用量也需要核对。本次接入不购买付费计划，不修改账户支付设置；开通前请自行检查控制台的服务权限、用量和费用限制。

[新版小时天气预报](https://dev.qweather.com/docs/api/weather/weather-hourly-forecast/)使用 `GET /weather/v1/hourly/{latitude}/{longitude}`，`hours` 支持 1–240，覆盖全球经纬度。不要将旧版 `/v7/weather/24h` 的字段、降水概率单位或服务权限套用到此接口。本项目使用上海中心参考坐标，申请到的实际权限和服务器网络连通性仍需用真实凭据验证。

每个上游请求超时 4 秒，依次失败最多约 8 秒。成功结果缓存 30 分钟，合并相同查询的并发请求；失败结果不缓存。和风天气只接受覆盖完整行程的逐小时结果：不足 240 小时范围、缺失小时、字段错误或鉴权/额度失败都会明确报错。日期太远时不会改用今天的天气。

## 申请凭据

1. 在[和风天气控制台](https://console.qweather.com/)注册并进入项目管理，创建或选择项目。
2. 在凭据区域创建 `API KEY` 凭据；服务器请求使用 `X-QW-Api-Key` 标头，不把 Key 放在 URL 中。
3. 从控制台复制你的专用 [API Host](https://dev.qweather.com/docs/configuration/api-host/)，形如 `abcxyz.qweatherapi.com`。配置值仅填写域名，不带 `https://`、端口、路径或结尾斜杠，不使用旧版公共域名。

[官方鉴权文档](https://dev.qweather.com/docs/configuration/authentication/)当前支持 API Key 和 JWT，并推荐 JWT；从 2027-01-01 起将限制 API Key 每日请求数量，具体以官方和账户控制台为准。本次为简化个人演示的配置使用 API Key，未实现 JWT 自动签发。长期运行或请求量增长前应迁移到 JWT。

## 上线前的来源署名（交给前端同伴）

本次保持前端组件、布局与交互不变。**补齐本节署名后再在公开站点启用 QWeather 凭据。** 现有页面的纯文本 `source: qweather` 不能代替必需的超级链接。

[官方要求](https://dev.qweather.com/docs/terms/attribution/)：在使用天气数据的页面清晰展示“和风天气”或“QWeather”，链接到 `https://www.qweather.com`。新版 API 还要求将 `metadata.attributions` 与数据共同展示。

后端 `tool.completed` 提供：

```json
{
  "tool": "get_weather",
  "source": "qweather",
  "summary": {
    "source": "qweather",
    "attributions": ["https://developer.qweather.com/attribution.html"]
  }
}
```

这只是字段示例，实际 `summary` 还包括行程区间、小时数、温度范围和降水概率。前端应在天气卡片旁展示“天气服务由和风天气驱动”链接，以及响应提供的全部 `summary.attributions`；只有 `http:` 或 `https:` URL 才应渲染成链接，其他归因文本作为普通文本显示。不要把第三方文本当作 HTML。无需改变向导、模型选择或规划交互。

## 服务器配置位置

在阿里云服务器的 `/home/admin/apps/weekend-merge/.env` 中编辑，**保留已有 DeepSeek 配置**，加入：

```dotenv
QWEATHER_API_HOST=你的专用域名.qweatherapi.com
QWEATHER_API_KEY=你申请的APIKey
```

不要把 Key 发在聊天中，不要提交 `.env`，不要加 `VITE_` 前缀。Key 无需放入 GitHub Actions 或前端 Netlify 环境变量。可用 `nano /home/admin/apps/weekend-merge/.env` 编辑，`Ctrl+O`、回车保存，`Ctrl+X` 退出。

部署版本从现有 PM2 进程继承环境，**仅修改 `.env` 不会自动生效**。新版本部署且署名完成后，用管理该应用的 `admin` 用户运行：

```bash
cd /home/admin/apps/weekend-merge
chmod 600 .env
./.deploy/run-node --env-file=/home/admin/apps/weekend-merge/.env -e 'require("node:child_process").execFileSync("pm2", ["restart", "weekend-merge", "--update-env"], { stdio: "inherit" })'
pm2 save
curl -fsS http://127.0.0.1:8787/healthz
```

这会重启唯一的 `weekend-merge` 应用，有短暂不可用。后续 CI/CD 发布和自动回滚都会保留 `QWEATHER_API_HOST`、`QWEATHER_API_KEY`；不会继承未明确允许的其他 PM2 环境。

## 验证

在页面发起一次未来 10 天内的实时规划，查看工具轨迹：

- `get_weather` 成功且 `source: qweather`：实际使用了 QWeather 预报或其成功缓存。
- `source: open-meteo`：优先接口已恢复，不会额外消耗 QWeather 请求。
- `WEATHER_UNAVAILABLE`：两个上游都未取得可用预报，不能判定天气已接通。
- 没有 `run.degraded` 且三个候选方案完成：整条 Agent 流程通过；天气成功本身不代表模型生成方案一定通过约束校验。

返回模型的天气包含 `weatherCodeSystem: qweather`，避免把和风天气现象码误当成 Open-Meteo 的 WMO 码；降水概率从原始 0–1 转为百分数，时间转为上海时间，保留响应中的归因信息。API Key 和上游错误正文不会进入工具证据。
