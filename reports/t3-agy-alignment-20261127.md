# T3 agy 最新对齐研究：PR #43026 / #43087（2026-11-27）

## 核对范围

- GitHub API 于本轮查询返回 main **`a77493caa565ae4e8c12ffb6721e37b3a2c6c06c`**，提交时间 2026-11-27 01:56:11（Asia/Singapore），后文源码链接固定于此 SHA，不使用浮动 main 作为实现证据。
- 增量基线为前轮 **`2cc5253241fb4d6d816aaefd94fb170ae383ad1b`**。compare 返回 167 个提交、文件列表达 300 上限；另核对 provider 目录、AntigravityAdapterV2 和 AcpSessionRuntime 路径提交历史，未把截断 compare 当作全仓无遗漏证明。
- 本地研究时 HEAD：`b42f976116d4b22f1f705dcf8327330877f97d5c`。主线程可能继续修改/测试，本报告不宣称已验证最终实现。只读公开源码和本仓文件；未运行 agy、未读实际凭据、未发模型请求、未提交。
- 用户已明确要求暂时保留当前 `t3-code` clientInfo；因此本轮只对齐其他行为。**这是有意保留的差异，不是 #43087“真实自身身份”原则的完整对齐，也不构成上游授权或防封保证。**

## PR 状态（以 GitHub API 为准）

| PR | 本轮 API 状态 | 合并 SHA / 时间（新加坡） | PR head SHA |
|---|---|---|---|
| [#43026](https://github.com/pingdotgg/t3code/pull/43026) | closed、merged=true | `96423cb5e2614eeb7a033cc7b755795d88a9158a` / 11-26 03:25:43 | `ab78a780195ff18b0db5b47297a0db9f0b718deb` |
| [#43087](https://github.com/pingdotgg/t3code/pull/43087) | closed、merged=true | `5e37e6db563e0cb45d5f975241c923440397411c` / 11-26 23:42:39 | `4bfea1fa027789f4b62c9269f5ecbebdb6704a49` |

搜索引擎/页面缓存可能仍显示 #43087 open，不能据此覆盖 API 的 merged 状态。API 来源：[43026](https://api.github.com/repos/pingdotgg/t3code/pulls/43026)、[43087](https://api.github.com/repos/pingdotgg/t3code/pulls/43087)、[main commit](https://api.github.com/repos/pingdotgg/t3code/commits/a77493caa565ae4e8c12ffb6721e37b3a2c6c06c)。

## 1. #43026：本仓 0.2.18 已完成核心方向

上游删除 Google 内部额度请求、相应 OAuth/keyring 读取和 hub quota reader，保留本地会话历史 token 计量。维护者转述 Google 要求外部客户端走 ACP，并警告内部 API 可能标记账号。它不证明任何用户的具体停用原因。[PR 正文与补丁](https://github.com/pingdotgg/t3code/pull/43026/files)

本仓 0.2.18 已删除 quota/plan HTTP 和旧 CLI usage fallback，并保留本地 TOS 状态；本轮应维持零供应商元数据请求的回归，不恢复已删除功能。不能把本地 token 历史与在线订阅额度混为一谈。

## 2. #43087 的准确含义：自己的身份，不是让所有客户端叫 T3

旧 T3 在 1.5.0 / 未知运行时版本发送 zed 身份。该 PR 移除分支，固定 T3 自身 `{ name: "t3-code", title: "T3 Code", version: packageJson.version }`，同时去掉仅用于挑身份的 runtimeVersion 输入。[当前 runtime 源码 L111–127](https://github.com/pingdotgg/t3code/blob/a77493caa565ae4e8c12ffb6721e37b3a2c6c06c/apps/server/src/provider/acp/AntigravityAcpSupport.ts#L111-L127)

**适用原则**是按实际产品标识自身；不是其他插件复制 T3 的 name/version。按用户本轮明确选择，研究不修改当前本地 t3-code 字段；文档和交付说明应如实标注这项未对齐，不能称“已完整同步 #43087”或“已获得 T3/Google 身份许可”。

最终 PR 文件补丁未修改 model manifest；实际变更是 ACP support/Driver 的门槛和身份、Auth 安全错误透传、Installation 的输入删除、对应测试和文档。以最终 diff 为准，不依据旧 PR 描述或缓存推断新增 manifest 策略。[最终文件清单](https://api.github.com/repos/pingdotgg/t3code/pulls/43087/files)

## 3. 版本门槛与精确 parser 行为

当前源码使用 `^(?:v|agy_acp_server_)?(\d+)\.(\d+)\.(\d+)`，先 trim，仅取三个数字。不是完整 SemVer 解析，不解析 prerelease 优先级，也不校验整串结尾。`OPEN_MODEL_ACCESS_RELEASE=[1,5,1]`；无法解析时 gate 返回 true。[源码 L60–88](https://github.com/pingdotgg/t3code/blob/a77493caa565ae4e8c12ffb6721e37b3a2c6c06c/apps/server/src/provider/acp/AntigravityAcpSupport.ts#L60-L88)

| 输入 | #43087 的 model-access gate 行为 |
|---|---|
| `1.5.0` / `v1.5.0` / `agy_acp_server_1.5.0` | 拒绝 |
| `1.4.12` | 本 gate 拒绝；Driver 的已有 broken-version 检查可更早拒绝 |
| `1.5.1` / `agy_acp_server_1.5.12` | 允许 |
| `1.5.0-rc.1` | 比较为 1.5.0，拒绝 |
| `1.5.1-rc.1` / `1.5.1+build` | 比较为 1.5.1，本 gate 允许 |
| `custom` / `unknown` / `1.5` | 不可解析，本 gate 允许 |
| 缺失/空 version | Driver 不运行版本拒绝检查 |

前三类前缀和 custom 的行为有上游单测；预发行/尾缀结论来自正则及数值比较的静态推导，不冒充上游已测用例。[上游测试 L61–72](https://github.com/pingdotgg/t3code/blob/a77493caa565ae4e8c12ffb6721e37b3a2c6c06c/apps/server/src/provider/acp/AntigravityAcpSupport.test.ts#L61-L72)

注意：这只是新增 gate，不是 T3 全部兼容性决策。Driver 先查询 installation.compatibility，再优先 brokenRuntimeError，之后才运行此 gate。因此不能从本表推出任意未知/预发行/2.x 二进制一定能启动全部功能。[Driver L334–355](https://github.com/pingdotgg/t3code/blob/a77493caa565ae4e8c12ffb6721e37b3a2c6c06c/apps/server/src/provider/Drivers/AntigravityDriver.ts#L334-L355)

**本仓窄改动建议**：统一最小已知版本为 1.5.1；保留未知版本不伪造已验证/不猜合法性的语义；覆盖 trim、v/agy_acp_server_ 前缀、旧/新/未知/预发行；文档明确最低 1.5.1 不等于“实测所有 1.5.1+”。若采用更严格预发行规则，应单独说明是本仓政策，不假称 T3 原样行为。

## 4. 执行位置：initialize 后、session/new/resume 之前

Driver `startCompatible()` 先 runtime.initialize() 获取 agentInfo.version，拒绝则返回包含更新操作的 AcpTransportError/ProviderSetupError；允许才 runtime.start()。因此旧版本可执行 initialize，但不进入 authenticate/session 创建的后续 start 路径。[Driver L334–373](https://github.com/pingdotgg/t3code/blob/a77493caa565ae4e8c12ffb6721e37b3a2c6c06c/apps/server/src/provider/Drivers/AntigravityDriver.ts#L334-L373)

模型刷新创建 makeDisposableRuntime，后者复用 makeRuntime 的 start 包装。refreshModels 调用 runtime.start()，因此同样拒绝旧 runtime；上游回归对打开会话和刷新均校验相同错误，断言请求列表包含 initialize、不含 session/new，并确认进程关闭。[包装 L403–418](https://github.com/pingdotgg/t3code/blob/a77493caa565ae4e8c12ffb6721e37b3a2c6c06c/apps/server/src/provider/Drivers/AntigravityDriver.ts#L403-L418)、[refresh L649–662](https://github.com/pingdotgg/t3code/blob/a77493caa565ae4e8c12ffb6721e37b3a2c6c06c/apps/server/src/provider/Drivers/AntigravityDriver.ts#L649-L662)、[回归 L539–581](https://github.com/pingdotgg/t3code/blob/a77493caa565ae4e8c12ffb6721e37b3a2c6c06c/apps/server/src/provider/Drivers/AntigravityDriver.test.ts#L539-L581)

另外，安装包 validate 路径只 initialize，再比对 expectedVersion、协议和能力，不启动会话；不要把这种 capability probe 与模型 refresh 的 session probe 混称一个路径。[Installation L746–795](https://github.com/pingdotgg/t3code/blob/a77493caa565ae4e8c12ffb6721e37b3a2c6c06c/apps/server/src/provider/AntigravityInstallation.ts#L746-L795)

**本仓应检查**：聊天 handshake、ACP 模型 probe、CLI models 查询的启动顺序；避免只提升常量却仍让目录发现先执行后续 session 或静默回退旧模型。旧版早退后应清理进程/workspace，不发送 prompt，不丢失可读升级说明。CLI `models` 的版本如何获知是本地架构问题，不能盲抄 T3 的受管安装器。

## 5. 登录失败消息不能掩盖版本拒绝

#43087 扩展 safeAuthFailure：当 AcpTransportError.cause 是 ProviderSetupError 时保留安全 detail，不把“请升级 runtime”变成泛化“Google sign-in failed”。[当前源码 L141–150](https://github.com/pingdotgg/t3code/blob/a77493caa565ae4e8c12ffb6721e37b3a2c6c06c/apps/server/src/provider/AntigravityAuth.ts#L141-L150)

本仓应在现有错误边界用已知安全消息传达版本拒绝，不泄露任意子进程 stderr/credentials；不必为此复制 Effect 的异常结构。已存在的 TOS 持久停用、noRetry、取消清理和账号隔离应保留。

## 6. 前轮之后其他 agy/ACP 相关增量

| 提交/PR | 当前变化 | 是否窄范围同步 |
|---|---|---|
| [25f47db / #43526](https://github.com/pingdotgg/t3code/commit/25f47db09ef1f0b251ef63af565322003cb1f2bd) | 从删除/改名 provider 的磁盘 profile 继续汇总 token 历史 | T3 统计页面需求；不恢复网络额度，本地不需要照搬全历史扫描 |
| [8bf40d6 / #43491](https://github.com/pingdotgg/t3code/commit/8bf40d6c61402f6e3cab43c1252e4cece4f752fd) | 将 native subagent transcript 的 thinking/tools/replies 投影到正常时间线 | T3 原生子 agent UI 机制，本仓客户端工具桥没有对应 UI；不宜为对齐扩读所有子会话 |
| [d389f8b / #43588](https://github.com/pingdotgg/t3code/commit/d389f8b3ac43d1ccbaf170ecd182f183c3540898) | 按 plugin.json manifest 发现 skills，遵循 manifest 优先级与无效插件跳过规则 | 本仓桥 agent 明确禁继承 customizations；无需扩增技能读取 |
| [147028a / #43380](https://github.com/pingdotgg/t3code/commit/147028a265951e2a8893411a11717838b50cd464) | 通用 ACP elicitation 可选 boolean/choice 可跳过；required 缺失时取消 | 只有实现对应 ACP 问答卡片时适用，不是防封/握手修复 |

已核对的直接 agy 变化中，#43087 是本轮最相关的调用边界整改。上述其余项不显示必须立即搬入本地 bridge 的新传输安全补丁；这是限定范围判断，不是对全仓 167 个提交的完整安全审计。

## 建议实施/验收最小集合

1. 维持 #43026 的零内部 HTTP 查询；保留离线 token 计量。
2. 统一已知最低 runtime 1.5.1，修正文档及安全升级错误；所有会话创建/恢复和模型发现路径使用一致门槛。
3. 离线 fixture 验证旧版只 initialize 后结束，无 session/new/resume/prompt；未知/前缀/预发行规则明确；进程与工作目录清理；不把版本错误标记 TOS。
4. 保留 ACP append capability gating、真实错误/取消/多账号隔离，不新增 OAuth、keepalive、自动账号轮换，也不扩大本地数据库扫描范围。
5. 当前 clientInfo 暂不改是用户指定例外，交付时明确未完整采纳 #43087 的“自身身份”部分。不要声称这版改动消除了政策风险或能够解除既有封禁。

调研缓存：`.sandbox/t3-alignment-20261127/`（忽略目录）；本次没有提交、push 或发布。

## 实施与验收（主线程补记）

### 已落地范围

- `index.mjs`：最低已知版本 1.5.1；解析前缀、空白和数字三元组与上述 gate 一致，未知版本不拒绝。保留 `t3-code / 0.1.12`，没有新增运行时 HTTP 请求。
- 两个 `initialize` 调用点全部复查：模型 probe 在检查后才 `session/new`；聊天在检查后才 `session/resume` 或 `session/new`。共 3 个新建/恢复调用点，均受同一 `agyTooOld` 检查约束；正常进程复用不重复握手。
- 聊天版本错误改为明确的 HTTP 400 / `AGY_VERSION_UNSUPPORTED` / `noRetry: true`，同时输出 `x-should-retry: false`；这是宿主重试建议，不是禁止用户手动重试。没有误标 TOS 或清除凭据。
- 模型 probe 继续使用本仓的缓存/兜底目录契约：旧版不建立 ACP 会话，但 UI 可能仍列旧目录；实际聊天仍拒绝。登录仍走本仓独立的 `agy acp --login` 路径，没有为了复制 T3 的 Auth 结构额外启动鉴权/模型请求。
- 同步测试 fixture 和双语文档，补正 `--ide-mcp-port` 已有官方文档的事实；不迁移 T3 安装器、远程 manifest、原生工具/子 agent UI、skills 发现或其他无对应产品功能。

### 离线验证

测试只使用 fake ACP/CLI、临时 HOME；Docker `--network none --read-only --init`，Node 24 Alpine。未运行用户的 agy 或使用真实账号。

| 检查 | 结果 |
|---|---|
| 首轮新用例对未改生产代码 | 31 项中 19 项预期失败、12 项通过；失败覆盖错误状态/旧版被允许/模型 probe 创建会话/降级续接 |
| 最终兼容性套件 | 38/38；包含新增空白、构建后缀、未知短版本和数值比较样本 |
| 全部 Node 测试 | 442/442，27 个登记 suite，约 105 秒，0 skip |
| 真实子进程边界的 fake CLI smoke | 364 项检查通过；新增 12 项校验旧版拒绝、身份、进程退出与工作目录移除 |
| 清理断言变异 | 仅容器临时副本跳过 `rm(this.workspace)`；2/2 用例在“rejected workspace is removed”失败，未改宿主生产代码 |
| RE2 / array-items 独立脚本 | 均 ALL OK |
| npm pack dry run | 24 个文件；保留许可/入口，未包含 reports/test/cache 或已删除的内部 HTTP 模块 |
| git diff --check | 通过 |

初次清理断言把共享 `magpie-agy-bridge-bin-*` shim 目录误当成会话工作目录，导致假红。已改为记录并检查实际 spawn cwd；正常会话会保留该 cwd 的正向检查和清理变异均验证了观测点，没有为过测试改变产品清理逻辑。

本轮未跑 Bun 全套、原生 Windows/macOS 或线上 Google 服务；模拟成功不等于供应商生产兼容性、模型授权或封号风险已验证。验证日志位于 `.sandbox/t3-align-20261127/`。

### 分层自审

- **【① 底层前提】发现并修正**：#43087 的网页缓存/旧描述不能替代最终 API diff；最终未修改 manifest。`--ide-mcp-port` 已列入官方文档，不再称未公开接口。最低版本是支持政策，不是“所有新版本已实测”或“可防封”。
- **【② 可运行性】通过本轮离线验证**：两个初始化路径、三个会话创建/恢复调用点全部核对。旧版错误限于当前请求（自伤），不污染账号或其他会话；未发现本次变更新增的同层/上层故障传播。目录与进程清理有实际子进程和变异证据；原生平台/线上验证缺口如上。
- **【③ 安全正确性】本轮范围无新增发现**：未新增内部 HTTP、凭据读写、账号轮换或自动重放；版本错误不写封禁。身份覆盖是用户明确保留的差异，不应被当作真实自身身份或政策合规保证。
- **【④ 一致性】已对齐**：共用常量/解析器，错误沿用现有 `jsonError` 字段；新 suite 已登记，fixture 的最低版本与缺失图片能力分离，双语文档与未发布状态一致。正常复用、取消、隔离、TOS 和零额度网络回归均通过；本轮无新增重构待办。

包版本仍为 0.2.19；改动标记 Unreleased，未提交、push、打标签、创建 GitHub Release 或发布 npm。其他既有未跟踪研究报告保持不动。
