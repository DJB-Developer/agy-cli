# agy 上游选择性同步记录（2026-11-25，未发布）

## 基线与结论

- 本地基准：`69fc5eccefa9bb70b9f0c4b5baed97e55ecc0907` / 0.2.17。
- Magpie：[`bbd3a2e76d7f2e765f0181786a60169b7acf860a` / 0.1.121](https://github.com/magpie-community/plugins/tree/bbd3a2e76d7f2e765f0181786a60169b7acf860a/packages/agy-cli)。
- T3 Code：[`072611f65fc3b77f13909ce451e87c3e265d8b05`](https://github.com/pingdotgg/t3code/tree/072611f65fc3b77f13909ce451e87c3e265d8b05)。
- 不是整包覆盖，也不是“防封补丁”。源码支持的结论是：准确传播明确拒绝、减少无效重试和会话替换，修复工具兼容性；没有封禁率或服务端判定数据。
- 用户确认保留本地多账号和封禁停用。仅修改工作区；没有提交、推送、发布、部署或调用线上账号。

## 本轮已同步

### 1. 明确拒绝与额度提示

[Magpie 禁止重试](https://github.com/magpie-community/plugins/commit/9720caa468a509e3063c3c96eabe59a817a93e5b)、[账号验证](https://github.com/magpie-community/plugins/commit/83a677177bc3ec8e72f2de24a81259749fa9fa6d)、[新封禁措辞及繁忙提示](https://github.com/magpie-community/plugins/commit/c18d87f7439cb9a62bbd93e338e7d06c428c1ade)、[第三方额度](https://github.com/magpie-community/plugins/commit/8b47ce71a73d7bdc216c82d6a2f7abe407c12fdc)。

- 兼容带/不带 `PERMISSION_DENIED (code 403):` 的明确 TOS 结束提示。仍调用本地 serviceStatus，持久封禁只影响当前账号。
- `Verification Required` → 403 / `VALIDATION_REQUIRED` / `noRetry`，提示人工验证；不是 TOS，不永久禁用账号。不会自动访问验证页。
- `Individual quota reached`、`Third-party quota reached` → 429；高负载提示 → 503。保留服务端恢复时间，不把高负载当账号封禁。
- 流式错误携带 `noRetry`；非流式及后续持久封禁拦截携带 `x-should-retry: false`。这是客户端提示；不声称所有宿主都遵守。插件本身不新增自动重发。
- 原生提示只在行起始且作为最后提示时归类；逐字分块不漏出。内联引用、后面还有解释的引用保留正文。这是与上游相同方向的协议启发式，并非能识别任何任意模型引用。

实现：[index.mjs](/Users/gold/code/agy-cli/index.mjs)。

### 2. T3 的原生错误格式与恢复时间

参考 [AntigravityTurnOutcome.ts](https://github.com/pingdotgg/t3code/blob/072611f65fc3b77f13909ce451e87c3e265d8b05/apps/server/src/provider/acp/AntigravityTurnOutcome.ts)：

- 读取本轮最后一个原生 error step，支持旧格式、`STATUS (code NNN)`、`Status: 502 Bad Gateway`，不把相邻错误拼接成一个。
- 对有边界的 JSON 错误保留实际 HTTP 状态；严格匹配 403 + PERMISSION_DENIED + ErrorInfo 类型/Google domain + VALIDATION_REQUIRED。验证元数据中的 URL/令牌不回显；TOS 证据优先。
- 兼容明确 `Resets in 1h2m3.5s`，保留原先绝对时间优先、无效/溢出时间拒绝及 `reset_at` / `Retry-After`。
- 不改 SQLite 路径、文件身份/链接检查、只读和本轮边界，不增加轮询或迟到扫描。

实现：[turn-outcome.mjs](/Users/gold/code/agy-cli/turn-outcome.mjs)。

### 3. 工具与工作目录

- [所有工具的 toolSummary 修复](https://github.com/magpie-community/plugins/commit/bbd3a2e76d7f2e765f0181786a60169b7acf860a)：不再仅修 run_command；只给声明该属性且参数缺失的工具补摘要，已有值不覆盖。
- [home 目录保护](https://github.com/magpie-community/plugins/commit/22fd1770a5c0bdd222aae5ab99f7d3ac4a16a351)：home/祖先目录不传给 `--add-dir`，普通项目仍传。保留给模型的实际目录说明。这是避免无关 customization 占预算的防护，不是文件系统沙箱。
- [目录进入会话键](https://github.com/magpie-community/plugins/commit/28e0a3ea2a5dc394f20deebe2ac2331a28136f8c)：相同开场/身份、不同目录不再互相替换。原账号和 session/subagent 范围继续生效。有目录的旧 checkpoint 可能首次按请求历史重放，不迁移登录凭据。

## 刻意未同步

- **不替换账号层**：具名账号的独立 runtime、凭据目录、封禁状态、Magpie 自动停用原样保留。上游原生账号导入/快照与本地模型不同，不能整包替换。
- **不改通信身份和请求面**：聊天仍由官方 `agy acp` 执行；保持真实 clientInfo；不复制旧版 editor 身份回退、固定 Hub User-Agent、OAuth 后台刷新或账户轮换。
- **不为防封关闭遥测**：上游 [`38233a5`](https://github.com/magpie-community/plugins/commit/38233a569c0ef63e6bdf897534a9257d49451c1f) 定义其为隐私设置，不构成防封证据。本轮不修改遥测或提示词改写逻辑。
- **不新增静默请求**：未同步 thinking-only 自动续问、spare 预热或新的重放策略；长工具补交保持原行为。
- 本地已有 `AGY_CLI_DISABLE_AUTO_UPDATE="true"`、启动/取消界限、HTTP single-flight 与凭据代际栅栏，不为了追齐 T3 重写。
- call_mcp_tool 参数、图片字节校验、prefill/压缩历史等其他上游兼容性改动留待单独测试，不声称本地已完整追平。
- 既有“某些 429 是 prompt 拒绝”的 400 启发式未扩展；不能据此断言命中风控或封禁。默认 legacy 账号仍跟随 CLI 当前登录状态，未做本轮账号绑定迁移。

## 验证

以下仅使用模拟 CLI/ACP/MCP、假凭据和本地 SQLite，不消耗真实账号额度。Linux Node 24 Alpine 镜像已在本机存在，没有安装依赖。

- 红灯：新增结束提示/目录/摘要回归在旧代码上 27 失败、8 通过；新数据库解析用例在旧解析器上 2 失败。
- 最终结果见下方追加记录。
- 容器约束：`--network none --read-only --cap-drop ALL --security-opt no-new-privileges`；非 root；只有 `/scratch` tmpfs 可写；只读挂载单独源码快照，不挂载主机 HOME、凭据、Docker socket 或其他服务。
- `env -i` 显式仅提供 PATH、HOME、TMPDIR、XDG_CACHE_HOME（需要时）、测试登录 skip；CPU 1–2、内存 256 MiB–1 GiB、PID 64–256、tmpfs 64–768 MiB、单文件 16 MiB、CPU/墙钟均有限额。
- 不声称已运行 Bun 全套、Windows/macOS 原生 smoke 或真实 agy 1.5.x。版本号仍为 0.2.17，发布需另行决定。

补充研究：[T3 同步前源码报告](/Users/gold/code/agy-cli/reports/t3-agy-upstream-20261125.md)。

### 最终结果

- Node 24.22.2：除旧 CLI usage 套件外 **444/444**；旧 CLI usage 单独 **40/40**，合计 **484/484**。usage 使用 Node `--test-force-exit`，不把它当作进程退出/泄漏验证；取消与 pending 清理另有 P0 回归覆盖。
- 独立模拟 CLI 子进程 smoke：**354 项检查全部通过**；RE2 与 array-items 独立脚本均 `ALL OK`。
- 初次合并容器和首次独立 smoke 触发 `spawn nc EAGAIN`；最终使用 `--init` 回收孤儿进程，并设置 `UV_THREADPOOL_SIZE=1`、`NODE_OPTIONS=--v8-pool-size=1`，保留 256 PID、1 GiB 内存、2 CPU、210 秒墙钟上限后复跑通过。未为通过测试放宽产品超时/断言，也未访问外网。
- `git diff --check` 通过；验证用只读源快照与最终全部 `.mjs` / `package.json` 字节一致。
- 验证日志（`.sandbox/` 已被 git 忽略）：[主套件](/Users/gold/code/agy-cli/.sandbox/upstream-sync-20261125/final-node.log)、[usage](/Users/gold/code/agy-cli/.sandbox/upstream-sync-20261125/usage.log)、[最终 smoke](/Users/gold/code/agy-cli/.sandbox/upstream-sync-20261125/smoke-final.log)、[独立脚本](/Users/gold/code/agy-cli/.sandbox/upstream-sync-20261125/units.log)、[首轮红灯](/Users/gold/code/agy-cli/.sandbox/upstream-sync-20261125/red.log)、[解析器红灯](/Users/gold/code/agy-cli/.sandbox/upstream-sync-20261125/parser-red.log)。主套件日志后段包含最初组合运行 smoke 的失败；444/444 指其前段 Node runner 汇总，最终 smoke 以独立最终日志为准。

生产文件 SHA-256（便于核对验证对象）：

```text
index.mjs        31d35fe33ceac7761440740f1079182697f56b3c658baac7e528e7aa7b7dec55
platform.mjs     d9a8bd2a29638af696cd2b396d6e5f2d8f68ef6b07985b769ca91fe745c10eb5
turn-outcome.mjs 6cfdfb7d22722a0aced4505308648ce1fc0d3e45fb90de667fc3ae9716f4d872
```
