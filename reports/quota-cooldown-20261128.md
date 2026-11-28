# 真实额度错误驱动本地冷却（2026-11-28，未发布）

## 实现范围

本轮从 `5ce7a9e` 开始；原有三份未跟踪研究文件未修改。修改 `usage.mjs`、`index.mjs`、测试入口及回归和中英文文档。包版本仍为 0.2.19；不提交、push 或发布。

- 只从原生结束提示（Individual / Third-party quota reached）、明确 ACP 请求错误或当前 prompt 的数据库 `QUOTA_EXHAUSTED` 学习耗尽状态。普通 RESOURCE_EXHAUSTED / 429 不足以生成冷却；TOS、验证和 503 仍保持原分类。
- 仅约束当前账号中失败的实际模型与思考档位，记录已用过的请求别名。没有把 Individual 推断为全账号或把 Third-party 推断成所有 Claude/GPT；如真实池关系不能证明，宁可分别从请求学习。
- 已知恢复时间保存为固定绝对时间。新请求先查本地状态，再做目录探测与会话获取；接近发送 prompt 时再次检查，覆盖排队期间新发生的冷却。返回 429 / QUOTA_EXHAUSTED、reset_at / resets_at / Retry-After，不在每次刷新重新计算倒计时起点。
- `auth.usage` 的 `used:100` 仅表达“真实请求已证明耗尽”，并提供模型集合与 resetsAt；不是远程查询百分比，不推测未知模型的剩余量。有效窗口不同时附上 usage error，以免宿主将其视为失败读取。
- 无重置时间只给文字观测，不给 used:100 或永久路由锁。后续成功请求可以清除该未知时间观测，但早发晚回的成功不能覆盖更新的耗尽证据。
- 当前实现仅运行时内存，128 条模型记录上限，无持久凭据或新状态文件，无后台定时器。过期/重载返回未知，不伪造 0% 已用或满额。默认 CLI 在正常请求发现登录指纹变化时清理观测；请求入站捕获代际，旧身份迟到错误不能污染新状态。具名账号使用独立运行时。
- 已运行工具的回传不被入口冷却拦住；若随后仍需新 prompt 则检查冷却。出现文本/思考、工具调用或已提交工具结果的额度失败带 noRetry。不在插件内切换账号、自动重发请求或重放工具。TOS 持久停用不随额度过期解除。

## Magpie 契约核对（只读，没有修改/启动宿主）

使用本地已有 Magpie 源码快照 `.sandbox/magpie-status-repro`，HEAD `b754cb0958925c1625acd752577fb8a73987ae28`：

- `internal/plugin/providers.go` 的 UsageWindow：used 为百分比、resetsAt 为 RFC3339、models 为作用模型集合。
- `internal/provider/plugin_usage.go` 的 quotaOfPlugin：模型集合用于匹配，缺少 used 的文字行不参与额度权重；error 被保留为 PluginError。
- `internal/gateway/routing.go` 的 resetsAt / resetsIn：错误的 resets_at 和绝对时间文字可用于路由冷却。插件继续沿用这些错误字段和 Retry-After。

这不是对用户当前运行的 Magpie 版本做端到端路由验收。宿主实际重试/切换仍由其版本、路由组、缓存刷新和 noRetry 策略决定；即使宿主旧缓存尚未更新，插件也会本地拒绝已知冷却模型的新 prompt。

## 验证

全部使用假 ACP/CLI、本地 SQLite 和临时 HOME；不使用真实账号、不消耗线上模型额度，不声称操作系统级断网。

- 9 项新增冷却测试包含给定 `136h30m57s` 样例、固定绝对 reset、零新进程/模型探测、跨模型/账号隔离、原生 RPC 错误、无时间、部分输出、工具交付/并发冷却、取消、代际和旧成功证据保护。
- 新增桥接用例运行于修改前 index：6 fail / 3 pass，确认不是只测新模块自身；新状态模块在该反向验证中仍为新实现。
- Node 24.18.0 定向（冷却/本轮结果/原生结束提示/usage/零查询）：62/62。
- 首轮组合 Bun 定向运行因一个测试误用 SSE reader 读取非流式 429 而失败，随后触发 Bun 多文件 node:test 嵌套错误；修正测试按响应类型读取。Node 定向和后续独立子套件均通过，不放宽产品断言。
- 最终 Bun 全套、独立 smoke 和打包检查结果见下方。

### 最终结果

- macOS / Bun 1.3.7 完整入口 **39 pass / 0 fail**（各子套件以独立进程运行；这是包装测试计数，不是内部总用例数），日志 `.sandbox/quota-cooldown/verified-bun.log`。
- 独立假 CLI smoke **368 checks 全过**；Node 定向 **62/62**。
- `node --check`（index / usage）、`git diff --check` 和 `npm pack --dry-run --json` 通过，发布清单仍为 24 文件；无需新增运行时文件。
- 没有运行真实 Magpie 账号路由、Linux/Windows 或供应商模型请求；没有 commit/push/npm 发布。
