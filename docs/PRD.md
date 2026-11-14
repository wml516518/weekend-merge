# Weekend Merge（周末共识局）产品需求与系统设计

> 文档状态：已确认，可进入实施规划
>
> 版本：1.0
>
> 日期：2026-11-11
>
> 目标周期：2–3 天
>
> 目标读者：项目开发者、代码评审者与招聘面试官

## 1. 项目概述

### 1.1 一句话定位

Weekend Merge 是一个双人周末决策 Agent。两位用户分别提交预算、时间、兴趣和雷区，Agent 调用天气、地点检索、路线估算与预算工具，找出冲突并生成三个可解释的折中方案；用户否决某一站后，Agent 只重排受影响区段。

### 1.2 项目目标

项目同时展示两类工程能力：

- AI Agent：结构化规划、Function Calling、显式状态机、工具调用上限、确定性验证、人工反馈和局部重新规划。
- 全栈前端：双人隐私填写、响应式规划工作台、地图与行程联动、流式执行轨迹、错误恢复和分享结果。

项目不是通用聊天机器人，也不展示模型隐藏思维链。用户看到的是可验证的工具事件、约束、来源和决策结果。

### 1.3 MVP 成功标准

- 两位用户可在 3 分钟内完成输入并得到三个候选方案。
- 每个推荐地点都能说明它满足了哪些偏好、引用了哪些工具结果。
- 用户否决一个地点后，锁定地点保持不变，系统仅重排受影响区段。
- 预算、时间、距离与硬约束由代码验证，不依赖模型自行计算。
- 模型或天气服务不可用时，预设演示流程仍可完整运行。
- 桌面端和移动端均可完成创建、规划、调整与分享主流程。

## 2. 用户与场景

### 2.1 目标用户

- 周末临时决定活动、偏好不同的朋友或伴侣。
- 希望减少“你想去哪”“都可以”式反复沟通的人。
- 需要在预算、天气、体力和时间等多个条件中快速折中的人。

### 2.2 核心使用场景

两位用户计划周六下午在上海活动。A 喜欢展览和安静咖啡馆，不愿长距离步行；B 喜欢城市散步和夜景，但不想排队。总预算为 300 元。系统发现两人的共同点与冲突，结合天气和地点数据生成三个方案。双方锁定晚餐，否决其中一个展览后，Agent 替换展览及相邻交通段，不修改晚餐。

## 3. 产品范围

### 3.1 MVP 范围

- 仅支持上海。
- 使用仓库内 40–60 个精选地点的数据集。
- 使用同一设备完成 A、B 两人的私密偏好交接。
- 生成三个主题明确、差异可辨的候选方案。
- 支持点赞、否决、锁定和最多两轮局部重新规划。
- 支持最终时间轴、地图、预算、天气提醒和图片导出。
- 支持预设演示场景与真实 Agent 两种运行模式。
- 状态保存在浏览器，刷新后可恢复当前流程。

### 3.2 明确不做

- 登录、账号、云端会话同步和跨设备实时协作。
- 支付、订位、购票、真实导航和实时交通。
- 全国或多城市地点搜索。
- 自动抓取第三方网站或系统性下载 POI。
- 多 Agent 协作、长期记忆和无限自主循环。
- 用户上传精确家庭住址；起点仅允许选择地铁站或商圈。

### 3.3 后续扩展方向

- 邀请链接与跨设备双人实时协作。
- 更多城市和可维护的地点数据后台。
- 合规的商业地点搜索与路线 API。
- 收藏、历史计划、日历写入和真实订位跳转。

这些能力不进入本次 2–3 天 MVP。

## 4. 用户流程

1. 用户创建计划，选择上海、日期、可用时段、总预算和起点商圈。
2. A 填写偏好并提交。页面遮住 A 的答案，提示将设备交给 B。
3. B 独立填写偏好并提交。
4. 系统揭晓共同偏好、软冲突和硬约束；双方确认开始规划。
5. Agent 执行天气查询、地点筛选、路线估算、预算计算和方案校验。
6. 工作台流式显示工具事件，并陆续呈现三个候选方案。
7. 双方选择方案，对站点点赞、否决或锁定。
8. 若有否决，Agent 保留锁定站点，仅重排否决站点及相邻交通段。
9. 双方确认最终方案并导出图片，或生成只读分享快照。

## 5. 前端信息架构

### 5.1 全局导航原则

- 应用首屏直接进入创建计划，不增加营销落地页。
- 流程分为“输入向导”和“规划工作台”两个阶段。
- 向导使用稳定的步骤条；工作台使用候选方案、地图和 Agent 轨迹三块布局。
- 所有主要状态都有可恢复入口，不用通用聊天框承担导航。

### 5.2 页面 1：创建周末计划

#### 页面目标

建立全局硬条件，为双方偏好填写提供上下文。

#### 字段

- 城市：固定为上海，显示“首版仅支持上海”。
- 日期：今天起 14 天内的周末日期。
- 时段：开始与结束时间，至少相隔 3 小时，最多 12 小时。
- 总预算：两人合计，范围 100–2,000 元。
- 起点：从预设商圈或地铁站列表选择，不接受自由输入地址。

#### 交互规则

- 使用日期控件、时间控件、数字步进器和起点菜单。
- 字段就地校验；未完成时主按钮不可用，并保留可读原因。
- 提交后进入 A 的偏好页。

### 5.3 页面 2：双人私密偏好

#### 输入项

- 兴趣排序：从展览、咖啡、城市散步、自然、公园、电影、桌游、夜景、逛店、美食中最多选择 5 项并排序。
- 活动节奏：轻松、平衡、充实，单选。
- 步行接受度：1、3、5、8 公里，单选。
- 室内外倾向：室内优先、均可、户外优先，分段控件。
- 饮食标签：多选。
- 预算倾向：省钱、平衡、体验优先，单选。
- 雷区：从排队、拥挤、长距离步行、早起、辛辣、酒吧、户外日晒中多选。
- 一句话愿望：可选，最多 80 字。

#### 私密交接

- A 提交后立即清空可见表单，展示全屏遮罩。
- 遮罩只显示“A 的偏好已保存”，不显示任何答案摘要。
- B 点击“我是 B，开始填写”后进入相同表单。
- 在 B 提交前，返回操作必须二次确认，避免意外看到 A 的答案。

### 5.4 页面 3：共识揭晓

页面按三组显示：

- 共同偏好：双方都选择或评分接近的项目。
- 可协商冲突：偏好方向不同但不违反雷区的项目。
- 硬约束：预算、时段、步行上限、饮食禁忌和明确雷区。

双方可以返回修改自己的偏好。点击“交给 Agent 规划”后，输入被冻结为本轮规划快照；后续修改需要重新开始规划。

### 5.5 页面 4：Agent 规划工作台

#### 桌面布局

- 左栏：候选方案 A/B/C、匹配分数和当前选择。
- 中栏：地图、路线序号、预算/距离/室内比例/换乘次数摘要、站点详情。
- 右栏：Agent 执行轨迹，显示步骤状态、工具结果摘要和来源。

#### 移动布局

- 地图保持主区域，不缩成小卡片。
- 候选方案使用地图上方横向切换标签。
- 行程详情和 Agent 轨迹使用互斥的底部抽屉。
- 底部固定操作栏包含喜欢、否决和锁定三个动作。

#### 流式状态

- `queued`：已提交，等待服务端开始。
- `running`：显示当前状态和已完成工具数量。
- `partial`：单个候选方案可用时立即展示，不等待全部完成。
- `completed`：三个方案完成并通过验证。
- `degraded`：使用缓存、规则模式或缺少天气数据。
- `failed`：显示失败步骤、可重试按钮和演示模式入口。

工作台不展示模型的隐藏思维链，只显示以下内容：

- 调用了哪个工具。
- 工具使用了哪些非敏感输入。
- 返回了什么可核验摘要。
- 哪项约束影响了方案。
- 当前步骤是否成功、降级或失败。

### 5.6 页面 5：协商与局部重排

#### 站点动作

- 喜欢：提高该地点在下一轮中的保留优先级，但不等于锁定。
- 否决：必须选择原因，也可填写最多 60 字的补充说明。
- 锁定：地点、开始时间和停留时长在后续重排中不可改变。

#### 局部重排规则

- 只替换被否决节点及其前后交通段。
- 锁定节点不可删除、换序或修改时间。
- 重新计算替换节点后的预算、距离和整条时间线。
- 重排结果显示变更前后差异，不只展示一套新方案。
- 最多重排两次；再次否决时要求用户放宽一个约束或重新开始。

### 5.7 页面 6：最终行程

- 时间轴：到达、活动、交通和用餐。
- 地图：按序号连接地点，标注“路线为估算，非实时导航”。
- 摘要：总预算、预计距离、室内外比例和天气提醒。
- 折中说明：双方各自获得了什么、哪些偏好未满足。
- 操作：导出长图、复制分享链接、返回编辑。

导出长图是主要分享方式。分享链接使用 URL fragment 携带压缩后的只读快照，不向服务端上传；快照序列化后必须小于 6 KB，超过时仅允许导出图片。

## 6. Agent 设计

### 6.1 设计原则

- Agent 是受控状态机，不允许模型无限自主循环。
- 模型负责分析、组合和解释；代码负责事实、计算、约束和状态流转。
- 所有模型输出通过 JSON Schema 校验。
- 初始规划最多 3 次模型请求（工具收集、最终提案、可选一次验证修复）和 8 次工具调用；修复时不得再触发工具。
- 每轮重排最多 1 次模型请求，重排最多 2 轮。

### 6.2 状态机

| 状态 | 执行者 | 职责 | 下一状态 |
| --- | --- | --- | --- |
| `VALIDATE` | 代码 | 校验输入完整性与硬条件 | `ANALYZE` 或失败 |
| `ANALYZE` | 模型 | 生成共同点、软冲突、硬冲突及优先级 | `GATHER` |
| `GATHER` | 模型 + 工具 | 按需取得天气、地点、路线和预算事实 | `PROPOSE` |
| `PROPOSE` | 模型 | 生成 3 个差异明确的结构化方案 | `VERIFY` |
| `VERIFY` | 代码 | 重算预算、时间、距离与约束 | `NEGOTIATE` 或返回修正一次 |
| `NEGOTIATE` | 前端 | 等待点赞、否决、锁定或确认 | `REPLAN` 或 `FINALIZE` |
| `REPLAN` | 模型 + 代码 | 在锁定约束下局部替换 | `VERIFY` |
| `FINALIZE` | 代码 | 最终验证并生成分享快照 | 完成或拒绝确认 |

重排闭环为：

```text
NEGOTIATE -> REPLAN -> VERIFY -> NEGOTIATE
```

### 6.3 模型职责

- 将双人偏好解释为共同点、冲突和优先级。
- 决定下一步需要调用哪个已注册工具。
- 从通过工具筛选的地点中组合三个主题方案。
- 解释每套方案的折中理由。
- 生成局部重排的变更摘要。

模型不得：

- 编造地点、营业时间、天气或价格。
- 自行计算并声明最终预算或距离。
- 修改锁定节点。
- 直接输出未通过 Schema 的自然语言结果。
- 将隐藏思维链发送到客户端或日志。

### 6.4 确定性代码职责

- 输入校验、状态流转、超时和循环上限。
- 地点过滤、天气查询、距离估算和预算计算。
- 硬约束校验与最终方案验证。
- 锁定节点保护和局部重排影响范围计算。
- 缓存、错误重试、限流、日志脱敏和演示降级。

## 7. 工具协议

### 7.1 `get_weather`

用途：查询活动坐标与时段内的温度、降雨概率和天气码。

```ts
type GetWeatherInput = {
  latitude: number;
  longitude: number;
  start: string; // ISO 8601
  end: string;   // ISO 8601
};

type GetWeatherOutput = {
  hourly: Array<{
    time: string;
    temperatureC: number;
    precipitationProbability: number;
    weatherCode: number;
  }>;
  source: "open-meteo" | "fixture";
  fetchedAt: string;
};
```

### 7.2 `search_places`

用途：从仓库内地点库筛选候选，不访问公共 POI 搜索服务。

```ts
type SearchPlacesInput = {
  requiredTags: string[];
  excludedTags: string[];
  maxPricePerPerson: number;
  indoorPreference: "indoor" | "mixed" | "outdoor";
  areas?: string[];
  openBetween: { start: string; end: string };
  limit: number; // 1..20
};

type SearchPlacesOutput = {
  places: Array<{
    placeId: string;
    matchScore: number;
    matchReasons: string[];
  }>;
};
```

### 7.3 `estimate_route`

用途：根据坐标、交通方式和缓冲系数估算行程，不冒充实时导航。

```ts
type EstimateRouteInput = {
  stops: Array<{ placeId: string; latitude: number; longitude: number }>;
  mode: "walk" | "transit" | "mixed";
};

type EstimateRouteOutput = {
  legs: Array<{
    fromPlaceId: string;
    toPlaceId: string;
    distanceKm: number;
    durationMinutes: number;
    mode: "walk" | "transit";
  }>;
  totalDistanceKm: number;
  totalDurationMinutes: number;
  estimated: true;
};
```

### 7.4 `calculate_budget`

用途：由代码计算门票、餐饮、交通与缓冲金额。

```ts
type CalculateBudgetInput = {
  items: Array<{
    category: "ticket" | "food" | "transport" | "other";
    label: string;
    unitPrice: number;
    quantity: number;
  }>;
  budgetLimit: number;
  bufferRate: number; // MVP 固定为 0.1
};

type CalculateBudgetOutput = {
  subtotal: number;
  buffer: number;
  total: number;
  withinBudget: boolean;
  breakdown: Record<string, number>;
};
```

### 7.5 `validate_plan`

用途：验证整条行程是否满足所有硬约束。

```ts
type ValidatePlanOutput = {
  valid: boolean;
  violations: Array<{
    code: string;
    message: string;
    affectedStopIds: string[];
  }>;
  warnings: Array<{
    code: string;
    message: string;
  }>;
};
```

至少检查：预算、总时段、地点营业时间、步行上限、饮食雷区、重复地点、交通时间、锁定节点和工具来源。

## 8. 数据模型

### 8.1 地点数据

每个地点必须包含：

```ts
type Place = {
  id: string;
  name: string;
  area: string;
  nearestTransit: string;
  coordinates: { latitude: number; longitude: number };
  category: string;
  tags: string[];
  indoor: boolean;
  typicalDurationMinutes: number;
  pricePerPerson: { min: number; max: number };
  openingHours: Record<string, Array<{ open: string; close: string }>>;
  closedDates?: string[];
  sourceUrl: string;
  lastVerifiedAt: string;
};
```

地点数据进入代码评审。`lastVerifiedAt` 超过 90 天时，工作台显示“信息可能已变化”，最终页提醒用户出发前确认。

### 8.2 核心会话数据

```ts
type PlanningSession = {
  sessionId: string;
  mode: "live" | "demo";
  setup: PlanSetup;
  preferences: { a: PersonPreferences; b: PersonPreferences };
  consensus: ConsensusSummary;
  run: AgentRun;
  candidates: Itinerary[];
  selectedPlanId?: string;
  feedbackEvents: FeedbackEvent[];
  replanCount: number;
  createdAt: string;
  updatedAt: string;
};
```

客户端将会话保存到 `localStorage`。服务端每次请求都接收完成当前操作所需的状态，不依赖进程内会话或数据库。

## 9. API 与流式事件

### 9.1 `POST /.netlify/functions/plan`

请求体包含 `setup`、两人 `preferences`、`mode` 和客户端生成的 `sessionId`。

响应使用 NDJSON 流，每行一个事件：

```ts
type AgentEvent =
  | { type: "run.started"; runId: string; at: string }
  | { type: "step.started"; step: AgentState; at: string }
  | { type: "tool.completed"; tool: string; summary: unknown; durationMs: number; source: string }
  | { type: "tool.failed"; tool: string; code: string; retryable: boolean }
  | { type: "plan.proposed"; plan: Itinerary }
  | { type: "run.degraded"; reason: string; fallback: string }
  | { type: "run.completed"; result: PlanResult }
  | { type: "run.failed"; code: string; message: string };
```

### 9.2 `POST /.netlify/functions/replan`

请求体包含：

- 当前已选方案。
- 所有锁定节点 ID。
- 否决节点 ID 与原因。
- 已有反馈事件。
- 当前重排次数。
- 原始硬约束与相关工具结果摘要。

响应同样使用 NDJSON，最终返回新方案和结构化差异。

### 9.3 错误格式

非流式输入错误使用统一格式：

```json
{
  "error": {
    "code": "INVALID_TIME_RANGE",
    "message": "结束时间必须至少比开始时间晚 3 小时",
    "field": "setup.endTime",
    "retryable": false
  }
}
```

## 10. 技术架构

### 10.1 推荐技术栈

- 前端：React、TypeScript、Vite。
- 状态：Zustand + `localStorage` 持久化。
- 地图：Leaflet + OpenStreetMap 瓦片。
- UI 图标：Lucide。
- 数据校验：Zod。
- 服务端：Netlify Functions + TypeScript。
- Agent：DeepSeek Chat Completions Tool Calls，模型 ID 通过 `DEEPSEEK_MODEL` 配置。
- 天气：Open-Meteo。
- 测试：Vitest、Testing Library、Playwright。
- 部署：Netlify。

默认模型为 `deepseek-flash`，可通过 `DEEPSEEK_MODEL` 覆盖。DeepSeek API 按 Token 计费，不描述为永久免费；无 Key 或模型不可用时自动使用规则模式。模型最终方案未通过校验时会先根据结构化反馈修正一次，再由服务端重算路线、预算和硬约束。

### 10.2 仓库结构

```text
weekend-merge/
├── src/
│   ├── features/wizard/
│   ├── features/workbench/
│   ├── components/
│   ├── state/
│   └── contracts/
├── netlify/functions/
│   ├── plan.ts
│   ├── replan.ts
│   └── agent/
│       ├── orchestrator.ts
│       ├── tools/
│       └── fallbacks/
├── data/places.shanghai.json
├── docs/
│   ├── PRD.md
│   ├── ARCHITECTURE.md
│   └── DEMO.md
├── tests/fixtures/
├── README.md
└── netlify.toml
```

本文件保存在独立项目仓库的 `docs/PRD.md`，README 和 Issues 应链接到本文件，而不是复制需求内容。

### 10.3 部署与个人简历集成

Weekend Merge 使用独立仓库和独立 Netlify 站点，不并入个人简历站点的构建产物。这样前端协作者可以独立开发和发布，Agent Functions、环境变量与简历站点也保持清晰边界。

- 应用仓库：`https://github.com/wml516518/weekend-merge`。
- 应用部署：Netlify Production Site，构建命令为 `npm run build`，发布目录为 `dist`，Functions 目录为 `netlify/functions`。
- 服务端密钥：`DEEPSEEK_API_KEY` 和 `DEEPSEEK_MODEL` 仅配置在 Weekend Merge 的 Netlify 环境变量中。
- 无密钥或模型不可用时：线上站点仍可进入明确标记的演示/规则模式，不得把规则结果伪装为 DeepSeek 结果。
- 简历集成：在个人主页的中英文“项目”列表和中英文“项目经验”中都增加 Weekend Merge。
- 项目入口：个人主页同时提供独立 Netlify Demo 链接和 GitHub 仓库链接，均在新标签页打开。
- 发布顺序：先发布并验证 Weekend Merge，再把确认可访问的生产 URL 写入个人简历站点，最后重新发布简历站点。

首版使用 Netlify 自动分配的站点域名。自定义域名或子域名不属于本轮范围，后续迁移不得改变应用仓库和简历内容的数据结构。

## 11. 异常处理与降级

### 11.1 模型异常

- 初始规划最多两个模型回合：第一回合选择工具，第二回合基于工具结果生成方案。
- 第二回合结构化输出无效时直接进入规则模式，不为修复格式突破两次模型请求上限。
- 任一回合超时或限流后进入规则模式。
- 规则模式根据共同标签、距离和预算从地点库组合三个基础方案。
- 页面明确标记“演示/规则模式”，不伪装成模型结果。

### 11.2 天气异常

- 单次请求超时上限为 4 秒。
- 优先使用 30 分钟内同坐标、同日期缓存。
- 无缓存时继续生成室内外混合方案，并标记天气不可用。
- 不生成虚构天气。

### 11.3 流式连接异常

- 客户端保留已收到的事件与候选方案。
- 未得到 `run.completed` 时，显示“继续重试”和“切换演示模式”。
- 重试生成新的 `runId`，并用 `sessionId` 与操作序号避免重复应用结果。

### 11.4 无解约束

若没有方案同时满足全部硬约束，系统不得偷偷违反约束。页面列出冲突，并要求用户在预算、时段、步行上限或地点类型中明确放宽一项。

## 12. 隐私、安全与可观察性

- DeepSeek API Key 只保存在服务端环境变量中。
- 不收集姓名、联系方式或精确住址。
- 自由文本在服务端限制长度并进行日志脱敏。
- 日志记录 `runId`、状态、工具名、耗时、成功/失败和脱敏摘要。
- 日志不记录 API Key、完整提示词、隐藏思维链和精确用户输入。
- API 添加基于 IP 与 `sessionId` 的基础限流。
- 对模型输出进行 Schema 校验，对渲染文本进行普通 React 转义。
- 分享快照位于 URL fragment，不会随 HTTP 请求发送到服务端。

## 13. 免费服务边界

以下结论截至 2026-11-11，发布前需要再次核对官方条款：

| 能力 | MVP 选择 | 边界 |
| --- | --- | --- |
| 天气 | Open-Meteo | 非商业免费 API 无需 Key；需署名并遵守调用限制 |
| 地图 | OpenStreetMap 瓦片 | 仅低流量正常交互；显示署名、遵守缓存策略、禁止批量下载 |
| 地点 | 仓库内 JSON | 免费且稳定；需要人工维护来源和验证日期 |
| 路线 | 本地估算 | 免费；必须声明非实时导航 |
| 模型 | DeepSeek API | 按 Token 计费；价格、模型和额度会变化 |
| 部署 | Netlify Free | 有每月硬上限；达到上限会暂停站点，不应描述为无限免费 |

官方参考：

- Open-Meteo：https://open-meteo.com/
- OpenStreetMap Tile Usage Policy：https://operations.osmfoundation.org/policies/tiles/
- Nominatim Usage Policy：https://operations.osmfoundation.org/policies/nominatim/
- DeepSeek API Pricing：https://api-docs.deepseek.com/quick_start/pricing/
- DeepSeek Tool Calls：https://api-docs.deepseek.com/guides/tool_calls/
- Netlify Pricing：https://www.netlify.com/pricing/

MVP 不使用公共 Nominatim 做自动补全或系统性 POI 搜索。

## 14. 测试与验收

### 14.1 工具单元测试

- 预算刚好等于上限、超过上限、缓冲金额与多人数量。
- 跨小时营业时间、闭馆日和活动超出营业时间。
- 路线空节点、单节点、多节点与步行上限。
- 雷区命中、排除标签、锁定节点被修改。
- 天气正常、超时、缓存命中和无数据。

### 14.2 Agent 场景测试

- 晴天且偏好高度一致。
- 雨天且一方偏好户外。
- 预算不足，必须给出放宽建议。
- 双方兴趣冲突但存在折中方案。
- 模型输出不符合 Schema。
- 模型限流后切换规则模式。
- 天气失败但地点和预算工具正常。
- 否决一个普通节点后的局部重排。
- 否决与锁定节点冲突时拒绝重排。
- 两次重排后停止自动循环。

### 14.3 前端组件测试

- A 提交后答案不可见，B 无法通过返回键直接查看。
- 刷新后从 `localStorage` 恢复当前步骤。
- 流式事件乱序或重复时不会重复添加方案。
- 工具失败可重试，已完成步骤保留。
- 锁定、否决和差异对比正确显示。
- 移动端抽屉不会遮挡固定操作栏。

### 14.4 端到端验收

使用固定演示数据完成：

```text
创建计划
-> A/B 私密填写
-> 共识揭晓
-> 生成三个方案
-> 锁定晚餐
-> 否决一个展览
-> 局部重排
-> 确认最终行程
-> 导出分享图
```

验收要求：演示模式无需外部 API 即可稳定通过该流程。

### 14.5 部署与简历集成验收

- Weekend Merge 的生产 URL 可以直接访问，刷新任意前端路由不会返回 404。
- `/.netlify/functions/plan` 和 `/.netlify/functions/replan` 仅接受约定方法，并返回符合共享 Schema 的事件或结构化错误。
- 浏览器构建产物和网络响应不包含 `DEEPSEEK_API_KEY`。
- 未配置 DeepSeek 时，生产站点仍可完成固定演示流程，并明确显示降级状态。
- 个人主页中英文“项目”列表均展示 Weekend Merge 的 Live 与 GitHub 入口。
- 个人主页中英文“项目经验”均包含 Agent 状态机、工具调用、局部重排和降级能力的简历级说明。
- 两个站点分别通过桌面与移动端检查，链接无误且不存在文字溢出或控件遮挡。

## 15. 两人分工

### 15.1 Agent / 全栈负责人

- 共享类型与 Zod Schema。
- Netlify Functions 与 NDJSON 流式协议。
- 状态机和 5 个工具。
- DeepSeek Tool Calls、规则降级和错误处理。
- 工具与 Agent 场景测试、部署环境配置。

### 15.2 前端体验负责人

- 视觉系统和响应式布局。
- 创建计划、私密偏好和共识揭晓向导。
- Leaflet 工作台、候选方案切换和站点交互。
- Agent 事件轨迹、错误恢复和移动端抽屉。
- 最终行程、分享图片和组件测试。

### 15.3 共同职责

- 开发开始前锁定 `src/contracts` 和测试 fixtures。
- 使用公开 GitHub Issues 划分任务，Pull Request 互相评审。
- 维护 README、架构图、演示脚本和截图/GIF。
- 发布前共同执行移动端、失败降级与端到端验收。

## 16. 2–3 天交付计划

### 准备阶段（1–2 小时）

- 创建独立公开仓库。
- 将本文复制为 `docs/PRD.md`。
- 定义共享类型、事件协议和 3 组测试 fixtures。
- 配置分支保护、CI 和环境变量示例。

### Day 1：并行完成主流程骨架

- 前端：完成向导、工作台静态布局和演示 fixtures。
- 后端：完成工具、状态机和规则演示模式。
- 当天结束前用 fixtures 跑通主流程。

### Day 2：真实 Agent 联调

- 接入 DeepSeek 与 Open-Meteo。
- 接通 NDJSON 流式事件。
- 完成局部重排、失败降级和移动端交互。
- 部署 Netlify Preview 进行联合验收。

### Day 3：简历级收尾（可选但推荐）

- 补齐测试、无障碍标签和响应式细节。
- 完成 README、架构图、演示 GIF 和 `docs/DEMO.md`。
- 发布 Weekend Merge 独立 Netlify 生产版本。
- 在个人主页中英文“项目”列表和“项目经验”中添加 Demo 与 GitHub 入口。
- 重新发布个人简历站点并验证两个站点之间的链接。

## 17. GitHub 展示要求

公开仓库至少包含：

- README 首屏 GIF 或短视频，展示共识分析、工具轨迹和局部重排。
- 在线 Demo 与演示模式入口。
- 本 PRD、架构文档和演示脚本。
- 架构图与 Agent 状态机图。
- 免费服务与数据来源说明。
- 本地运行、环境变量和测试命令。
- 两位贡献者的职责说明与真实 Pull Request 历史。

README 的项目亮点应强调：

1. 受控 Agent，而不是聊天套壳。
2. 工具结果和决策依据可观察。
3. 反馈触发局部重排，而不是整份答案重新生成。
4. 外部服务失败时仍可演示和测试。
5. 前端将复杂 Agent 状态转化为清晰的协商工作台。

## 18. 最终验收定义

项目只有在以下条件全部满足时才视为完成：

- 主流程和局部重排流程均可在线演示。
- 真实模式和演示模式均可用。
- 不存在客户端泄露 API Key 的情况。
- 所有确定性工具通过单元测试。
- 固定 E2E 演示场景通过。
- 桌面与移动端不存在文字溢出、控件重叠或不可操作区域。
- 地图、天气和地点数据展示正确署名与免责声明。
- README、PRD、架构说明和演示脚本已进入公开仓库。
- Weekend Merge 已独立部署到 Netlify，生产 URL 已写入个人主页。
- 个人主页中英文“项目”列表与“项目经验”均可访问在线 Demo 和 GitHub 仓库。
