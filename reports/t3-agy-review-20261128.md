# T3 / agy 最新复核：额度错误、恢复时间与切换边界（2026-11-28）

## 结论和取证范围

本轮复用 `.sandbox/t3code-20261121/source`，仅 fetch 公开 upstream main，固定到 **`f5bf14070f8145a63e322aab7bb2fbdca1780ee8`**（提交时间新加坡 **2026-11-28 09:17:25**）。相对昨日报告的 `cbcc74737d5931c67defcb236f88d1c415fe3cb6`，Git 对象比较为 **185 个提交、736 个变更文件**。这是抓取时快照，不承诺此后 main 不变。[固定比较](https://github.com/pingdotgg/t3code/compare/cbcc74737d5931c67defcb236f88d1c415fe3cb6...f5bf14070f8145a63e322aab7bb2fbdca1780ee8)

**关键纠偏：T3 的 Antigravity `usage_limit` 失败 + 按线程定时继续，不等于本仓的按账号/模型缓存耗尽并在入口返回 429；未找到本仓这套冷却表来自 T3 的证据。T3 也没有在所核查的 Antigravity 失败/恢复链路中自动轮换 Google 账号、把 Individual/Third-party 映射为共享额度池，或无条件换模型重放失败请求。** 多实例、显式 provider switch、代理 hub 额度来源是另外三层机制，不可混称自动 failover。

本地 HEAD 为 `5ce7a9e5df23d58a4d684c59a0318a64a954f7c6`，工作区有未提交实现。阅读了 [usage.mjs](/Users/gold/code/agy-cli/usage.mjs)、[index.mjs](/Users/gold/code/agy-cli/index.mjs)、[turn-outcome.mjs](/Users/gold/code/agy-cli/turn-outcome.mjs) 和 [本轮实现说明](/Users/gold/code/agy-cli/reports/quota-cooldown-20261128.md)。以下是静态源码研究，不是独立复跑测试的验收。没有运行真实 agy/模型请求、读取凭据、改产品或测试、改旧报告、提交或推送；只新增本文。公共源码通过 Git 获取并按固定 SHA 检查，网页只用于确认官方仓库。

## 一、T3 实际如何处理 quota（多数是旧机制，不是今日新增）

### 1. 识别与失败分类比本仓宽，不宜原样移植

`watchAntigravityPromptOutcome` 在 prompt 前记录本会话 steps 游标，结束时只看之后的末条 step；error 类型为 17，payload 最多 16 KiB。`refusal` **本身**或文本 `reason:QUOTA_EXHAUSTED` 都可成为 `usage_limit`，`retryable:true`、threadDisposition `reusable`。另一路 HTTP 429 / RESOURCE_EXHAUSTED 也分类为 `usage_limit`，不要求明确 QUOTA_EXHAUSTED。因此 T3 的 `usage_limit` 同时涵盖额度耗尽和限流，不是足以驱动本仓长期硬锁的严格证据。[分类源码 L207–284](https://github.com/pingdotgg/t3code/blob/f5bf14070f8145a63e322aab7bb2fbdca1780ee8/apps/server/src/provider/acp/AntigravityTurnOutcome.ts#L207-L284)

这里的 reusable 表示原生线程没有被判定为不可恢复，**不是承诺同一进程必定保持，也不是自动重试许可**。ACP adapter 的 outcome hook 明确说明失败会重启 runtime，broken 才要求下一轮 fresh session。[adapter 契约](https://github.com/pingdotgg/t3code/blob/f5bf14070f8145a63e322aab7bb2fbdca1780ee8/packages/provider-acp/src/server/adapter.ts#L453-L468)

本仓目前只让明确原生 quota banner、ACP 错误或本轮 DB 的 QUOTA_EXHAUSTED 进入缓存，普通 429/503 不写冷却，TOS/验证优先；这是针对本桥接层更保守的设计，不能为了“同步 T3”放宽。[本地 catch/observe](/Users/gold/code/agy-cli/index.mjs:2320)

### 2. reset 是错误证据，不是额度百分比查询

T3 优先有效 `quotaResetTimeStamp`，再取 `quotaResetDelay`、`retryDelay`、`Resets in`，解析 Go duration。正常结果以检查时刻为相对时间锚；**retired prompt 不计算相对 reset**，因为检查可能远晚于错误发生，只保留可解析的绝对 timestamp。[reset parser](https://github.com/pingdotgg/t3code/blob/f5bf14070f8145a63e322aab7bb2fbdca1780ee8/apps/server/src/provider/acp/AntigravityTurnOutcome.ts#L145-L157)、[retired 分支](https://github.com/pingdotgg/t3code/blob/f5bf14070f8145a63e322aab7bb2fbdca1780ee8/apps/server/src/provider/acp/AntigravityTurnOutcome.ts#L355-L369)

AntigravityProvider 的 managed provider 没有接入专用额度读取回调；Driver 的 `usage` 是本地历史 token/cost scan，不是 allowance 查询，更没有把错误转换为模型 `used:100` 窗口的这套本地缓存。[provider 初始化](https://github.com/pingdotgg/t3code/blob/f5bf14070f8145a63e322aab7bb2fbdca1780ee8/apps/server/src/provider/AntigravityProvider.ts#L395-L408)、[历史扫描接口](https://github.com/pingdotgg/t3code/blob/f5bf14070f8145a63e322aab7bb2fbdca1780ee8/apps/server/src/provider/Drivers/AntigravityUsage.ts)

### 3. “冷却”的主要执行范围是失败线程/run，不是所有同账号请求

`UsageLimitRecoveryWorker` 只处理 failed + usage_limit + 有 latestRunId/reset 的线程；归档、settled、有 pending runtime request 时不执行。过期时间不晚于失败完成时间则不安排，防止立即循环；首次补装计划最多允许迟到 24 小时。由 autoResume/snooze 偏好或已有恢复计划决定是否继续；恢复身份绑定 **thread + run + reset + requestId**，到点发送新的 continuation 消息，而不是重新投递原始用户请求。[完整 worker L18–79](https://github.com/pingdotgg/t3code/blob/f5bf14070f8145a63e322aab7bb2fbdca1780ee8/apps/server/src/orchestration-v2/UsageLimitRecoveryWorker.ts#L18-L79)

该 worker 在本次基线之后没有改动。它不维护本仓式 account/model Map、不向其余线程统一短路、不挑备用账号。`ProviderSwitchService` 接收显式 `targetModelSelection` 后规划实例切换与会话移交；支持多个 Antigravity 实例不等于自动余额路由。[switch 接口](https://github.com/pingdotgg/t3code/blob/f5bf14070f8145a63e322aab7bb2fbdca1780ee8/apps/server/src/orchestration-v2/ProviderSwitchService.ts#L37-L75)、[多实例 Driver](https://github.com/pingdotgg/t3code/blob/f5bf14070f8145a63e322aab7bb2fbdca1780ee8/apps/server/src/provider/Drivers/AntigravityDriver.ts#L128-L137)

### 4. 有一个容易误读的“fallback”：代理 hub reset 补全

ProviderEventIngestor 遇 usage_limit 且没有 reset、实例有 auth.endpoint 时，会询问匹配 endpoint 的 hub 来源；以**失败 run 的模型**而非用户后来改的 selection 匹配。`hubPoolResetAt` 要求所有匹配路由账号都有可读、已耗尽、模型适用的窗口及未来 reset；单账号取耗尽窗口最晚 reset，再从账号间取最早恢复。任何未知或尚未耗尽的账号都会使结果 unknown。这个 fallback 只补全**恢复时间**；它不是由 T3 实现账号轮转，更不是推断 Google Individual/Third-party 池的依据。[ingestor L705–734](https://github.com/pingdotgg/t3code/blob/f5bf14070f8145a63e322aab7bb2fbdca1780ee8/apps/server/src/orchestration-v2/ProviderEventIngestor.ts#L705-L734)、[hub 算法与 endpoint 约束](https://github.com/pingdotgg/t3code/blob/f5bf14070f8145a63e322aab7bb2fbdca1780ee8/apps/server/src/usage/UsageLimitSources.ts#L319-L375)

## 二、今日真正的新 delta 与适用性

### P1：静默 prompt 已完成时，别误报 timeout（#44294）

上游新增 steps.status 检查：仅 retired、没有 failure、末 step 为 PLANNER_RESPONSE(15) 且 DONE(3)，才返回 completed。adapter 先隔离旧 transport、推进 callback generation、要求重启 runtime，再发布完成。不是“看到任意文本即成功”，也没有重发原 prompt。[提交](https://github.com/pingdotgg/t3code/commit/2a7b91ba93519e32170258a44b4f576872b64506)、[退役处理](https://github.com/pingdotgg/t3code/blob/f5bf14070f8145a63e322aab7bb2fbdca1780ee8/packages/provider-acp/src/server/adapter.ts#L9900-L9967)

本地 `timeoutTurn()` 目前直接 fail/drop/stop，outcome reader 主要在 RPC resolve/reject 后执行；因此值得增加**超时终结前的有界本轮证据检查**。它也可帮助把静默 quota 错误及时分类，但相对 reset 必须采用可信首次观测锚，不能从超时时刻重新延长。先做 fake ACP + SQLite fixture：DONE 回复 / 最新 error / 缺 status / 旧 turn 记录 / 取消 / 未交付工具，保证绝不把不确定或有未完工具的状态当成功。[本地 timeout](/Users/gold/code/agy-cli/index.mjs:2462)

### P2：实际执行模型继续传播到 token analytics（#44212、#44219）

昨日已经有执行模型 reader；今天补的是 turnTokenUsage.models 与执行模型一致，以及默认 Antigravity 模型的 telemetry label。不是今天新发明 transcript reader，更不是额度池映射。[analytics 提交](https://github.com/pingdotgg/t3code/commit/a515034c592fe67ad685bd9b44f03df2781d3e00)、[默认模型 label](https://github.com/pingdotgg/t3code/commit/8458f00788a79c814fac0d4531862cb4b8afab3f)

本仓 observe 用 `resolveAgyModel()` 后传入 #runTurn 的 model，属于**已选择模型**，尚不是 transcript 证明的实际执行模型。错误发生在回答前还可能根本没有 executed model。建议至少把诊断命名分开 requested/selected/executed/unknown，HTTP model 回显保持原契约；不要用上一条成功模型来给本轮耗尽错误归池。

### P2：额度刷新不再做完整健康探测（#41726）

上游新增独立 refreshUsageLimits 路径及刷新合并，避免刷新 Usage 时触发完整 provider health。此优化不是重新开放 Antigravity 内部额度查询。本仓 `createUsageReader()` 已是纯本地读取，主要借鉴为不变量测试：重复 auth.usage 不启动 CLI、不探测模型、不请求 OAuth。[提交](https://github.com/pingdotgg/t3code/commit/316095659c9c3a33cae04ec00f7b8f1c13136628)

### P3：共享进程 idle 线程解绑；原生 goal 显示

#44020 在共享 provider session unload 后移除 idle thread attachment，防止后续状态向历史线程重复广播；#44462 是 ACP 原生 /goal 的活动/结束状态显示。本仓无同构的 T3 多线程投影和原生 goal UI，不建议直接搬。仅把“旧会话订阅/回调不得污染后来请求”纳入池回收回归。[解绑提交](https://github.com/pingdotgg/t3code/commit/5f435d14570dc22fa10fd03633788d044a330ca3)、[goal 提交](https://github.com/pingdotgg/t3code/commit/34ebf307f79e9d6e967720d6c0d722dc4959a8fa)

## 三、当前待发布冷却实现：优先核查风险

以下不是宣布已复现缺陷，也不重复实现说明中的已通过测试；是静态读码确定的设计行为及待验证边界。

1. **P1：冷却 scope 的描述应纠正。** `modelKey` 去掉 effort 后缀，observe 主动加入 minimal/low/medium/high/xhigh/max 全档。因此是“当前运行时账号的基础模型及其 effort variants”，不是只锁失败的那一档。报告中的“实际模型”也尚无 executed-model 证据。继续不推断全账号或全第三方池是正确的；确认真实目录是否有语义不同但同后缀的模型，使用 catalog 关系比无条件字符串归一更稳。[usage L16–53](/Users/gold/code/agy-cli/usage.mjs:16)
2. **P1：账号身份变化与 usage 可见性。** 默认账号 sync 在普通请求入口执行，auth.usage 自身不 sync；换登录但尚未有新聊天时，旧冷却窗口可能仍展示。具名账号以 account.dir 为身份，路径不变的重新登录不能仅凭 sync 自动区分。现有 logout/clear 可以覆盖部分路径，但建议离线覆盖外部换登录、同 profile 重登录、usage-first、旧进程迟到错误。不要因此新增凭据读取或在线 probe；复用已有登录代际通知。[入口 sync](/Users/gold/code/agy-cli/index.mjs:6265)、[本地 reader](/Users/gold/code/agy-cli/usage.mjs:4)
3. **P1：固定 reset 已做到，但首次时间锚仍是读取时刻。** 同一 entry 重读不会延长，这是正确的；DB 或 terminal notice 被延迟观察时，relative reset 仍可能偏晚。observe 还保留新旧 reset 中更晚者，不会接受后来缩短的恢复时间，且成功仅清未知 reset 条目。需要明确这是一种保守策略；测试乱序错误、后到更早 reset、时钟跳变、延迟读，不要把“保存绝对时间”误称“已证明 provider 精确恢复点”。[parse 与 watcher](/Users/gold/code/agy-cli/turn-outcome.mjs:56)、[保留最晚 reset](/Users/gold/code/agy-cli/usage.mjs:53)
4. **P1：路由可靠性仍需宿主契约验收。** 插件负责准确 429/reset/noRetry 和本地短路，不负责切号。部分输出/工具副作用后的 quota noRetry 是必要边界；应以假宿主验证 SSE 已开始后的错误、缓存仍旧时连续调度、所有账号冷却、未知 reset、取消时不投递工具两次。现有报告的 Magpie 源码快照核对不能替代用户当前版本的端到端行为证据。
5. **P2：缓存上限与失效语义。** 128 entries / 64 aliases 是有界优点，但逐出可让未到 reset 的模型再次可发送；进程重载也变 unknown。未知 reset 记录没有时间过期，只能由成功/clear/容量逐出移除。作为观测而非持久封锁可以接受，但诊断最好区分 observedAt、unknown、expired；不可把空窗口解释成满额，也不要恢复后台余额查询。[缓存代码](/Users/gold/code/agy-cli/usage.mjs:21)

## 四、旧候选仍是旧候选

昨日的兼容性目录诊断、prompt 前恢复错误收窄、model selection 明确拒绝后的保活、睡眠感知超时、probe 持久会话清理、冻结工具箱代理仍可按原优先级研究；本次没有把它们重新计为新增功能。尤其 T3 的 resume fallback 是原生会话失效时的上下文移交，**不是额度 failover**。[昨日固定研究](/Users/gold/code/agy-cli/reports/t3-agy-latest-review-20261127.md)

建议顺序：**先校准冷却 scope/模型/账号身份的表述与离线边界 → 补静默 prompt 的本轮终态证据 → 宿主级 failover/noRetry 契约测试 → 可选执行模型诊断。** 保持零内部额度 HTTP、未知不猜、TOS/验证硬停止、无插件内账号轮换和自动请求重放。
