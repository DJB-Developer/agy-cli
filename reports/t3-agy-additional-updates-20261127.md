# T3 Code 最近一周其他 agy 更新（2026-11-27）

## 范围、版本与结论

- 本轮 GitHub API 固定 main：[`44a533378653164dea96435e23c8ea27efaffedb`](https://github.com/pingdotgg/t3code/commit/44a533378653164dea96435e23c8ea27efaffedb)，提交时间 **2026-11-27 02:12:21（Asia/Singapore）**。
- 相比刚核对的 `a77493caa565ae4e8c12ffb6721e37b3a2c6c06c` 仅新增 **6 个提交、19 个文件**；完整 compare 没有 Antigravity/agy/provider-acp 实现变化，新增主要是 composer/context 引用、终端输出恢复、ZIP 日期、语音词典大小写。[固定 compare](https://github.com/pingdotgg/t3code/compare/a77493caa565ae4e8c12ffb6721e37b3a2c6c06c...44a533378653164dea96435e23c8ea27efaffedb)
- 下文按 **11 月 20 日至本次查询** 的本地日期窗口整理，时间均为新加坡。所有列出的 PR 都经 API 确认为 `merged=true`，不是仅根据 issue 标题；重点项另读最终 patch 并核对当前源码。它们是近一周累计变更，不能都称为“刚刚新增”。
- #43026 移除内部额度 HTTP、#43087 真实自身身份与 1.5.1 门槛，已在[专门报告](/Users/gold/code/agy-cli/reports/t3-agy-alignment-20261127.md)说明，下文只作分类背景，不重复展开。
- 仅只读调研；未运行 agy、未读真实凭据、未发模型请求、未改产品/测试、未提交。本报告不推断封禁效果。通用 ACP 的启动/恢复/取消变更由主线程另行核对，本报告只简述专属 agy 机制。

## 1. 启动、安装、登录

| 已合并 PR / 新加坡时间 | 实际更新与边界 |
|---|---|
| [#38953](https://github.com/pingdotgg/t3code/pull/38953/files) · 11-20 07:41 | 原生 Google 登录先用 `agy acp --login` 获取链接/接收授权码，随后新 ACP 进程验证并加载模型；不再依赖原生 ACP 忽略的浏览器 helper。 |
| [#28355](https://github.com/pingdotgg/t3code/pull/28355/files) · 11-20 07:18 | 登录中 runtime 因信号/退出码崩溃时显示 CLI 退出，不一概怪 Google 凭据；不暴露任意 stderr。 |
| [#39363](https://github.com/pingdotgg/t3code/pull/39363/files) · 11-20 12:30 | T3 受管 CLI 的磁盘变更检测、POSIX 发布目录权限、跨进程安装锁、同 release 重装修复；当时设置 auto-update=`1`，随后由 #42545 修正，因此不能把早期 PR 的值当当前实现。 |
| [#42545](https://github.com/pingdotgg/t3code/pull/42545/files) · 11-25 11:09 | `AGY_CLI_DISABLE_AUTO_UPDATE` 从 `"1"` 改成 CLI 实际接受的 `"true"`，覆盖其共享 spawn 环境。是避免运行中自更新破坏 T3 安装管理，不是风控规避。 |
| [#39485](https://github.com/pingdotgg/t3code/pull/39485/files) · 11-20 14:07 | Google consumer 登录走各实例自己的 profile 文件，避免多个实例共用 OS keyring 登录；T3 使用 SSH_CONNECTION 选择文件存储。此 PR 当时涉及额度 keyring 的部分已被 #43026 删除，不能说如今仍有那条额度路径。 |
| [#39443](https://github.com/pingdotgg/t3code/pull/39443/files) · 11-20 09:50 | 在别处登录成功或成功刷新/启动会话后，清除已结束的失败/取消登录流程提示，不让界面同时显示已登录和旧失败。不会取消一个仍在进行的授权流程。 |
| [#42475](https://github.com/pingdotgg/t3code/pull/42475/files) · 11-25 07:14 | 模型刷新透传安全的 runtime resolve/setup 原因，不再统统变成“刷新失败”；#43087 后续进一步保留版本升级说明。 |

当前证据：[spawn 环境 L202–244](https://github.com/pingdotgg/t3code/blob/44a533378653164dea96435e23c8ea27efaffedb/apps/server/src/provider/antigravityAuthSupport.ts#L202-L244)、[清除陈旧登录流程 L713–721](https://github.com/pingdotgg/t3code/blob/44a533378653164dea96435e23c8ea27efaffedb/apps/server/src/provider/AntigravityAuth.ts#L713-L721)。

**对本仓**：本地默认已是 `true`，不必重复改；T3 受管安装器不是本地已有功能，不能直接搬整套目录锁/权限。多账号隔离原则适用，但不应把 SSH/WSL 环境差异称为防封方案。

## 2. 原生错误、更准确的恢复指引

| 已合并 PR / 新加坡时间 | 实际更新与边界 |
|---|---|
| [#39869](https://github.com/pingdotgg/t3code/pull/39869/files) · 11-21 05:27 | 支持 `STATUS (code NNN)` 错误文本；区别模型已回答后出现的 404 与首答前模型不存在/无权限。前者保留实际错误、标记可重试并提供 continue 恢复提示，后者不据此认作临时边缘错误。 |
| [#33596](https://github.com/pingdotgg/t3code/pull/33596/files) · 11-23 11:47 | 解析 `Status: 502 Bad Gateway`，防止相邻错误串误拼接；晚到的 retired prompt 错误没有可靠时间锚，不再用当前时刻推算相对 reset，避免不断延后冷却。 |
| [#42339](https://github.com/pingdotgg/t3code/pull/42339/files) · 11-25 03:02 | 从 `Resets in 4m42s.` 等原生文本恢复 resetAt；仍优先明确时间戳和结构化 delay，不凭空猜重置时间。 |
| [#41210](https://github.com/pingdotgg/t3code/pull/41210/files) · 11-25 13:23 | 识别结构化 403/VALIDATION_REQUIRED 为人工验证要求、retryable=false，提供经过契约约束的 Google 验证链接；不是自动绕过验证，也不是把普通 403 当 TOS。 |

当前实现：[解析和恢复时间](https://github.com/pingdotgg/t3code/blob/44a533378653164dea96435e23c8ea27efaffedb/apps/server/src/provider/acp/AntigravityTurnOutcome.ts#L20-L151)、[验证与 404 分类 L243–276](https://github.com/pingdotgg/t3code/blob/44a533378653164dea96435e23c8ea27efaffedb/apps/server/src/provider/acp/AntigravityTurnOutcome.ts#L243-L276)、[retired 时间锚 L331–352](https://github.com/pingdotgg/t3code/blob/44a533378653164dea96435e23c8ea27efaffedb/apps/server/src/provider/acp/AntigravityTurnOutcome.ts#L331-L352)。

**对本仓**：0.2.18 已选择性同步数字状态/验证要求/Resets in 等方向，不能包装成下一版新功能。T3 的 `retryable` 是错误数据，不等于无限自动重发；尤其不能将“模型已回答后 404”扩大为所有 404 自动恢复。外部验证 URL 必须守白名单；不要移除本地额外的 TOS 持久硬停止。

## 3. 后台命令、steering、子 agent 的生命周期

| 已合并 PR / 新加坡时间 | 实际更新与边界 |
|---|---|
| [#39165](https://github.com/pingdotgg/t3code/pull/39165/files) · 11-20 00:20 | agy 1.5+ 的中途 steering 使用新的 session/prompt，不先 cancel-and-restart，避免取消正在运行的原生命令/子 agent。它是窗口内较早变更，不是 11/27 刚加。 |
| [#39767](https://github.com/pingdotgg/t3code/pull/39767/files) · 11-20 23:31 | 放开“无初始 prompt 的 wake run”steer，正确开启 prompt-dispatched/inactivity 计时；是 #39165 的后续补全。 |
| [#39806](https://github.com/pingdotgg/t3code/pull/39806/files) · 11-21 00:57 | 原生 scheduled wake 仍运行时保留 run，不把 prompt 结束误当后台任务完成。 |
| [#39989](https://github.com/pingdotgg/t3code/pull/39989/files) · 11-21 14:03 | 本地 inbox/transcript 还有待处理高优先级 wake/reply 时延迟 finalize，避免多后台结果只显示第一个；只读、有限量文件检查，不是网络 keepalive。 |
| [#40858](https://github.com/pingdotgg/t3code/pull/40858/files) · 11-23 00:23 | 给已结束 prompt 后仍等非 daemon 原生命令的**静默 hold** 设置 30 分钟界限；排除 schedule，其他待处理后台工作仍可持有 turn。不是给所有聊天/工具统一设 30 分钟，也不是主动发 probe。 |
| [#39519](https://github.com/pingdotgg/t3code/pull/39519/files) · 11-20 12:33 | 识别原生已被 killed 的子 agent 状态，不再让父 run 永远 Running。 |
| [#42649](https://github.com/pingdotgg/t3code/pull/42649/files) · 11-25 14:12 | 原生 `/swarm` worker 纳入子 agent 工作显示。 |
| [#43491](https://github.com/pingdotgg/t3code/pull/43491/files) · 11-26 22:20 | 将原生子 agent 的 thinking、工具与回复投影到正常子线程时间线，Idle 后保留内容；跟随本地 transcript，并有有界末尾补读，避免 send_message 后稍晚落盘的最终回答丢失。 |

当前证据：[adapter 后台边界 L249–269](https://github.com/pingdotgg/t3code/blob/44a533378653164dea96435e23c8ea27efaffedb/apps/server/src/orchestration-v2/Adapters/AntigravityAdapterV2.ts#L249-L269)、[子 agent transcript 与 pending reply 入口 L315–350](https://github.com/pingdotgg/t3code/blob/44a533378653164dea96435e23c8ea27efaffedb/apps/server/src/orchestration-v2/Adapters/AntigravityAdapterV2.ts#L315-L350)。

**对本仓**：T3 原生子 agent/后台命令与本地外部工具桥的“长工具结果补交”不是同一种执行模型；保留取消/串行化原则，但不宜直接复制 native inbox 扫描、30 分钟 hold 或子 agent UI 投影。只有明确发现对应事件丢失/悬挂才能窄修，不应为了“跟齐”扩大本地读取与轮询范围。

## 4. 模型目录与 thinking level 不互相污染

| 已合并 PR / 新加坡时间 | 实际更新与边界 |
|---|---|
| [#39720](https://github.com/pingdotgg/t3code/pull/39720/files) · 11-20 22:21 | 辅助文本生成采用用户已保存且当前模型支持的 thinking level；若 CLI 拒绝无效参数，不把它扩展成任意重新生成策略。 |
| [#41699](https://github.com/pingdotgg/t3code/pull/41699/files) · 11-24 07:18 | 未观测模型不再借用当前另一模型的 thinking choices/default，重启后保持各模型自己的缓存能力。 |
| [#42931](https://github.com/pingdotgg/t3code/pull/42931/files) · 11-26 00:55 | 活会话选择、模型切换、session/resume 中的自选 thinking level 不再覆盖目录默认；把 catalog probe 与非权威会话更新分开，同时避免相同事件反复发布快照。 |
| [#39378](https://github.com/pingdotgg/t3code/pull/39378/files) · 11-20 09:23 | 会话确实 advertise Auto 时使用 agy 自身 Auto，未 advertise 则 default；保留需要人工审批的升级请求，权限不能超过线程上限。 |
| [#40154](https://github.com/pingdotgg/t3code/pull/40154/files) · 11-22 15:18 | 已观测 Auto 能力跨重启保留，不让 picker 丢失该选项。 |

当前证据：[默认和实时 thinking 合并](https://github.com/pingdotgg/t3code/blob/44a533378653164dea96435e23c8ea27efaffedb/apps/server/src/provider/AntigravityProvider.ts#L62-L150)、[目录与实时更新区分](https://github.com/pingdotgg/t3code/blob/44a533378653164dea96435e23c8ea27efaffedb/apps/server/src/provider/AntigravityProvider.ts#L406-L487)。

**对本仓**：最值得审查“模型目录默认值”与“会话本轮选择”是否分离，但不要因为都叫 thinking 就复制 T3 的 registry/cache 数据结构。T3 Auto/native approval 不是本地工具代理的同等权限界面，不能直接自动放权。

## 5. token/历史/成本（不是恢复额度查询）

| 已合并 PR / 新加坡时间 | 实际更新与边界 |
|---|---|
| [#39686](https://github.com/pingdotgg/t3code/pull/39686/files) · 11-20 20:33 | agy 1.5+ outputTokens 已包括 thoughtTokens，去掉再次相加；inputTokens 仍按其语义补 cachedReadTokens。reasoning 是 output 子集，不是另一份输出。 |
| [#39435](https://github.com/pingdotgg/t3code/pull/39435/files) · 11-20 08:07 | 跳过 agy index 数据库，不将它们误作会话造成 partial-history 错误。 |
| [#41155](https://github.com/pingdotgg/t3code/pull/41155/files) · 11-23 09:59 | 默认实例即使未标 configured 也扫描其 T3 profile 的本地历史。 |
| [#40352](https://github.com/pingdotgg/t3code/pull/40352/files) · 11-21 22:22 | Orchestrator 变体映射基础模型估算费率，避免无价。 |
| [#43097](https://github.com/pingdotgg/t3code/pull/43097/files) · 11-26 06:07 | 同一模型以 bare ID 和带 effort 名称出现时不再被当作冲突而丢失价格；补充 Carbon/Hydrogen/Neon/Orchestrator ID 和变体映射。未改动未经真实数据库证实的 idx 关联假说。 |
| [#43526](https://github.com/pingdotgg/t3code/pull/43526/files) · 11-26 22:14 | 扫描 T3 保留的已删除/改名实例 profile，历史 token 统计不会随设置项删除而消失；这是本地历史汇总。 |
| [#39897](https://github.com/pingdotgg/t3code/pull/39897/files) · 11-21 05:25 | T3 token analytics 用厂商目录确认新模型/别名，而不是仅靠内置 manifest；这是 T3 自身标签统计，不是 Google 新增遥测。 |

当前证据：[价格及名称归一 L83–204](https://github.com/pingdotgg/t3code/blob/44a533378653164dea96435e23c8ea27efaffedb/apps/server/src/provider/Drivers/antigravityUsageReader.ts#L83-L204)、[保留所有 profile 历史 L60–107](https://github.com/pingdotgg/t3code/blob/44a533378653164dea96435e23c8ea27efaffedb/apps/server/src/provider/Drivers/AntigravityUsage.ts#L60-L107)。#39686 最终补丁实际落在共享 ACP adapter，但改动由 Antigravity 1.5+ 用量语义触发，故仅在此说明专属语义。

**对本仓**：优先核实 token 计量是否已正确去重，而不是直接照搬费率表。T3 成本显示是本地估计，不是 Google 账单或订阅余额。删除在线额度不影响本地 token 历史，也不要求本地桥必须实现已删除账号全历史扫描。

## 6. skills、附件与展示

这些变更主要减少界面缺项或错误投影，与调用身份/封禁没有已证实关系：

- [#43588](https://github.com/pingdotgg/t3code/pull/43588/files)，**11-27 00:05**：读取插件 `plugin.json` 的 skills 路径、manifest 优先级；跳过 agy 自己不会加载的无效插件。是这批最晚的 agy 专属 merge。
- [#39765](https://github.com/pingdotgg/t3code/pull/39765/files)、[#40020](https://github.com/pingdotgg/t3code/pull/40020/files)、[#41774](https://github.com/pingdotgg/t3code/pull/41774/files)、[#42971](https://github.com/pingdotgg/t3code/pull/42971/files)：skills.json、文件路径、目录 filters、根 SKILL.md 下子技能发现；加上 YAML/null/大小写/插件名称等一组兼容修复。
- [#39456](https://github.com/pingdotgg/t3code/pull/39456/files)、[#39097](https://github.com/pingdotgg/t3code/pull/39097/files)、[#42594](https://github.com/pingdotgg/t3code/pull/42594/files)：UTF-16 BOM、MIME 参数、无法解码附件回退为路径。
- [#41923](https://github.com/pingdotgg/t3code/pull/41923/files)、[#41978](https://github.com/pingdotgg/t3code/pull/41978/files)：原生 update_steps 变任务清单，避免工具自己的参数被误识别为 T3 MCP 调用。
- #43258 ask_question 卡片与其他通用 elicitation 修复由主线程统一说明，不在本报告重复展开。

## 7. 临时 setup/model-probe/text-helper 会话的持久文件清理

[#39275](https://github.com/pingdotgg/t3code/pull/39275/files) **11-20 04:23** 已合并，修正 agy 1.5 不写旧 `.meta` sidecar 后临时会话无法清理的问题。最终 patch 在进程结束后只读数据库 `trajectory_metadata_blob`，核对 session ID、每个 workspace URI 均属该临时 cwd、路径无链接；证明归属后才移除 db/wal/shm/journal、brain 及 annotations。已有 `.meta` 指向其他 cwd、多个工作目录、损坏或不可解码记录均不删。不是按文件年龄批量清理用户历史。

**本仓审查候选**：当前 probe 能关闭会话/停止进程并删除临时 cwd，但主线程静态核对未见其清理 profile 下持久会话 DB；尚无本轮实机复现，不能直接断言泄漏。可先用隔离模拟元数据验证清理边界，不要贸然删除真实 profile 的文件。

## 8. 主机睡眠与握手超时

- [#39395](https://github.com/pingdotgg/t3code/pull/39395/files) **11-20 07:36** 已合并：prompt inactivity 改成最多 60 秒一片计时，实际片段比请求时长多超过 10 秒视为疑似 sleep/时钟跃迁，重置静默窗口；仍保留清醒期间 15 分钟无进展的处理。它是时间测量修复，不是无限延长真实卡死的会话，也不是 OS 原生 sleep 事件的精确证明。
- [#40864](https://github.com/pingdotgg/t3code/pull/40864/files) **11-22 22:41** 已合并：initialize、首次 new/resume 各有 90 秒上限；authenticate 不套这一限制，且上层重试可能使整体更长，不能说全过程最多 90 秒。此项最终 patch 由主线程核对。

**本仓已有整体握手 60 秒与 probe 30 秒超时**，不能声称没有超时。睡眠感知是下一轮可靠性审查候选，不需照搬 T3 的固定分钟数；资源取消和进程收敛仍须单独验证。

## 9. 会话恢复、能力声明与迟到事件（含共享 ACP 补充）

| 已合并 PR / 新加坡时间 | 对 agy 的作用和限制 |
|---|---|
| [#37020](https://github.com/pingdotgg/t3code/pull/37020/files) · 11-20 03:45 | 当前会话确实 advertise compact 时才发送裸 `/compact`；不支持时在发 prompt 前拒绝，不将它变成普通模型输入。 |
| [#39422](https://github.com/pingdotgg/t3code/pull/39422/files) · 11-20 07:41 | worktree handoff 释放会话时，将遗留运行工具标为 interrupted，避免 UI 永久 Waiting；不是重放工具。 |
| [#41652](https://github.com/pingdotgg/t3code/pull/41652/files) · 11-24 08:34 | 对模型拒绝/不支持 compact 且 prompt 尚未发送的拒绝置 refusedBeforePrompt，保留原生会话；不是保留所有失败或 TOS 后继续发送。 |
| [#40328](https://github.com/pingdotgg/t3code/pull/40328/files) · 11-21 21:28 | `_meta.isReplay` 只进入历史，不被当成新工具/后台工作启动信号。 |
| [#40220](https://github.com/pingdotgg/t3code/pull/40220/files) · 11-21 16:41 | turn 结束后到达的 context usage/session info 保存为 session 级信息，不丢计量/上下文显示。 |
| [#40629](https://github.com/pingdotgg/t3code/pull/40629/files) · 11-22 08:10 | 上述迟到信息不把 idle 会话重新变成 active run。 |
| [#43046](https://github.com/pingdotgg/t3code/pull/43046/files) · 11-26 05:31 | Auto-accept edits 仅自动批准可确认位于线程目录内的改动，其余询问；并非所有文件写入全放行。 |
| [#43258](https://github.com/pingdotgg/t3code/pull/43258/files) · 11-26 12:50 | agy ask_question 的 schema.title 作为问题正文，避免丢题目。 |
| [#43233](https://github.com/pingdotgg/t3code/pull/43233/files)、[#43251](https://github.com/pingdotgg/t3code/pull/43251/files)、[#43380](https://github.com/pingdotgg/t3code/pull/43380/files) · 11-26 11:43 / 12:51 / 18:34 | `_other`/`__other` 附加回答字段合并；可选数字/boolean/choice 可留空，必填不满足则取消，不伪造用户选择。 |

这些共享 ACP 项的最终 patch 由主线程检查，缓存于 `.sandbox/t3-extra-20261127/`；本报告不把其所有实现机械映射成本地自研 ACP bridge。

## 对本仓的优先级

1. **优先窄查**：模型在 prompt 前被拒绝是否无谓销毁可复用会话、临时 probe 持久文件归属清理、睡眠后的静默超时、迟到相对 reset 的时间锚、目录默认与会话 thinking 隔离。主线程已静态看到本地模型设置失败可走 drop/stop，但尚未复现，不在本报告断言确定 bug。它们是可靠性/资源边界候选，不是防封声明。
2. **已做的不要再称新增**：内部 HTTP 移除、常见状态/验证/Resets in 支持、auto-update=`true` 已有对应本地处理（本地尊重用户显式覆盖）。主线程静态核实 `promptUsage` 使用 `Math.max(output, thinking)` 且已有 settlement 防双计测试，因此不能说当前本地仍重复相加；具体覆盖以本轮测试与代码为准。
3. **不直接搬**：T3 原生 Auto 权限、后台子 agent 读盘、UI transcript、整套受管安装器/skills discovery、全历史成本扫描。两者产品边界不同。
4. **本次没有发现 main 最近 6 个提交新增 agy 调用变化**；无需因全仓 main 更新就宣称 agy 必须再次追版本。


方法补充：按新加坡日期补查 UTC 11/19 16:00 之后的 PR，因此 #39165/#39275/#39395 等虽 API 日期为 11/19，表内属于 11/20。#38957 的旧额度凭据读取后来被 #43026 删除，不列为当前待同步功能。缓存目录 `.sandbox/t3-updates-20261127/` 包含 API 状态、最终 patch 与固定 SHA 当前源码。
