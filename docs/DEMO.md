# 本地 Agent 演示

在项目根目录操作。需要 Node.js 22+；可以使用 Netlify CLI，也可以使用仓库内的自托管服务器。只有把固定请求转换为实时请求或运行锁定冲突示例时才需要 `jq`。先运行 `npm install` 和 `npm run build`，然后启动 `npm run start`（默认 `http://127.0.0.1:8787`）；若使用 Netlify CLI，可运行 `netlify dev`，默认端口为 `8888`。以下示例使用 `8888`，使用自托管服务器时换成 `8787`。这些命令会调用本地 Function；仅在配置 DeepSeek 后，实时规划才会请求模型。演示日期和地点是固定样例，实际出行前需重新核对。

## 固定规划事件

仓库中的 `tests/fixtures/plan-request.demo.json` 就是此演示的固定、完整 JSON 请求体，`mode` 为 `demo`；下面的 `curl` 直接以 `--data-binary @tests/fixtures/plan-request.demo.json` 提交，无需 `jq`。响应为逐行 JSON 事件，最后一行为 `run.completed`，包含三个 `candidateIds`，不含 `diff`。

```bash
curl -sS -N -X POST 'http://localhost:8888/.netlify/functions/plan' \
  -H 'Content-Type: application/json' \
  --data-binary @tests/fixtures/plan-request.demo.json
```

这个模式及浏览器工作台使用 `createDemoRun()` 展示 fixture。其部分地点 ID 不在服务端目录中，因此不要把展示方案直接提交给 `replan`。

## 无密钥实时降级

确保本地 `.env` 和 Netlify 站点配置中没有 DeepSeek Key，再启动一个本地 Netlify 进程（先停止上一个进程）。将同一完整请求的 `mode` 改为 `live`。此路径不会调用模型或天气网络工具；事件会包含 `run.degraded`、`reason: "MODEL_UNAVAILABLE"` 和三个已验证的规则候选方案。

```bash
env -u DEEPSEEK_API_KEY -u DEEPSEEK_MODEL netlify dev
```

```bash
jq '.mode = "live"' tests/fixtures/plan-request.demo.json | \
  curl -sS -N -X POST 'http://localhost:8888/.netlify/functions/plan' \
    -H 'Content-Type: application/json' --data-binary @-
```

实时有密钥模式需在 Function 服务端配置 `DEEPSEEK_API_KEY`；可选配置 `DEEPSEEK_MODEL`，默认值为 `deepseek-flash`。API Key 不能放在 `VITE_` 变量中。可用的五个工具为 `get_weather`、`search_places`、`estimate_route`、`calculate_budget`、`validate_plan`；天气查询范围由服务端从请求设定推导为上海人民广场与指定日期时间。Open-Meteo 不可用时不会生成虚构天气。

## 否决并局部重排

下面的完整请求使用服务端静态地点目录中的四个站点，前后两站已锁定。它与固定展示事件无关。将代码块作为一个 shell 命令运行，即可生成随后 curl 使用的 JSON 请求文件。

```bash
cat > /tmp/weekend-replan.json <<'JSON'
{
  "sessionId": "replan-demo",
  "setup": {
    "city": "上海", "date": "2026-11-14", "startTime": "10:00", "endTime": "20:00",
    "budget": 2000, "startingArea": "徐汇滨江"
  },
  "preferences": {
    "a": {
      "interests": ["展览", "逛店"], "pace": "轻松", "walkingLimitKm": 8,
      "indoorPreference": "室内优先", "foodTags": ["本帮菜"], "budgetStyle": "平衡",
      "avoid": [], "wish": "想看一个展览，再找个地方休息"
    },
    "b": {
      "interests": ["展览"], "pace": "平衡", "walkingLimitKm": 8,
      "indoorPreference": "均可", "foodTags": [], "budgetStyle": "省钱",
      "avoid": [], "wish": "想留一点时间看城市风景"
    }
  },
  "plan": {
    "id": "original", "title": "原方案", "summary": "四站行程", "matchScore": 80,
    "totalCost": 110, "totalDistanceKm": 10, "indoorRatio": 75,
    "transfers": 2, "reasons": ["共同兴趣"],
    "stops": [
      {
        "id": "stop-0", "placeId": "shanghai-book-city", "name": "上海书城福州路店", "area": "人民广场",
        "startTime": "11:00", "endTime": "11:45", "cost": 0,
        "latitude": 31.2312, "longitude": 121.4809, "tags": ["书店", "阅读", "文化"], "locked": true
      },
      {
        "id": "stop-1", "placeId": "jic-books-pujiang", "name": "建投书局浦江店", "area": "北外滩",
        "startTime": "13:00", "endTime": "13:45", "cost": 0,
        "latitude": 31.2497, "longitude": 121.5046, "tags": ["书店", "阅读", "江景"], "locked": false
      },
      {
        "id": "stop-2", "placeId": "manner-xuhui-riverside", "name": "Manner Coffee 徐汇滨江店", "area": "徐汇滨江",
        "startTime": "15:00", "endTime": "15:45", "cost": 100,
        "latitude": 31.1719, "longitude": 121.4637, "tags": ["咖啡", "江景", "休息"], "locked": false
      },
      {
        "id": "stop-3", "placeId": "north-bund-aviation-center", "name": "北外滩国客中心滨江", "area": "北外滩",
        "startTime": "17:00", "endTime": "17:45", "cost": 0,
        "latitude": 31.2505, "longitude": 121.5077, "tags": ["夜景", "江景", "散步"], "locked": true
      }
    ]
  },
  "lockedStopIds": ["stop-0", "stop-3"],
  "rejectedStopId": "stop-1", "reason": "换一个展览", "replanCount": 0
}
JSON
```

```bash
curl -sS -N -X POST 'http://localhost:8888/.netlify/functions/replan' \
  -H 'Content-Type: application/json' --data-binary @/tmp/weekend-replan.json
```

响应只有一个 `plan.proposed`。最后的 `run.completed.result` 有一个 `candidateIds` 元素和 `diff`；被锁定的 `stop-0`、`stop-3` 保持原样。可信客户端应将 `replanCount` 从 0 递增到 1 后停止；Function 仅验证传入值为 0 或 1，不保存会话历史，因此不能阻止重复传入同一计数。重排完全本地运行，不依赖 DeepSeek 或天气服务。

固定示例日期为周末 `2026-11-14`。HTTP 只接受上海今天至未来 180 天的周末，示例超期后请把两个请求中的 `setup.date` 改为有效周末；共享静态 Schema 不读取当前时间，因此 fixture 本身始终可测试。`plan` 可在模型等待期间逐行看到早期进度。相同 IP 与会话的实时请求每十分钟最多五次，超限返回可重试的 429；演示不占额度。

重排的 `reason` 保留用于兼容，建议另传明确的 `reasonCode`（见 README）。只支持固定关键词；无法识别时返回 `UNSUPPORTED_REPLAN_REASON`。例如改为 `不要再安排展览，想喝咖啡` 会筛选咖啡且排除展览；`想换成另一个展览` 保持展览类别并排除当前地点。若固定/锁定站点使新类别无法满足硬约束，会返回 422。

## 锁定站点冲突

同一请求中将被否决的 `stop-1` 加入锁定列表，会得到 HTTP 409 和 JSON 错误码 `LOCKED_STOP_CONFLICT`；此时不会返回 NDJSON。

```bash
jq '.lockedStopIds += ["stop-1"]' /tmp/weekend-replan.json | \
  curl -sS -i -X POST 'http://localhost:8888/.netlify/functions/replan' \
    -H 'Content-Type: application/json' --data-binary @-
```

地点营业时间与价格来自 `data/places.shanghai.json` 的静态资料，并记录 `lastVerifiedAt`；路线距离和时间是估算，均不是实时数据。
