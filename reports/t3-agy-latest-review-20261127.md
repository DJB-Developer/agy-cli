# T3 agy / ACP 最新增量复核（2026-11-27）

## 范围与结论

先读了本目录 `t3-agy-alignment-20261127.md`、`t3-agy-additional-updates-20261127.md`。本次 `git ls-remote` 返回 main **`cbcc74737d5931c67defcb236f88d1c415fe3cb6`**，提交时间为新加坡 **11-27 21:22:41**；下文固定该快照，不声称之后 main 不再变化。

相对基线 `44a533378653164dea96435e23c8ea27efaffedb`，本地 Git 完整对象比较得到 **263 个提交、704 个变更文件**，不是 GitHub compare 的截断列表。本轮 API 请求返回 403，改用公开 Git remote 与提交源码核验；已核查 provider、ACP adapter、MCP 和恢复编排相关 diff，并搜索全部增量提交标题。**前报告“最近 6 提交无 agy 变化”的结论已不适用于本快照：现在有 7 项直接相关变更。** [固定比较](https://github.com/pingdotgg/t3code/compare/44a533378653164dea96435e23c8ea27efaffedb...cbcc74737d5931c67defcb236f88d1c415fe3cb6)

本地 HEAD 为 `b42f976116d4b22f1f705dcf8327330877f97d5c`，但主线程同时修改工作区；下文是读取时的函数级静态判断，不是最终改动验收。未运行真实 agy、未读取凭据、未执行供应商请求或测试；只新增本报告，没有修改产品、测试或既有报告，没有提交/推送。

## 新增变化与适用性（按本仓价值排序）

### 1. P1：兼容性错误也应进入健康/目录诊断——#43810

上游把启动与 health probe 的版本拒绝逻辑统一。外部 launcher 的已知拒绝按真实路径、设备/inode、大小、mtime 绑定；二进制变化后使旧拒绝失效，较早完成顺序不能覆盖更新观测，线程专属环境也不污染全局观测。**不是健康检查每次新开 ACP/登录会话。** [Driver 固定源码](https://github.com/pingdotgg/t3code/blob/cbcc74737d5931c67defcb236f88d1c415fe3cb6/apps/server/src/provider/Drivers/AntigravityDriver.ts#L314-L423)、[probe](https://github.com/pingdotgg/t3code/blob/cbcc74737d5931c67defcb236f88d1c415fe3cb6/apps/server/src/provider/Drivers/AntigravityDriver.ts#L610-L648)

本地 `probeOfferedModels()` 遇旧版本直接 return，失败继续缓存/兜底；聊天则明确返回 `AGY_VERSION_UNSUPPORTED`。这不是缺少版本拦截，而是**列表可用与运行时可用的诊断落差**。建议保留既有目录契约，增加安全的不可用原因/观测版本；绑定 executable/account generation，换二进制或切账号清理，勿改为读凭据或额外在线 probe。未知版本不能伪装为已验证兼容。

离线验收：旧版目录仍可按契约返回，但诊断明确；替换文件、同路径换 symlink target、并发乱序 probe 不留下旧拒绝；不调用 session/new/prompt。

### 2. P1：prompt 前恢复失败的边界——#44172

新修复覆盖“线程已经 loaded，但 agent 重启后在 start 阶段才发现原生会话丢失”：只识别 `session/load` / `session/resume` 的请求错误；拒绝 outcome-unknown、非当前 attempt、有未完后台工作的情况；最多走一次 fresh-session handoff，再开始原请求。不是所有 404、超时或 prompt 失败都自动重试。[提交](https://github.com/pingdotgg/t3code/commit/d01ce6da1dace24258986441e427007ac781d76d)、[恢复条件与执行](https://github.com/pingdotgg/t3code/blob/cbcc74737d5931c67defcb236f88d1c415fe3cb6/apps/server/src/orchestration-v2/ProviderTurnStartService.ts#L2546-L2643)

本地 `#handshake()` 已有 resume 失败转 new，不能把上游修复称为本地尚无恢复。更值得检查的是本地 catch 范围：非取消/进程退出的 resume 错误均可能落入 new；应区分明确失效、版本/验证/TOS、传输结果未知，确保失败 session 不被再次 park。建议先加“已接受 prompt 后绝不自动重放”的离线不变量，再考虑缩窄错误分类；不要搬 T3 的 summary/transfer 数据模型。

### 3. P2：报告实际执行模型，而非仅请求模型——#44189

上游在 turn 结束时读取当前 session transcript 的有界尾部，从最后 USER_INPUT 之后的最新 PLANNER_RESPONSE.model 得到执行模型；路径/会话 ID 验证、只读、禁止末端 symlink，缺失/坏文件返回 unknown，不让读盘失败破坏聊天。它不通过 ACP 上报，也不是在线模型目录查询。[reader](https://github.com/pingdotgg/t3code/blob/cbcc74737d5931c67defcb236f88d1c415fe3cb6/apps/server/src/provider/acp/AntigravityChildWork.ts#L1507-L1557)、[接入提交](https://github.com/pingdotgg/t3code/commit/5d94090ed031fd37d27cca847f571ab5ce2da26c)

本地 `#setModel()` 保存所选模型，`model_usage` 日志引用 `proc.currentModel`，HTTP 输出使用调用方模型标识；这些不是实际执行模型证据。建议如确有诊断需求，单列 `requested_model` / `executed_model`，只读取当前 account/session 的有界数据，不递归扫历史；缺证据不猜。**先保留 HTTP model 回显契约**，不要把流开始后的观测硬改已发送响应。多个 PLANNER_RESPONSE/自动路由时，最新模型也不等于本轮所有调用都由它计费。

### 4. P2（需原型评估，不是窄补丁）：冻结工具箱的延迟工具代理——#39362

这是本增量最显著的架构变化：agy 每轮冻结工具箱，上游将可选 T3 工具经常驻 `tool_call` 代理调用，`tool_search` 返回带预算的 schema，而非仅发 list_changed 指望当前轮见到新工具；补齐代理身份解析、参数中的 toolSummary 清理、权限目标校验。只允许已知目标，不代理代理本身或 tool_search。[提交](https://github.com/pingdotgg/t3code/commit/bddcfb717c57a30eb469013ef5caf26449d43e5c)、[曝光策略](https://github.com/pingdotgg/t3code/blob/cbcc74737d5931c67defcb236f88d1c415fe3cb6/apps/server/src/mcp/McpToolExposure.ts)、[权限识别](https://github.com/pingdotgg/t3code/blob/cbcc74737d5931c67defcb236f88d1c415fe3cb6/apps/server/src/provider/acp/AntigravityAcpSupport.ts#L192-L222)

本地已有 `toolsGrew()` 与 steering/new-session 路径，明确知道新工具下一次 prompt 才能使用；因此不能判定当前实现遗漏了冻结问题。本仓是外部宿主声明/执行工具，不拥有 T3 全套内部工具 registry：代理会改变工具 ID、schema、授权和结果关联契约。只有要减少大工具箱预算或 ToolSearch 后重建会话时才值得独立原型；权限必须仍以宿主已声明目标为界，测试未知目标/递归代理/同名不同 server/取消/结果仅交付一次。不要为同步上游自动放开 agy 原生 shell、文件或浏览器权限。

### 5. P2/P3：截图结果保留；子 agent/通知展示

- **#43977**：ACP 图像结果以前可能被文本 sanitizer 丢弃；现在合法 base64 图像使用独立预算，恢复结果还有每 turn 32 Mi 字符上限。是 T3 自有 MCP 结果恢复/展示，不保证模型原生工具结果已收到图像。[提交与最终补丁](https://github.com/pingdotgg/t3code/commit/d3aa2dd496d34f0f8d18c765b4f548ca416f08b7)
  - 本地已有 `textOnlyResult()`、`renderLateResultParts()` 与图片走后续 prompt 的桥接路径，不应复制 T3 UI 缓存；只建议核对图片数量/总字节上限、取消后不补发、同结果不重复交付。
- **#44099**：修正原生子 agent 已报告完成但父轮尚未结束时仍显示 running；**#43795**：ACP info notice 不再一律显示 warning，未知 severity 当 info。[子 agent 提交](https://github.com/pingdotgg/t3code/commit/83b6c4cd1362cc2673b8ef8a93d42cd4e301c88b)、[notice 提交](https://github.com/pingdotgg/t3code/commit/f22d01bf77c9034e4989b0168a66f880e942d56a)
  - 本仓无对应 T3 原生子线程/notice 卡片，不直接移植，也不扩大 transcript/inbox 轮询。

## 前轮遗留候选：本轮收窄，而非重复列功能

1. **P1，模型选择失败保活：仍值得窄查。** 读取时本地 `#setModel()` 包装为普通 Error，`#runTurn()` 只为特定 AgentTurnError 保活，其他错误 drop/stop。可针对“已有会话、明确参数拒绝、prompt 尚未发送”设计保活；不能把可能已部分应用的 model/effort 当成全未改变，需要刷新或作废 selection key，下一次强制重选。该问题是前轮候选，不是这 263 提交新增修复；本次未复现。
2. **P2，睡眠感知超时仍缺显式实现。** 本地 `Turn.rearm()` 读取 Date.now 并一次 setTimeout，未看到上游分片检测 suspend 的逻辑；先 fake clock 验证，不延长断开的外部工具等待契约，也不发 keepalive。[已有上游修复](https://github.com/pingdotgg/t3code/pull/39395/files)
3. **P2，probe 持久会话清理先证明再删。** 当前只看到进程终止和临时 cwd 删除，不能据此证明 profile DB 已清理或一定泄漏。上游核验 session/workspace 归属后清理的原则有价值，但本次不触碰真实 profile。[已有补丁](https://github.com/pingdotgg/t3code/pull/39275/files)
4. **降低优先级：thinking 默认污染。** `noteOfferedModels()` 只保存 offered IDs/names，不把 `thought_level.currentValue` 写入目录默认；`#setConfig()` 的 configOptions 属于 Proc。未找到与上游 #42931 同构的确定缺陷，先用跨模型 fixture 证明，别无依据重写 catalog。
5. **降低优先级：retired reset。** 本地 `watchPromptOutcome()` 用 prompt 前 MAX(idx) 限定新记录，完成时检查最新 error step；没有 T3 持续接收 retired prompt 的相同路径。相对 reset 仍以读取时刻计算，长延迟读可能偏晚，可补时间锚测试，但不要声称当前每次轮询都在延长冷却。[本地 outcome reader](/Users/gold/code/agy-cli/turn-outcome.mjs)

## 不变的边界

本次相关 diff 未改变 `AntigravityTurnOutcome`、安装器、auth spawn 环境或共享 `AcpSessionRuntime` 文件；没有发现新增的最低版本/身份策略整改。现有 1.5.1 gate、零内部额度 HTTP、auto-update=true、token 去重、验证/TOS 硬停止应保持。当前 `t3-code` clientInfo 是前轮明确保留的差异，不是“真实自身身份已对齐”，更不是授权或防封保证。

建议顺序：**先完善兼容性诊断与 prompt 前失败边界测试；再选择实际执行模型的可选诊断；工具代理另开原型；不要把 UI/原生子 agent 机制塞入桥接层。** 本报告所有“本地缺口”均为静态审查/待验证建议，不是已跑测试的缺陷定论。
