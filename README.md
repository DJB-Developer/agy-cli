# agy-cli

本仓库是 [magpie-community/plugins 的 agy-cli](https://github.com/magpie-community/plugins/tree/main/packages/agy-cli) 的独立版本，
新增了 **多账号隔离与 refresh_token 直接导入**，支持粘贴 `1//...` 原始 token 或账号 JSON。
保留上游 MIT 版权与来源说明；本仓库的改动尚未发布到 npm。

把本机的 Antigravity CLI（`agy`）接成 Magpie 里的一个模型 provider。装好以后，
OpenCode、Claude Code 等客户端经由 Magpie 调用 agy 向本插件开放的模型，请求实际由
`agy` 进程完成。

**[English → README.en.md](README.en.md)** ｜ 来源、版权与迁移说明见 [NOTICE.md](NOTICE.md)

## 这是什么

插件以 Magpie provider 的形式运行。客户端发来 Anthropic Messages 格式的请求，插件把它
翻译成 ACP（Agent Client Protocol）消息，交给本机的 `agy acp` 进程处理，再把输出翻译回
流式响应。

- 底层是真正的 agy CLI，走它自带的 ACP 通道。ACP 握手里的 `clientInfo.name` 固定为
  `t3-code`，`version` 固定为 `0.1.12`（2026-11-26 核对的 T3 server 版本，不自动同步）；实际 npm 包名和版本不变。这不代表本插件属于 T3 Code、
  获得其授权或能降低封号风险。插件不直接请求 Google 的内部接口。
- 客户端自己的工具（读写文件、执行命令等）通过 MCP 暴露给模型。工具由客户端执行，结果
  回传到同一轮 agy 对话里，模型看到的是原生工具调用。
- 账号风险不由插件决定。Google 的使用政策变化时，插件无法替你保证账号不受限制。

## 与 Antigravity ACP 的区别

社区里的 Antigravity ACP（`antigravity-acp`）走的是同一个渠道：Antigravity 的模型经由 ACP。
两者的区别：

- **运行的程序**：Antigravity ACP 自己下载 Google 的 ACP 服务端（`agy_acp_server.par`，
  约 400 MB），依赖 Antigravity IDE 的登录。本插件不下载任何东西，运行你自己装好、自己
  登录过的 `agy` CLI（`agy acp`）。
- **会话**：Antigravity ACP 每个请求开一个新会话，把历史当作上下文带上。本插件维护一个
  agy 进程池，同一段对话复用同一个 agy 会话，重启后用 `session/resume` 接上；只有接不上时
  才在字节预算内重放历史。
- **工具调用**：Antigravity ACP 把工具调用作为回复的 `tool_calls` 结束这一轮。本插件把
  客户端的结果送回同一轮 agy 对话（见下文「工具桥接」）。
- **额度**：自 0.2.18 起不再查询订阅配额和套餐；仍保留 ACP 回复及本地会话记录提供的逐回合 token 用量。

## 工具桥接

agy 连接 `--ide-mcp-port` 时会运行 `nc 127.0.0.1 <端口>`。插件在 agy 的 PATH 最前面放一个
私有的 `nc`，它把这条连接接到插件自己的 MCP 服务上；控制端口只监听本机回环地址，每个进程
有自己的令牌。

- 这依赖 agy 拨号的方式，不是 agy 公开承诺的接口，已在 1.4.12 和 1.5.0 上验证。agy 低于
  1.4.12 时，插件会直接报错并提示升级。
- 这个 `nc` 只对插件启动的 agy 进程生效，但对这些进程来说，它替换了 agy 运行的所有 `nc`。
- 客户端的每个工具都带 `_meta: {"antigravity/alwaysLoad": true}` 列出。不带的话，agy 会把较大的工具改为按需加载，不放进模型的函数列表，模型就用不到它们（#989）。

## 功能

- **agy 开放的模型**：模型列表以 ACP 会话里 agy 给出的模型选项为准。`agy models` 列出的
  模型如果没有在会话里向本客户端开放（agy 可能只向它认可的客户端开放 Claude、GPT-OSS），
  就不会出现在列表里。列模型时插件会先用 `agy acp` 开一个会话（不发 prompt）问 agy 开放了哪些，
  问到之前只列 Gemini。上次 agy 列出并开放的模型存在会话状态文件旁边的 `models.json`，
  重启后先列它，同时再问一次 agy。模型和思考等级可以在会话中切换，
  历史保留。
- **流式输出与思考摘要**：思考摘要以 `thinking` 块返回，设置 `AGY_BRIDGE_THINKING=0` 可关闭。
- **图片输入**：支持内联 base64 的 PNG、JPEG、GIF、WebP。需要 agy 1.5.0 或更新版本，
  因为图片能力要由 ACP 服务端声明。工具返回的图片（如 `read` 读到的截图）也作为提示里的
  图片交给 agy：走 MCP 的话，agy 会把它存成文件，模型看不到。
- **工具调用**：支持并行和连续调用。运行超过 150 秒的工具会先收到 "still running" 的
  占位响应，真正的结果送达后继续同一轮对话，每个调用只在客户端执行一次。
- **会话续接**：每轮结束后记录会话。重启 Magpie 或插件后，只要历史和指令的哈希一致，
  就用 `session/resume` 接上上下文。状态文件只存会话 ID 与哈希，不存消息原文。
- **隔离运行**：不读取你的全局 MCP 配置。每个 agy 进程使用临时 agent。agy 为它自己的
  工具发起的权限请求（shell、写文件、浏览器等）一律拒绝；客户端工具经桥接的 `ide-tools`
  调用时发起的请求放行一次，这些工具在客户端里运行，受客户端自己的权限管。真正的操作
  都在客户端侧完成。
- **助手预填**：以 assistant 结尾的预填请求（SillyTavern 预设、继续写、bot 框架）不再
  400 拒绝：预填留在本轮并渲染为续写载体，会话跨轮保持对齐，见下文「助手预填」。
- **用量与路由**：逐回合 token 用量保留；订阅额度窗口为空，不伪造为额度耗尽。账号路由仍由 Magpie 管理，但不再提供额度驱动的模型组路由数据。

## 助手预填（assistant prefill）

客户端的请求以一条**纯文本 assistant 消息**结尾时（SillyTavern 预设的预填、
「继续写 / Impersonate」、bot 框架的拼装），旧版会直接 400 拒绝。现在这段
预填被当作本轮的一部分：

- 预填留在本轮尾部，会话账本（expectedMessages，客户端原字节）与客户端自己
  的历史跨轮对齐——预填轮之后会话照常复用，不再整段重放；
- 预填文本渲染为一条续写载体（提示行 + 原文），发给 agy 让模型从停下的地方
  接着写；
- `AGY_BRIDGE_PREFILL=0` 恢复原来的 400 拒绝；`AGY_BRIDGE_PREFILL_CARRIER_NOTE`
  自定义载体提示行。

已知限制：与 live tool_result 共存的预填、以及未应答 tool_use 后紧跟的预填仍被 400 拒绝；前面没有 user 消息的
连续 assistant 尾整段视为预填（该轮降级为新会话，下一轮自愈）；向客户端开放
哪些模型仍由 agy 决定。

## 环境要求

- Antigravity CLI（`agy`），带 `acp` 子命令。在 Magpie 里登录需要 1.5.0 起的 agy（`agy acp --login`）；更早的版本请先在终端运行一次 `agy` 登录。
  文本与工具调用已在 1.4.12 和 1.5.0 上验证；图片输入需要 1.5.0。
- 支持 OpenCode 风格 provider 插件的 Magpie。
- agy 版本低于 1.4.12 时，会话会被拒绝（见「工具桥接」）；额度刷新仅显示本地状态，不执行 `/usage` 或 HTTP 查询。
- **自动更新**：插件启动的 agy 进程默认带 `AGY_CLI_DISABLE_AUTO_UPDATE=true`，免得进程池里的
  多个进程同时更新同一个可执行文件。你自己在终端里运行的 agy 不受影响，照常更新。你自己设置了
  `AGY_CLI_DISABLE_AUTO_UPDATE`（包括设为 `false`）时，插件原样使用你的值。只通过本插件使用
  agy 的话，请定期在终端里运行一次 `agy` 让它更新：版本过旧本身也更显眼。

## 安装

安装本仓库版本（包含多账号、refresh token 导入和 Linux / Docker 支持）：

```sh
magpie plugin add github:DJB-Developer/agy-cli
```

已安装时，在 Magpie 插件页将这个 GitHub 插件更新到 **0.2.19** 并重新加载。
现有账号、凭据和封禁记录保留，无需重新导入。刷新各账号额度以让宿主接收空窗口；
若宿主仍展示旧读数或旧额度冷却，请刷新提供商状态并检查宿主缓存，不要把历史读数当作当前额度。
本版停止内部 HTTP 额度和套餐查询，不回退到旧 CLI `/usage`；历史版本变更见 [CHANGELOG.md](CHANGELOG.md)。

以下市场和 npm 命令安装的是上游社区版本，不包含本仓库的改动。

从 Magpie 社区插件市场安装（推荐）：在 Magpie 的 Plugins 页找到「Antigravity (local agy CLI)」点安装，或在终端运行：

```sh
magpie plugin add @magpie-community/opencode-agy-cli-auth
```

装好后 provider id 是 `agy-cli`，模型写成 `agy-cli/<模型>`。默认并发 16，可在 Magpie 的 Providers 页 Concurrency 里改（0 表示不限）。

安装完成后在 Magpie 里登录即可，不需要先开终端。

## 使用

1. 在 Magpie 的 Providers 页找到 `agy-cli`，点击 Sign in 添加账号。
2. 选择 **Add an account (refresh token)**，填写账号名称（如 `personal`、`work`），
   粘贴 `1//...` 原始 token，或 `{"refresh_token":"…"}` / `{"token":{"refresh_token":"…"}}` JSON。
   token 必须与 agy 的 OAuth 客户端兼容；不需要跳转网页。
3. 再次 Sign in、填写另一个名称和 token，即可添加第二个账号。
   每个账号在 Magpie 中有独立记录，可分别启用、禁用和设置优先级，具体请求调度由 Magpie 负责。
4. 模型仍写成 `agy-cli/<模型>`，不需要给模型名添加账号前缀。

也可以选择 **Add an account with Google**，填写新名称后走网页登录，
把页面上的授权码粘贴回 Magpie。登录链接等待 15 分钟。

### 多账号存储与旧版迁移

- 从 0.1.43 升级后，原来的 `agy` 默认账号继续可用，不需要重新导入。
  **Use the existing CLI account (legacy default)** 用于重新登记这份已有登录。
- 新账号各有独立的 CLI 目录、凭据、进程池、工具调用状态、会话续接记录、模型列表和本地状态读取。
  Magpie 保存 `agy:<账号名称>` 引用，token 由 agy 自己刷新。
- 名称支持 1–64 位字母、数字、下划线和短横线，统一转成小写；`default` 等保留名不可用。
  同名账号不会被覆盖；导入失败只清理本次新建的目录，不影响已有账号或正在进行的请求。
- 删除 Magpie 里的账号记录不会删除磁盘上的凭据。选择 **Use a saved named account**，
  输入原名称即可重新登记，**不要再次选择 refresh token 导入，也不需要给名称加 `-`**。
  该操作复用磁盘上的凭据，不使用新 token，也不会清除封禁记录。
  若需换 token，请先用新名称添加账号并验证，再禁用旧账号。
- 新账号目录默认位于 `$XDG_CONFIG_HOME/magpie-agy-cli/accounts/<名称>`；
  未设置 XDG 时为 `~/.config/magpie-agy-cli/accounts/<名称>`。
  可用 `AGY_BRIDGE_ACCOUNTS_DIR` 指定根目录。token 文件权限为 `0600`，新建账号目录为 `0700`。
- 新账号统一使用 `--gemini_dir` 和 CLI 的文件凭据模式，无需系统钥匙串或 `secret-tool`；
  账号子进程不使用宿主的 Gemini/Google API key、ADC 或 Vertex 环境认证。
  原来的默认账号仍使用原存储和环境配置。
- 账号文件丢失或不可读时返回登录错误，不会回退到默认账号。

#### 1Panel / Magpie 官方 Docker 镜像

保持现有的 `magpie-config:/config` 卷即可，**不需要修改 Compose**。
[Magpie 官方镜像](https://github.com/yetone/magpie/blob/main/Dockerfile) 设置了 `XDG_CONFIG_HOME=/config`，
新增账号保存到 `/config/magpie-agy-cli/accounts/<名称>/`，容器重建后仍保留。
旧默认账号继续使用 `/config/home/.gemini/antigravity-cli/antigravity-oauth-token`。
无需安装 D-Bus 或 GNOME Keyring，也不要把 token 写进 Compose。

已在无网络、非 root Linux 容器中用真实 agy 1.5.9 验证：两个独立目录的
`models` 和 ACP 均读取自己的凭据，没有使用默认账号。
此测试使用虚构 token 验证存储隔离，没有调用真实账号的模型。

## 并发

- 每个账号的进程池上限由 `AGY_BRIDGE_MAX_PROCS` 决定，默认 16 个 agy 进程。
- Magpie 的 Providers 页有单独的 Concurrency 设置，可填 0–1000，0 表示不限制。
  你在页面里改的值会覆盖 `package.json` 里 `magpie.maxConcurrency` 的默认声明（16）。
- 进程池已满、又找不到可以淘汰的进程时，插件返回 HTTP 503。建议两处数值保持一致：
  Providers 页的并发数超过进程池上限，多出来的请求就会得到 503。

## 平台

- **macOS、Linux**：支持。
- **原生 Windows**：支持 `.exe`、`.cmd`、`.bat` 的查找与启动，后台更新检查不弹控制台窗口，
  并支持 `magpie quota`。目前只有命令构造的单元测试，尚未在 Windows 实机完成端到端验证。

## 额度与套餐（0.2.18）

```sh
magpie quota agy-cli --json
magpie quota refresh agy-cli --json
```

**额度和套餐查询现已停用；聊天仍由官方 `agy acp` 执行。**
参考 [T3 Code PR #43026](https://github.com/pingdotgg/t3code/pull/43026)：维护者转述 Google 的提醒，
外部客户端应使用 ACP，调用内部 API 可能导致账号被标记。这不是对任何具体账号封禁原因的证明，也不保证本版不会被封禁。

- 删除 `retrieveUserQuotaSummary`、`fetchAvailableModels` 和 `loadCodeAssist` 直接 HTTP 查询。
- 刷新只返回 `windows: []`、不可用说明和 `signIn: kept`，不再返回套餐；未知额度不是 0% 或 100%，也不代表登录失效。
- 不提取 access token、不后台续期 OAuth、不发送保活或探测 prompt，也不回退到 CLI `/usage`。
- 保留逐回合 token 统计和本地会话数据库只读计量；这不是订阅剩余额度。
- 保留账号选择、并发、会话隔离和实际聊天错误处理；不再产生基于查询额度的模型组路由窗口。
- 已有 TOS 停用记录仍返回原因和 `signIn: expired`，并按既有选项通知本机 Magpie 关闭账号；这类 loopback 管理请求不是 Google 额度查询。
- 没有本地停用记录不代表已验证聊天权限。刷新不会主动检测新的封禁，也不会自动解除旧封禁。

仅回滚 0.2.16 不能移除所有内部 HTTP，因为该版仍有套餐请求。升级后请重新加载插件并刷新宿主状态。

## 请求耗时诊断与会话隔离（0.2.16）

在 Magpie **提供商 → agy-cli → 编辑 → 插件选项** 打开 **请求耗时诊断** 并保存；
从新请求生效，不需要重启容器。旧宿主可用 `AGY_BRIDGE_TIMINGS=1`，Magpie 界面值优先。
诊断默认关闭，写入容器日志而不是聊天正文：

```sh
docker logs --since 10m magpie 2>&1 | grep -F '"event":"agy_bridge_request"'
```

每账号每分钟最多 120 行，超出的行数在下一条可输出记录的 `suppressed` 中报告。
日志包含请求 ID、账号/会话哈希、状态和单调时钟耗时；不记录账号名称、原始会话 ID、提示词、凭据或工具参数。

- `stages_ms.catalog`：等待模型目录；`lock_wait`：插件内会话锁等待（**不含 Magpie 路由排队**）。
- `stages_ms.startup`：冷启动总耗时，包含 `process_prepare`、`initialize`、`session_new` / `session_resume`、模型配置等阶段；嵌套阶段不能相加。
- `prompt_dispatch_ms`、`acp_first_output_ms` / `acp_first_text_ms`：从插件收到请求到首次 prompt 发出、CLI 首事件/首正文。
- `first_output_ms` / `first_text_ms`：到插件输出首个内容事件/首正文；前者也包括思考和工具。不是 SSE `message_start` 或心跳时间。
- `after_first_output_ms`：首事件之后到本次响应结束，可能包含工具等待及额度计量，不能当作纯模型生成速度；`usage_settlement` 单独记录响应 token 计量耗时，**不是账号额度查询**。
- `total_ms`：本次插件请求时长；`session` 为 `new`、`reused`、`resumed` 或 `tool_continuation`；`resume` 说明恢复失败/绑定不匹配等原因。
- `status` 是结果分类（包括 SSE 内的错误），不一定是流式 HTTP 的外层 200；取消记为 `cancelled` / `499`，不是将 HTTP 499 发给客户端。
- 非流式响应的首字时间也是内部流的时间，用户仍要等整条 JSON；反向代理缓冲、客户端网络耗时不在这里测量。

**多用户接入必须提供稳定且不冲突的会话标识。** Chat Agent 调用 Magpie 时可携带
`X-Magpie-Session: <服务端生成的用户与会话唯一标识>`，每轮及工具回传保持一致。
插件使用 Magpie 转发的 `X-Magpie-Session`、`X-Magpie-Subagent`，以及请求体
`metadata.user_id` / `metadata.session_id` 共同隔离会话。后两项只在宿主实际保留该字段时生效，
不能假设 OpenAI → Anthropic 转换会保留任意 metadata。
诊断中 `identity_source: magpie_header` 表示收到了会话头，`metadata` 表示收到显式体内会话 ID；
`legacy` 表示仍依赖用户标识/历史匹配。没有身份字段的相同历史不能保证不同用户隔离。
标识用于关联而非身份认证：后端必须鉴权并绑定用户，不要允许不可信客户端冒用其他用户的会话标识。

跨用户/会话的活跃工具结果不会送入原会话；缓存恢复还校验账号 profile、工作目录、历史和提示词。
旧的无绑定缓存或不匹配记录不恢复，改为使用本次请求自己的历史新建会话；不会删除账号登录。
恢复失败只记录固定原因，不把 CLI 原始错误写入耗时日志。

取消覆盖目录等待、会话锁等待、启动握手、流式和非流式生成。
正常取消并完成 ACP 确认后，匹配历史的会话仍可复用；取消未确认默认等 15 秒后停止进程并释放槽位，
失控会话不会再次恢复。完整工具响应正常结束不等于取消，仍允许下一请求回传工具结果。
本次不修改 Magpie 的账号路由策略，也不增加隐式重试或工具重放。

## 环境变量

| 变量 | 默认值 | 作用 |
|---|---|---|
| `AGY_PATH` | 按 PATH 查找 | 指定 agy 可执行文件 |
| `AGY_BRIDGE_ACCOUNTS_DIR` | XDG 配置目录下的 `magpie-agy-cli/accounts` | 多账号凭据与状态根目录 |
| `AGY_BRIDGE_MAX_PROCS` | 16 | 每个账号的 agy 进程池上限 |
| `AGY_BRIDGE_TIMINGS` | 关闭 | 设为 `1` 输出无正文的分段耗时；Magpie「请求耗时诊断」界面值优先 |
| `AGY_BRIDGE_CANCEL_SETTLE_MS` | 15000 | 等待取消确认的上限，可调低，不可超过 15 秒 |
| `AGY_BRIDGE_THINKING` | 开启 | 设为 `0` 关闭思考摘要 |
| `AGY_BRIDGE_EFFORT` | 未设置 | 强制思考等级：`minimal` / `low` / `medium` / `high` / `xhigh` / `max` |
| `AGY_BRIDGE_MINIMAL_AGENT` | 关闭 | 设为 `1` 去掉 agy 自带的提示组件；Magpie 界面保存的开关优先，见下文「精简 agent」 |
| `AGY_BRIDGE_IDLE_MS` | 600000 | 进程空闲多久后回收（会话仍可续接） |
| `AGY_BRIDGE_RESUME_TTL_MS` | 21600000 | 回收后的会话可续接的时长（6 小时） |
| `AGY_BRIDGE_STATE_FILE` | `$XDG_STATE_HOME/magpie-agy-bridge/sessions.json` | 会话状态文件路径 |
| `AGY_BRIDGE_IDE_CALL_DEADLINE_MS` | 150000 | 工具运行超过该时间仍未结束时，先返回 "still running" |
| `AGY_BRIDGE_START_TIMEOUT_MS` / `_TURN_TIMEOUT_MS` / `_TOOL_TIMEOUT_MS` | 60 秒 / 5 分钟 / 30 分钟 | 进程启动、agy 无输出、等待客户端工具结果的超时 |
| `AGY_BRIDGE_DETACHED_EVICT_MS` | 30000 | 客户端已断开的挂起工具回合，最多占用进程池槽位这么久 |
| `AGY_BRIDGE_MAX_PROMPT_BYTES` | 114688（112 KiB） | 重放历史提示词的字节预算 |
| `AGY_BRIDGE_STORED_SIGNIN` | 未设置 | 设为 `skip` 时插件不读 agy 存的登录 |
| `AGY_BRIDGE_MCP_TRACE` | 未设置 | 把 MCP 通道流量写入指定文件，仅用于排查 |
| `AGY_CLI_DISABLE_AUTO_UPDATE` | 插件启动的 agy 设为 `true` | agy 自己的变量。你设置了就原样传给 agy，见「环境要求」 |
| `AGY_BRIDGE_PREFILL` | 开启 | 设为 `0` 恢复对 assistant 预填尾巴的原生 400 拒绝，见「助手预填」 |
| `AGY_BRIDGE_PREFILL_CARRIER_NOTE` | 英文系统提示行 | 预填片段渲染时的提示行文本（发给模型） |

## 精简 agent

从 0.2.3 起，在 Magpie **提供商 → agy-cli → 编辑 → 插件选项** 中，打开或关闭
**精简 Agent 提示词**，然后点保存即可，不需要修改 Compose 或重启容器。
这个开关对 agy-cli 的所有账号生效，由 Magpie 保存，重启后保留。

保存后从新的对话轮次生效；正在生成回复或等待工具结果的请求会按原配置完成。
切换模式后，下一轮会根据客户端携带的历史重建会话，避免继续使用旧提示词。
升级前保存的会话没有记录此模式，因此首次续接也会根据客户端历史重建一次。

没有界面设置时，默认关闭；已有 `AGY_BRIDGE_MINIMAL_AGENT=1` 环境变量会作为开关的初始默认值。
界面保存的开或关优先于环境变量。旧版 Magpie 或 OpenCode 不提供该开关时，仍可用环境变量设置。
如果更新插件后看不到“插件选项”，请更新 Magpie。

默认情况下，agy 用它自己的系统提示词跑每个请求，客户端的系统提示词附加在后面（agy 声明
支持 `systemPrompt.append` 时放进会话，否则作为 `<external_system_instructions>` 放在
第一条提示词开头）。

Antigravity 对几行系统提示词（Claude Code 的计费行、Claude Agent SDK、Codex、Hermes Agent、OpenCode
和 pi 的身份句、oh-my-pi 的 RFC 2119 行）不论余量多少都回 429 "Resource has been exhausted"。插件在
agy 发出之前去掉计费那一行，其余几行换成同义的说法（"built on the Claude Agent SDK by Anthropic"、"built on GPT-5"、"RFC 2119 key words: …"、"You're Hermes Agent / OpenCode / a coding agent running in the Codex CLI"、"running within pi"），和 Antigravity 提供商的做法一样（`cloak.mjs`）。零宽空格已经没用：11-14 起 Google 的检查会忽略它们。如果仍然
回了这样的 429，会报成针对提示词的 400，而不是额度用完。

DeepSeek Harness 的 `@` 路径说明段（"Tokens prefixed with @ are paths…"）也和 Antigravity 提供商一样
换成同义的说法再发：原文照发时 `gemini-4-argon` 大多很快答完、不思考、只走一步（#1028）。

打开开关（或通过环境变量设为 `1`）后，临时 agent 带上 `excludeDefaultComponents: true`：发往上游的请求里不再有
agy 自己的系统提示词，只剩插件的一行工具说明和客户端的系统提示词（同样以上面两种方式之一
发送）。原作者实测每次模型调用的输入从约 8,400 token 降到约 500 token。代价是上游看到的
不再是 agy 自己的请求形态，所以默认关闭，由你自行决定是否开启。

## 常见排查

- **找不到 agy**：设置 `AGY_PATH` 指向可执行文件，或确认 `agy` 在 PATH 里。
- **Sign in 失败或 agy 报登录相关错误**：再点一次 Sign in 重新登录，或在终端运行一次 `agy` 登录。
- **HTTP 503**：进程池满。提高 `AGY_BRIDGE_MAX_PROCS` 和 Providers 页的 Concurrency，
  或者减少同时进行的会话。
- **额度显示不可用、套餐消失**：这是 0.2.18 移除内部 API 查询后的预期行为，不要通过反复刷新或重新登录修复。正常聊天和逐回合 token 统计不受此功能移除影响。
- **图片请求返回 HTTP 400**：当前 agy 没有声明图片能力（需要 1.5.0 以上）。另外只接受
  内联 base64，URL 图片和 PDF 等二进制文档都会被拒绝。
- **回复里出现 "Agent execution terminated due to error."**：这是 agy 的错误标记。插件会
  从 agy 的日志中取出真实原因，并以错误结束本轮，不会当作正常回复输出。agy 1.5.8 的
  "There was a network issue connecting to the server" 和 "Your AI credits balance is
  too low to continue." 也一样（后者按额度不足报错）；`⚠ API error (attempt N)` 这类
  重试中的提示行会被去掉。
- **HTTP 409，提示工具结果与历史对不上**：通常是客户端在对话中途改写了历史或工具 ID。
  能确定对应关系时插件会重建会话；无法确定时直接拒绝，不做猜测。
- **想关掉思考摘要**：设置 `AGY_BRIDGE_THINKING=0`，或者在请求里带上
  `thinking: { "type": "disabled" }`。

## 开发

```sh
bun test                       # 在本仓库根目录
```

测试用假的 agy 进程（`test/` 下的 ACP stdio 服务）跑完整的 ACP 与 MCP 链路，不调用真实
agy，不消耗额度。

## License

MIT。版权声明见 [LICENSE](LICENSE)，上游来源与逐项变更见 [NOTICE.md](NOTICE.md)。


## 账号服务停用与故障切换（0.2.10）

当 CLI 返回明确的 `This service has been disabled in this account for violation of Terms of Service...`
或结构化的 `403 / PERMISSION_DENIED / TOS_VIOLATION`，插件将其视为该账号的服务停用。
识别聊天末尾警告、CLI 重试行、ACP 错误、当前回合日志及本轮数据库错误。
普通 403、地区不支持、登录过期或 429 不会被标记为服务停用。0.2.18 已移除额度/套餐的网络检测。

非流式请求返回 HTTP 403；流式请求发出 `permission_error`，携带数值 `status: 403`、
`code: TOS_VIOLATION` 和停用原因，避免把警告当成成功回答。Magpie 上游的账号故障切换机制
会在回答尚未发出时尝试其他可用账号；如果希望所有账号失败后换供应商，需要在 Magpie
路由组里配置备用模型，并让客户端请求该路由组。已输出部分回答后不能保证无缝切换。
旧版 Magpie 的协议转换可能丢失流式 403，不能只靠状态码永久排除账号；0.2.13 的自动关闭不依赖这项识别。

停用状态按账号保存在 `<账号目录>/bridge-state/service-status.json`；旧默认账号的文件
与 `sessions.json` 同目录。文件只存原因代码和检测时间，不存 token 或对话。
后续聊天直接返回 403，不再调用该账号的 CLI；刷新额度显示停用原因并通过 Magpie 的
`signIn: expired` 标记登录不可用（它本身不保证 Magpie 排除路由）。0.2.13 使用下述管理接口真正关闭账号。
刷新 token、刷新额度和重启不会自动解除停用。若写文件失败，会记录日志并在本次运行期间阻止使用。

**本地未记录停用不代表聊天权限正常**：本功能依赖实际聊天中 CLI 返回的明确停用信号，不主动发送探测对话。
已知被停用但插件尚未见过错误的账号，请先在 Magpie 手动关闭。
申诉通过后，先停止 Magpie/插件，删除该账号的 `service-status.json`，再启动并刷新额度；
必要时在 Magpie 重新启用该账号。不要仅因为 token 刷新成功就解除标记。


## 同开场白的多模型并发（0.2.11）

Magpie 的“测试模型”会同时向不同模型发送相同的 `hi`。现在这类请求使用独立的 agy 进程，
不再因共享会话键而只成功一个。进程分配和回合开始使用同一个锁；对仍在执行的同模型开场请求，
重复提交仍返回忙碌，包含并发分配出的后续模型。每账号进程池上限继续生效。
多账号隔离不变；这项修复不代替多人聊天系统提供明确的用户和会话标识。
工具很多、超过预算时，插件优先保留工具用途和复杂参数说明，避免普通参数描述被截成 `field…`
这类无意义碎片；预算足够时仍原样传递，工具名称与参数结构保持不变。


## 刷新额度时的账号状态检查（历史功能）

0.2.12–0.2.17 曾通过 HTTP 元数据检查新的停用信号；0.2.18 已移除此机制。
当前刷新只读取已记录的本地停用状态。实际聊天收到明确 TOS 时仍会保存并隔离账号；申诉后的恢复方式见上文。

## 自动关闭被封禁账号（0.2.13）

在 Magpie 插件设置中新增 **自动关闭被封禁账号**，默认开启。明确识别到 TOS 封禁后：

1. 立即保存该账号的停用状态，后续请求在本地拒绝，不再调用该账号的 CLI。
2. 异步调用本机 `POST http://127.0.0.1:3430/api/login/off`，相当于取消该账号的启用勾选。复用容器已有 `MAGPIE_WEB_KEY`，不需要把管理密钥填写到插件设置中。
3. Magpie 从现有启用账号中选择后续候选；插件不自行跨账号转发，额度、并发、会话和计费归属仍由 Magpie 管理。

适用于已配置 `MAGPIE_WEB_KEY`、使用 3430 端口运行 `magpie web` 的容器，包括所核对的 v0.1.3078。管理请求仅走 loopback，不使用供应商代理、不跟随重定向、不输出密钥，也不直接编辑 Magpie 配置文件。聊天继续走 agy CLI；额度刷新仅显示本地状态，不查询 Google。

更新并重新加载插件后，刷新额度也会处理此前已记录封禁的具名账号。管理操作不阻塞额度或聊天；同一账号合并并发操作，失败后在后续检查时最多每分钟重试一次，成功后五分钟内不重复提交。界面的额度错误会说明自动关闭是否成功；接口失败、缺少管理密钥、端口不匹配或旧默认账号无法可靠识别时，仍在插件内拦截，并提示手动关闭。

Magpie v0.1.3078 不允许关闭最后一个启用账号：必须存在另一个启用且登录有效的账号。若没有可用账号，插件仍拒绝被封账号，客户端收到错误，或由已配置的路由组尝试备用供应商。已经发出部分回答的请求不能保证无缝切换。自动关闭不会删除凭据，也不会自动解封；申诉通过后按上述方法清除停用文件，再手动启用账号。

旧的“402 到点恢复”可能仍留在历史冷却记录中，但关闭后的账号不再参与后续选路。自动关闭开关关掉后，仅保留插件本地拦截，需手动管理 Magpie 的启用状态。


## 上游兼容修复（0.2.14）

- 修复 `run_command` 的必填 `toolSummary` 与 CLI 自带字段重复导致工具箱启动失败的问题。仅在客户端声明该字段且 CLI 未返回时补上默认摘要；已有摘要及其他工具不变。
- 临时静态模型目录或探测中的 Gemini 列表标记为 fallback，让 Magpie 保留之前的模型选择；状态按账号隔离。
- 已识别的请求内容拒绝在流式错误中带 `status: 400`，非流式回复返回 HTTP 400，避免错误文字中的 429 被误判为额度限制。普通额度错误仍是 429，封禁仍保留 403、`TOS_VIOLATION` 和自动停用。

这项历史修复没有引入单账号替换登录、系统提示词位置变更或 CLI 自动安装，不要求 Magpie 0.1.4246。0.2.18 起已另行移除额度和套餐查询。


## 本轮数据库错误检测与恢复时间（0.2.15）

除原有 ACP、CLI 警告与日志识别外，插件现在还只读检查当前账号/会话数据库中**本次 `session/prompt` 新增的最后一步**。如果 CLI 以 `end_turn` 收尾但最后记录是错误步骤，会返回失败而不是空的成功回答；普通回答里引用错误、旧回合错误、已恢复的中间重试和取消结果不会因此被判失败。

- 每个账号仍使用自己的 `antigravity-cli/conversations`。数据库检测不依赖 token 用量统计开关；缺失、锁定、格式不兼容或文件身份校验失败时跳过，继续原有错误检测，不阻断正常聊天。
- 额度/临时服务错误只有明确返回 `quotaResetTimeStamp`、`quotaResetDelay` 或 `retryDelay` 时才附带恢复时间，优先有效的未来时间戳，其次 quota 延迟，再次 retry 延迟。非法、过期、负数和溢出值不作为恢复时间。
- SSE 错误包含 `reset_at`（ISO 时间）与 `resets_at`（向上取整到 Unix 秒），非流式错误另带 `Retry-After`。错误文字也包含带时区的绝对重试时间，以兼容可能丢弃扩展字段的协议转换。恢复时间是厂商的重试提示，不保证届时一定可用。
- 明确的 TOS 封禁仍为 403 / `TOS_VIOLATION`，持久阻止该账号并执行已有自动关闭逻辑，**不设置自动解封时间**。普通 403 不会因此成为永久 TOS 封禁；已识别的请求拒绝仍是 400。
- 不缓冲整段回答：若错误在已输出正文或工具调用后才写入数据库，插件会结束为错误，但不能撤回已发内容，也不会自动重放工具操作。

当前聊天继续走 agy CLI；0.2.18 已移除额度与套餐查询，但保留本轮数据库错误检测。升级后重新加载插件即可，无须迁移凭据或修改容器配置。
