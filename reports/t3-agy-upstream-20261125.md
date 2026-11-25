# T3 Code → agy-cli 保守同步研究（2026-11-25）

> 本文为同步前的静态研究，所列本地行号针对基准版本；本轮实际实现与验证结果见 [同步记录](/Users/gold/code/agy-cli/reports/upstream-sync-20261125.md)。

## 范围与结论

- 上游固定为 [`072611f65fc3b77f13909ce451e87c3e265d8b05`](https://github.com/pingdotgg/t3code/commit/072611f65fc3b77f13909ce451e87c3e265d8b05)，不是随时间变化的 `main`。旧目录仅作差分基线：`634ee43deb6d5fc0feae77153d33df1e97ffb303`（2026-11-21 00:42:37 UTC）。已从 GitHub API/raw 获取当前源码及相关路径提交记录；全仓 compare 的文件清单截断，故没有据此断言全仓无其他变化。
- 本地基准：`69fc5eccefa9bb70b9f0c4b5baed97e55ecc0907`、[package.json:3](/Users/gold/code/agy-cli/package.json:3) 的 **0.2.17**。研究期间其他代理出现未提交测试改动，本报告不评价那些改动；下文指本次读取的既有实现。
- **优先同步的是错误语义，不是通信身份或更多后台请求**：新版错误文本/JSON、`VALIDATION_REQUIRED` 非重试分类、`Resets in` 恢复时间。本地启动/取消已有界限、自动更新默认已正确禁用、TOS 持久隔离也已存在。
- 只读取源码，未运行 agy、未读取实际凭据/会话数据库、未调用 Google 业务接口、未构建或运行测试；唯一写入为本报告。以下是静态证据，不是运行验证或封号因果结论。

## 11 月 21 日之后，哪些变化值得同步

### 1. 错误格式兼容：真实 502、1.5 状态行、账号验证

- **新增**：11 月 23 日 [1d4d9be：真实 502 错误](https://github.com/pingdotgg/t3code/commit/1d4d9be3ff925d5d5ecc90859bdcbd20ecb04b15) 支持 `Status: 502 Bad Gateway`，并避免跨越相邻错误串接消息。**不是本期新增**的 `STATUS (code NNN): message` 兼容，在当前上游仍保留。[当前解析器 L21–50](https://github.com/pingdotgg/t3code/blob/072611f65fc3b77f13909ce451e87c3e265d8b05/apps/server/src/provider/acp/AntigravityTurnOutcome.ts#L21-L50)
- **新增**：11 月 25 日 [3e74a0a：账号验证链接](https://github.com/pingdotgg/t3code/commit/3e74a0aac5c53459cc1d3d84eec915fa483f2836) 从本轮原生错误步骤的 JSON 中要求 `403 + PERMISSION_DENIED + google.rpc.ErrorInfo + cloudcode-pa.googleapis.com + VALIDATION_REQUIRED`，输出 `permission_error`、`retryable: false`，保留可复用会话，要求人工验证后重试；不将其认作 TOS 封禁。[错误提取 L185–253](https://github.com/pingdotgg/t3code/blob/072611f65fc3b77f13909ce451e87c3e265d8b05/apps/server/src/provider/acp/AntigravityTurnOutcome.ts#L185-L253)
- 验证链接不是任意服务端 URL：上游只接受 HTTPS 的 `accounts.google.com/(v3/)?signin/continue?...`，并限制长度、控制字符等。[URL 契约 L1733–1747](https://github.com/pingdotgg/t3code/blob/072611f65fc3b77f13909ce451e87c3e265d8b05/packages/contracts/src/orchestrationV2.ts#L1733-L1747)
- **本地缺口**：[turn-outcome.mjs:77](/Users/gold/code/agy-cli/turn-outcome.mjs:77) 仅识别旧式 `Error NNN ... Status: [A-Z_]+`，否则默认 `502/AGY_TURN_FAILED`。上述新格式的 403/验证错误可能退化为通用 502；[index.mjs:2261](/Users/gold/code/agy-cli/index.mjs:2261) 随后按这个状态向客户端传递。应补统一结构化分类，让显式访问拒绝不会被宿主当瞬时网络故障重试。普通 403、订阅不足、验证要求、TOS、429 必须分别表达，不能互相推定。

### 2. 配额恢复时间：新增文字倒计时与延迟观察保护

- 11 月 24 日 [8261b23](https://github.com/pingdotgg/t3code/commit/8261b23226ce96fac30221c16ee9b05933a6f367) 增加 `Resets in 4m42s.`；优先绝对时间，其次 `quotaResetDelay`、`retryDelay`、文字倒计时。已退休 prompt 的迟到检查不再把相对延迟加到“现在”，避免不断推迟恢复时间。[时间解析 L137–148](https://github.com/pingdotgg/t3code/blob/072611f65fc3b77f13909ce451e87c3e265d8b05/apps/server/src/provider/acp/AntigravityTurnOutcome.ts#L137-L148)、[迟到检查 L329–352](https://github.com/pingdotgg/t3code/blob/072611f65fc3b77f13909ce451e87c3e265d8b05/apps/server/src/provider/acp/AntigravityTurnOutcome.ts#L329-L352)
- 本地 [turn-outcome.mjs:52](/Users/gold/code/agy-cli/turn-outcome.mjs:52) 已严格检查时间、溢出和 Go duration，但缺 `Resets in`。已有 [index.mjs:5913](/Users/gold/code/agy-cli/index.mjs:5913) 将 `reset_at` 转成 `Retry-After`，应复用而非新增主动探测。保留本地更严格的非法日期/溢出拒绝；若增加迟到观察路径，显式传入错误发生时间或不推算相对时间。

### 3. 启动、取消和后台工作：对齐边界，不盲搬时长

- 11 月 22 日 [2f19cec](https://github.com/pingdotgg/t3code/commit/2f19cec07933f9f5fe1fe380d98b0841f83b90be) 为 `initialize`、首次 `session/new`/`session/resume` 增加 **90 秒** RPC 等待上限。[timeout L1415–1432](https://github.com/pingdotgg/t3code/blob/072611f65fc3b77f13909ce451e87c3e265d8b05/packages/provider-acp/src/server/AcpSessionRuntime.ts#L1415-L1432)、[session setup L2481–2503](https://github.com/pingdotgg/t3code/blob/072611f65fc3b77f13909ce451e87c3e265d8b05/packages/provider-acp/src/server/AcpSessionRuntime.ts#L2481-L2503)。本地 [index.mjs:1769](/Users/gold/code/agy-cli/index.mjs:1769) 已有整个握手 **60 秒**预算与 AbortSignal，不能说本地“缺启动超时”；优先验证超时/取消后进程、pending RPC 都清理，而非单纯加长为 90 秒。
- 当前 T3 对 Antigravity 使用 `wait-for-prompt`：等 prompt 已投递再 cancel，等待取消结束，默认 **15 秒**未结束则退休 runtime；取消与后续 prompt 共用 dispatch permit。这是已有设计，本期差分未改动该取消核心。[cancel L2622–2671](https://github.com/pingdotgg/t3code/blob/072611f65fc3b77f13909ce451e87c3e265d8b05/packages/provider-acp/src/server/AcpSessionRuntime.ts#L2622-L2671)、[串行化 L2955–2959](https://github.com/pingdotgg/t3code/blob/072611f65fc3b77f13909ce451e87c3e265d8b05/packages/provider-acp/src/server/AcpSessionRuntime.ts#L2955-L2959)
- 本地 [index.mjs:2155](/Users/gold/code/agy-cli/index.mjs:2155) 已处理 prompt 前取消，[index.mjs:2304](/Users/gold/code/agy-cli/index.mjs:2304) 已发送 `session/cancel`、默认最多等 15 秒并清理进程。应加离线交错测试：cancel-before-dispatch、cancel 与下一 prompt、迟到 MCP/结果，而不是据静态差异直接重写。
- 本期另加后台 pending reply 检查，以及丢失后台命令终止通知时 **30 分钟**的 hold 上限；普通 follow-up 不应取消仍在运行的后台命令。[当前 Adapter L244–263](https://github.com/pingdotgg/t3code/blob/072611f65fc3b77f13909ce451e87c3e265d8b05/apps/server/src/orchestration-v2/Adapters/AntigravityAdapterV2.ts#L244-L263)。T3 原生 agent 工作流与本地 MCP bridge 的长工具补交循环不同，不能照搬这项超时。[本地补交 L2212](/Users/gold/code/agy-cli/index.mjs:2212)

### 4. 自更新与环境隔离

- 11 月 25 日 [4da8d19](https://github.com/pingdotgg/t3code/commit/4da8d19d08ed7e34fe2d5d66dae54b01eab122fc) 将 `AGY_CLI_DISABLE_AUTO_UPDATE` 从 `"1"` 改为 `"true"`。[当前 L235–241](https://github.com/pingdotgg/t3code/blob/072611f65fc3b77f13909ce451e87c3e265d8b05/apps/server/src/provider/antigravityAuthSupport.ts#L235-L241)。本地 [platform.mjs:68](/Users/gold/code/agy-cli/platform.mjs:68) **已经默认 `"true"`**，且尊重用户显式值，无需重复同步。
- 11 月 24 日 [700a464](https://github.com/pingdotgg/t3code/commit/700a4644a44afc1b127a4df323e7d833abd8779b) 修正共享 ACP runtime 完整 `env` 被父环境重新合并的问题，主要是 AppImage 环境污染。本地 [accounts.mjs:24](/Users/gold/code/agy-cli/accounts.mjs:24) 用显式空值避免 API 认证变量被重新带入；可审查语义，但不要复制 T3 的平台伪装/存储选择环境变量作为“安全措施”。

## CLI/ACP 与 auth/quota：相同基础，不同产品边界

1. **两者均通过真实 `agy acp` 子进程通信，不是自行实现聊天上游 HTTP。** T3 使用独立 profile 与 `--app-data-dir antigravity-acp`，eager authenticate、`session/resume`，根据 agent capability 决定是否追加系统提示；本地使用临时桥接 agent、`--ide-mcp-port`、自己的 MCP 工具桥和 `antigravity-cli` 存储，`initialize → resume/new` 未显式调用 `authenticate`。不能直接换用 T3 的数据库路径/参数/登录顺序。[T3 spawn L547–572](https://github.com/pingdotgg/t3code/blob/072611f65fc3b77f13909ce451e87c3e265d8b05/apps/server/src/provider/antigravityAuthSupport.ts#L547-L572)、[T3 runtime L115–147](https://github.com/pingdotgg/t3code/blob/072611f65fc3b77f13909ce451e87c3e265d8b05/apps/server/src/provider/acp/AntigravityAcpSupport.ts#L115-L147)、[本地 L1723](/Users/gold/code/agy-cli/index.mjs:1723)、[本地握手 L1788](/Users/gold/code/agy-cli/index.mjs:1788)
2. **版本与身份**：T3 文档要求 1.5+，建议 1.5.12+；本地最低检查仍为 1.4.12，未知版本放行。T3 源码对 1.5.1+ 使用自己名称，旧版有 `zed` 回退；本地已经使用自身包名，应保留，**不要同步旧版身份伪装**。仅据实际离线协议 fixture 制定版本支持矩阵，不凭 T3 文档改声称“已兼容”。[T3 文档 L65–70](https://github.com/pingdotgg/t3code/blob/072611f65fc3b77f13909ce451e87c3e265d8b05/docs/user/providers-antigravity.md#L65-L70)、[T3 clientInfo L75–112](https://github.com/pingdotgg/t3code/blob/072611f65fc3b77f13909ce451e87c3e265d8b05/apps/server/src/provider/acp/AntigravityAcpSupport.ts#L75-L112)、[本地 L63–91](/Users/gold/code/agy-cli/index.mjs:63)
3. **配额 HTTP 并非本期新增**：逐文件差分确认 `AntigravityAuth.ts`、`antigravityUsageLimits.ts` 自基线未变。T3 当前 personal 配额同时读 daily/prod 的 `retrieveUserQuotaSummary`，无有效窗口才读 `fetchAvailableModels`；每请求 10 秒、整体 30 秒、禁止跟随重定向，失败不等于登出。后台读 single-flight，登录/退出会中断旧结果。[HTTP L343–348](https://github.com/pingdotgg/t3code/blob/072611f65fc3b77f13909ce451e87c3e265d8b05/apps/server/src/provider/antigravityUsageLimits.ts#L343-L348)、[配额 L434–495](https://github.com/pingdotgg/t3code/blob/072611f65fc3b77f13909ce451e87c3e265d8b05/apps/server/src/provider/antigravityUsageLimits.ts#L434-L495)、[single-flight L260–299](https://github.com/pingdotgg/t3code/blob/072611f65fc3b77f13909ce451e87c3e265d8b05/apps/server/src/provider/AntigravityProvider.ts#L260-L299)
4. **不能笼统说“T3 从不刷新 OAuth”**：新版 CLI token 快过期时仅提示正常 turn 续期；但旧 `acp_token.json` 分支会直接请求 OAuth refresh，并请求 userinfo 用于账号归并。[两个分支 L360–432](https://github.com/pingdotgg/t3code/blob/072611f65fc3b77f13909ce451e87c3e265d8b05/apps/server/src/provider/antigravityUsageLimits.ts#L360-L432)。本地 0.2.17 的配额路径明确不发送后台 prompt/OAuth refresh，token 不可用就返回 unavailable，值得保留。[quota-http.mjs:227](/Users/gold/code/agy-cli/quota-http.mjs:227)
5. **本地请求面略大且已有较强界限**：一次有效额度读取发两份 summary，同时另读 `loadCodeAssist` plan；若当前模型未被 summary 声明覆盖，再两份 model 请求，即该路径最多 **5 次元数据 HTTP**（不含 CLI 内部行为；不是重试次数）。有同账号 in-flight 合并、换账号 abort/代际栅栏，单请求默认 5 秒、总预算上限 15 秒；显式 TOS 响应阻止后续补充查询，但已并发发出的请求仍可能完成。[quota-http.mjs:130](/Users/gold/code/agy-cli/quota-http.mjs:130)、[quota-http.mjs:188](/Users/gold/code/agy-cli/quota-http.mjs:188)、[plan.mjs:21](/Users/gold/code/agy-cli/plan.mjs:21)。若要降低后台开销，可评估宿主刷新节流/短 TTL 与 plan 按需刷新；本报告未审计宿主实际轮询频率，不能声称存在请求风暴。

## 明确拒绝与“封号风险”的证据边界

- **TOS 已有硬停止应保留**：本地只在 CLI 错误/HTTP 403 等错误来源中检测明确 TOS 信息，持久记录、后续 gate、隔离路由；不把普通 403/地区限制/过期/额度耗尽都叫封号。[service-status.mjs:7](/Users/gold/code/agy-cli/service-status.mjs:7)、[index.mjs:2277](/Users/gold/code/agy-cli/index.mjs:2277)。本次读取的 T3 turn classifier 没有等价的 TOS 持久隔离机制；不能用其通用错误处理替换本地这一保护。
- **429 只能证明服务端返回资源/频率相关拒绝，不能单凭它证明提示词命中风控，更不能证明封号。** 当前 T3 将 429/`RESOURCE_EXHAUSTED` 分类 `usage_limit`，把可重试性作为数据，保留 resetAt；这不等于这个函数自己自动重发。[T3 L263–276](https://github.com/pingdotgg/t3code/blob/072611f65fc3b77f13909ce451e87c3e265d8b05/apps/server/src/provider/acp/AntigravityTurnOutcome.ts#L263-L276)。本地 [index.mjs:2284](/Users/gold/code/agy-cli/index.mjs:2284) 关于“system prompt 被匹配”的说明/400 改写是本地启发式，不是这份上游源码证实的服务端契约；建议改为忠实报告状态与不确定性，不新增提示词改写、身份伪装、跨账号规避。
- 这些源码只能支持“更准确地显示错误、避免无效重复请求、减少残留进程/过期结果”等工程判断。**没有封禁率数据或 Google 内部判定依据，不能宣称同步 T3 可防封号，也不能从请求数量推定封禁因果。**

## 建议顺序（后续实现，非本次执行）

1. **P0**：统一 `STATUS (code NNN)`、数字 HTTP status、JSON ErrorInfo 分类；对验证/明确访问拒绝停止自动重试并提示人工动作，TOS 继续持久隔离。仅向用户展示白名单验证链接，不自动访问。
2. **P0**：补 `Resets in`，贯通既有 `reset_at/Retry-After`；保留无时间锚时“不猜恢复时间”。
3. **P1**：离线 fixture 覆盖普通 403≠TOS、验证 403≠502、订阅不足、429/503、多个串接错误、消息中引用错误不算错误、迟到结果；再验证取消交错和未响应握手清理。可扩展既有 [test/turn-outcome.mjs:20](/Users/gold/code/agy-cli/test/turn-outcome.mjs:20)，不需要真实账号。
4. **P1**：保留现有 HTTP 超时、single-flight、账号栅栏及不后台续 token；先度量宿主实际刷新频率，再决定短 TTL/plan 按需化。不要为“追齐 T3”新增 userinfo、旧 OAuth refresh 或伪装 User-Agent。
5. **无需同步**：`AGY_CLI_DISABLE_AUTO_UPDATE="true"`、基础 15 秒取消收敛已经具备；T3 UI/skills/原生 swarm 改动不直接适用于模型桥。
