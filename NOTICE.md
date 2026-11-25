# NOTICE：来源与合规说明

## 独立仓库说明

本仓库为 `DJB-Developer/agy-cli`，基于 `magpie-community/plugins` 的
`packages/agy-cli`（提交 `09c05dfa9f3f6fc89d2d172faf475bbeed70f3c4`）。
新增 refresh token 导入账号、钥匙串验证与失败恢复，以及相关测试和文档。
0.2.6 另行同步社区 agy-cli 0.1.43–0.1.48 的六个提交：
`5613a1259a5a1aff1b75b0facb9a8006784be27f`、
`dac97267369a40e45980a7da04b424ebe231581f`、
`6e0cecb2a0bcaa3bb041a033baab1e333ca55df4`、
`6646797e15da35c041332c58326432b862bdd225`、
`3db6dcfa8587600f8f10d34bbb8b77de3304da98`、
`a617ecfd4224def48a5975e18224495968971781`。
这些修复适配到本仓的账号独立运行时，保留本仓登录、额度、套餐及界面配置功能。
0.2.7 同步 `1c3c58be56ebdbcdac38a30e6f733e125573ab04`（社区 agy-cli 0.1.49），
保存会话按实际发送的提示词校验，保留本仓各账号目录和精简 Agent 模式隔离。
0.2.14 选择性同步以下 MIT 上游修复，均适配到本仓账号独立运行时：
- `491cea357d2289c8250d8b1fd281ffcadb746693`：`run_command.toolSummary` 兼容及测试（@andrew-zyf、@yetone；社区 0.1.63 发布）。
- `e4c825b5544d99a688d92ed32e688ae5f768e731`：仅模型目录 fallback 标记和相关测试，不同步单账号替换登录（@yetone）。
- `84c2a4794981d55f367cb75cf6c9196e1639e9c3`：请求拒绝的显式 400，保留本仓 403/TOS 错误字段和停用逻辑（@yetone）。
0.2.15 的 `turn-outcome.mjs` 参考并改编自 `pingdotgg/t3code` 提交
`0b489dada1f00db39c99074239c09c006f223aee` 的
`apps/server/src/provider/acp/AntigravityTurnOutcome.ts`、`AntigravityProfilePaths.ts` 及其测试：
仅检查本轮最后的错误步骤、读取恢复提示、验证会话文件身份。
上游为 MIT，Copyright (c) 2026 T3 Tools Inc.；许可正文与版权保留于 LICENSE。
本仓适配 CLI 的 `antigravity-cli/conversations` 路径、Bun/Node 只读 SQLite、多账号封禁和 Magpie 错误协议，0.2.15 当时未采用 T3 Code 的 HTTP 额度查询。
当前 HTTP 额度改造参考 `pingdotgg/t3code@634ee43deb6d5fc0feae77153d33df1e97ffb303`
的 `apps/server/src/provider/antigravityUsageLimits.ts`（MIT，Copyright (c) 2026 T3 Tools Inc.）。
适配到 Magpie 的精确模型组路由、账号隔离和明确封禁检测；不复制其固定 Hub 身份或旧 ACP token 刷新分支。
本仓不因参考该实现而声称获得 Google 对模型网关用途的授权。
下文保留上游的历史来源记录；其中包名、版本和仓库描述属于上游记录。

本包（`@magpie-community/opencode-agy-cli-auth`，版本 0.1.0）源自 Antigravity 桥接插件
`opencode-antigravity-bridge`，由 gitxm 整理为 `gitxm/yce-magpie-agy` 后提交到
magpie-community/plugins（plugins#785），以 MIT 协议发布。**与上游无隶属关系。** 上游版权声明原样保留在 [LICENSE](LICENSE)，
本仓新增部分的版权归 gitxm 与 yce。

## 1. 包与标识

| 项目 | 取值 |
|---|---|
| npm 包名 | `@magpie-community/opencode-agy-cli-auth` |
| 版本 | `0.1.0` |
| 仓库 | `https://github.com/magpie-community/plugins`（`packages/agy-cli`） |
| Magpie provider ID | `agy-cli` |
| 安装 | `magpie plugin add @magpie-community/opencode-agy-cli-auth` |
| 原始仓库 | `https://github.com/gitxm/yce-magpie-agy`（包名 `@magpie-community/yce-magpie-agy`、provider ID `yce-magpie-agy`，均未发布到 npm） |

进程内部标识保持不变，以免影响已有的状态文件与日志：`AGY_BRIDGE_*` 环境变量、
`magpie-agy-bridge/` 状态与临时目录、`[agy-bridge]` 日志前缀、导出名 `AntigravityBridgePlugin`。

## 2. 来源基线

| 基线 | 版本指纹 | 说明 |
|---|---|---|
| 上游主干 | `DylanLIiii/opencode-antigravity-bridge@7e13b127a62e8eaa41d8de2d3eedd8afe1cfd4eb` | 上游 main 的 HEAD |
| PR #8 基线（代码底稿） | `gitxm/opencode-antigravity-bridge@acb8d84c5136d18889d7d4b91f119117b57abb74` | 分支 `fix/windows-bg-updater-popup`，父提交为上游 `7e13b12`；包含 `platform.mjs`、Windows 无弹窗修复与多步用量结算 |
| 本机补丁（`index.mjs`） | `index.mjs.patched`，md5 `38aa8d42f3e76a2536d11be63b5807a5` | 基于上游 `212179f` 的本机补丁版 |
| 本机补丁（`usage.mjs`） | `usage.mjs.patched`，md5 `df212a2c934ffd4a38d7f3ef95271c5d` | 基于上游 `7e13b12` 的本机补丁版 |

合并原则：代码以 PR #8（`acb8d84`）为底。本机补丁中 `acb8d84` 没有的修复，按下面的
A1–A16、U1–U6 逐项并入。两边都有、且 `acb8d84` 写法更新的部分（多步用量结算、
`requestedEffort`、`withStateLock`、`lineageVerdict`、`matchToolResults`、`inspectToolTurn`
等）保留 `acb8d84` 的实现，不搬运补丁版代码。

## 3. `index.mjs` 并入的修复（A1–A16）

| 编号 | 内容 |
|---|---|
| A1 | 模型目录缓存：TTL 5 分钟；首次最多等 500 ms，超时先返回旧目录，后台单飞刷新；刷新失败保留上次成功结果；启动时先用 `FALLBACK_MODELS` 预热。`provider.models()` 不再每次强制执行 `agy models` |
| A2 | `listAgyModels` 在报错、超时、退出码非 0 或输出为空时返回 `null`，不再用兜底列表覆盖动态目录 |
| A3 | `execOnce` 超时立即 resolve（带 `timedOut`），子孙进程占着管道也不会挂起；后台刷新路径的计时器 `unref()`，前台调用保持 ref |
| A4 | 为 `gpt-oss-120b` 补充指向 medium 的裸名别名 |
| A5 | `modelLimits(id)`：`provider.models()` 输出每个型号的 `limit`（上下文与输出上限），与 `capabilities` 并存 |
| A6 | `findAgy` 缓存键包含 `AGY_PATH`、`PATH`/`Path`、`LOCALAPPDATA` 与 home 目录，环境变化时重新查找 |
| A7 | 无进展重复上限：同一无进展回合连续收到对不上的工具结果，前两次返回 409，第三次强制回收并重放；重放不了则返回终止性 400。`recoverStaleTurn` 区分 active、conflict、incomplete、replayed、fallthrough 五种情况 |
| A8 | `jsonError(status, message, code, { extra, headers, noRetry })`，支持把 `extra` 并入 error 对象（A7 依赖它） |
| A9 | 工具调用 30 ms 合批：相邻事件循环里到达的 MCP 调用合并到同一次响应；`Turn.next` 带等待者清理；按 `emittedIds` 去重；文本与结束事件的边界不合并 |
| A10 | `canonicalBody` 只提取开头连续的 `role=system` 消息（沿用上游 `acb8d84` 规则），保证 Claude Code 尾随的 system 通知不会触发第二轮重建会话；同时并入 `contentText`、`requestLayout`、`noteLayout` 布局追踪 |
| A11 | 诊断事件限流（60 秒窗口最多 30 条，附 `suppressed` 计数）；请求级 `req_id`；冲突事件输出 `idle_ms` 与 `pending`；过期原因细分为 finalized、dead、done、running；`layout_flip` 只在 `AGY_BRIDGE_EVENTS=verbose` 时输出 |
| A12 | `Turn.rawAcpUsages` 保存每个已记账 prompt 的原始 ACP usage 对象 |
| A13 | `addUsage` 通过 `tokenCount` 把累加结果限制为非负整数 |
| A14 | `reclaimStaleTurn` 同时清除该会话的无进展重复计数 |
| A15 | 防止 503 进程池饿死：并发上限默认值由 8 改为 16（`AGY_BRIDGE_MAX_PROCS`，`magpie.maxConcurrency` 同为 16）。`evictLRU` 分两级淘汰，第二级淘汰客户端已断开超过 30 秒（`AGY_BRIDGE_DETACHED_EVICT_MS`）的挂起工具回合，之后补交的合法 `tool_result` 会在新进程上重放。`acquireProcLocked` 遇到同会话旧回合时先判断过期并回收。历史压缩后变短的新请求判为 fork，回收旧回合 |
| A16 | 长历史重放预算：`renderInitialPromptParts` 默认限制在 112 KiB（`AGY_BRIDGE_MAX_PROMPT_BYTES`）内。先为必保段预留预算（system 说明、`</conversation_history>` 闭合标签及禁止输出工具调用声明的文字、完整的 `<current_turn>`），历史按头尾保留，超长的 `[tool result]` 保留首尾、省略中间，保证不被 agy 的 128 KiB 尾部截断切掉 |

## 4. `usage.mjs` 并入的修复（U1–U6）

| 编号 | 内容 |
|---|---|
| U1 | 去掉 win32 上直接报错 `agy bridge usage queries currently require macOS or Linux.` 的限制；接入 `agySpawnSpec`，兼容 `.cmd` 与 `.bat`，使 Windows 上的 `magpie quota` 可用 |
| U2 | `spawn` 只在非 Windows 上使用 `detached`，Windows 上一律 `windowsHide: true` |
| U3 | Windows 进程树清理：先执行 `taskkill /T /F /PID` 清除进程树，只有 `taskkill` 失败或超时才补 `SIGKILL`，避免提前杀掉父进程导致 `taskkill` 漏杀子树。父进程正常退出后延迟 30 ms 再清理进程树；`finish()` 只在出错或子进程仍在运行时清理 |
| U4 | Windows 上拦截浏览器启动：写入内容为 `@exit /b 1` 的 `open.cmd`，并让 `BROWSER` 指向它 |
| U5 | PATH 大小写去重：删除非大写的 `Path` 键，继承 `env.PATH`，没有时回落到 `env.Path` |
| U6 | 临时目录删除遇到 `EBUSY`、`EPERM`、`ENOTEMPTY` 时，先等待在途的 `taskkill` 释放目录句柄，再最多重试 4 次，每次间隔递增 50 ms |

## 5. 包与文档层改动

- 包名改为 `@magpie-community/opencode-agy-cli-auth`，版本 `0.1.0`，`repository` 指向 magpie-community/plugins 的 `packages/agy-cli`。
- `magpie.maxConcurrency` 与 `AGY_BRIDGE_MAX_PROCS` 默认值统一为 16。
- `README.md`、`README.en.md` 整篇重写，`LICENSE` 追加本仓版权行。原仓库的 `HANDOFF.md` 不随包发布。
- `NOTICE.md`（本文件）与 `LICENSE` 一并随包发布。

## 6. 版权

[LICENSE](LICENSE) 保留上游版权行 `Copyright (c) 2026 DylanLIiii`，并依次列出
`Copyright (c) 2026 gitxm` 与 `Copyright (c) 2026 yce`。MIT 正文未作修改。

## 7. 从旧版迁移

旧版是包名 `magpie-agy` 0.2.0，provider ID 为 `antigravity-bridge`。改为 0.1.0 后：

1. **provider ID 变化**：Magpie 中的 provider 变为 `agy-cli`。所有写着旧 ID 的模型名
   （`antigravity-bridge/<模型>`，或从 GitHub 安装 `gitxm/yce-magpie-agy` 时的 `yce-magpie-agy/<模型>`）
   都要改成 `agy-cli/<模型>`，包括路由组和会话里的模型引用。
2. **登录态**：登录状态按 provider ID 记录。切换后需要在新 provider 上重新登录，或者把登录记录改名。
3. **内部状态不变**：会话停车文件仍在 `magpie-agy-bridge/sessions.json`，已有会话可以续接。
4. **切换顺序**：先安装新包，确认新 provider 能返回 200，再逐个改模型名；旧包最后移除。
   本仓内不执行切换操作。
## 8. 独立仓库多账号实现（0.2.0）

多账号的 `--gemini_dir` 目录与 `WSL_INTEROP` 文件凭据模式参考了
[DylanLIiii/opencode-antigravity-bridge](https://github.com/DylanLIiii/opencode-antigravity-bridge)
的 MIT 实现；Magpie 的按账号 `getAuth` / `context.auth` 接入方式也参考了
[antigravity 插件](https://github.com/magpie-community/plugins/tree/main/packages/antigravity)。
本仓采用每个账号独立运行时隔离进程、工具调用、模型缓存和会话状态，保留原默认账号。

## 9. HTTP 套餐与额度查询（0.2.8）

元数据接口、端点回退顺序与分组配额格式参考
[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI/tree/905e70c48b47b7a1cb4a27dd3abc901e2cdd1e4a)
及其 [Management Center](https://github.com/router-for-me/Cli-Proxy-API-Management-Center/tree/3d893ec88938c3ceef200a15be6af8cf972564b3)。
本仓独立实现 HTTP 查询、超时和错误脱敏，继续复用自身模型组路由；未引入其聊天执行器或 OAuth 续期实现。
0.2.8 中 CLI `/usage` 仅用于需要新 access token 时的续期；0.2.9 恢复每次额度刷新均通过 CLI。
0.2.9 移除 HTTP 配额模块及固定 Hub User-Agent，保留 HTTP 套餐查询与套餐 ID 映射；原 U1–U6 的跨平台进程处理继续用于 CLI 额度查询。


## 10. 服务停用识别（0.2.10）

错误信号参考 [CLIProxyAPI 的 TOS 检测](https://github.com/router-for-me/CLIProxyAPI/blob/e96d4c4818851cf0e96d27b2bc8b67379e449d9e/internal/runtime/executor/antigravity_executor_credits.go)：
只将明确的账号服务停用信号作为持久状态，不把普通 403 等同封禁。本仓独立实现 CLI 错误解析、
按账号持久化和 Magpie 错误上报；未引入 HTTP 聊天执行器、OAuth 续期或跨账号重试循环。


## 11. 上游 0.1.50–0.1.51（本仓 0.2.11）

同步 magpie-community/plugins（MIT）的两项提交：

- [9126c46f97fc5e20b12b416e4aec0b98cb712624](https://github.com/magpie-community/plugins/commit/9126c46f97fc5e20b12b416e4aec0b98cb712624)：工具描述预算及回归测试。
- [4a64252bd7c85c9fd94a38e5ff0ee82166606352](https://github.com/magpie-community/plugins/commit/4a64252bd7c85c9fd94a38e5ff0ee82166606352)：多模型开场并发、锁内开始回合及回归测试。

作者 @yetone。本仓适配到每账号运行时，保留服务停用检查；另补并发次级进程的同模型重复请求保护、
双账号双模型工具回传隔离测试。未更换聊天传输或元数据查询方式。

## 12. 2026-11-25 选择性同步（未发布）

参考 magpie-community/plugins 的 MIT 实现，固定基线
[`bbd3a2e76d7f2e765f0181786a60169b7acf860a`](https://github.com/magpie-community/plugins/tree/bbd3a2e76d7f2e765f0181786a60169b7acf860a/packages/agy-cli)：

- `9720caa468a509e3063c3c96eabe59a817a93e5b`、`83a677177bc3ec8e72f2de24a81259749fa9fa6d`：原生封禁/验证结束提示与禁止重试标记。
- `c18d87f7439cb9a62bbd93e338e7d06c428c1ade`、`8b47ce71a73d7bdc216c82d6a2f7abe407c12fdc`：繁忙/额度结束提示。繁忙提示逻辑上游注明源自 ifccod（MIT）。
- `22fd1770a5c0bdd222aae5ab99f7d3ac4a16a351`、`28e0a3ea2a5dc394f20deebe2ac2331a28136f8c`：home/祖先目录不传入 add-dir、按调用方目录区分会话；适配本地运行时与测试。
- `bbd3a2e76d7f2e765f0181786a60169b7acf860a`：所有工具的 toolSummary 去重与补回。

原作者及贡献者包括 @yetone、@yetihan、@oli-bot、@ifccod；保留仓库 LICENSE 中的 MIT 版权及许可。

`turn-outcome.mjs` 的错误格式、JSON 对象提取、验证拒绝及文字恢复时间参考
[`pingdotgg/t3code@072611f65fc3b77f13909ce451e87c3e265d8b05` 的 AntigravityTurnOutcome.ts](https://github.com/pingdotgg/t3code/blob/072611f65fc3b77f13909ce451e87c3e265d8b05/apps/server/src/provider/acp/AntigravityTurnOutcome.ts)
（MIT，Copyright (c) 2026 T3 Tools Inc.，许可见本文件前述 T3 条目）。
本仓保留严格时间校验和按账号持久封禁；不复制身份回退、OAuth 后台续期、直接聊天 HTTP 或自动重放。
