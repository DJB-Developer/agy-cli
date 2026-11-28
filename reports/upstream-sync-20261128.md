# 选择性同步上游与额度冷却（2026-11-28）

## 范围

- 基线：本仓 `5ce7a9e` 加先前用户批准、尚未提交的额度冷却改动。
- 本次 fetch 固定 Magpie main `46ba1e4eb4b26c4b4993709e78e7841562fa5c41`；agy-cli 路径最新提交仍为 [0.1.157 / 25b0979](https://github.com/magpie-community/plugins/commit/25b0979cdf9367c27a60be0aab3b2fe48e2f4458)。不是整体 merge，也不以本仓版本号冒充上游版本。
- 合入先前已批准的真实额度错误冷却及测试，详见 [冷却实现记录](/Users/gold/code/agy-cli/reports/quota-cooldown-20261128.md)。记录中的“未提交”描述的是当时状态，本次一并提交。

## 同步内容

1. 运行中的 prompt 每 500ms 有界读取本轮新日志完整行，遇 bare 429 静默重试提前返回。半行留待下次读取，忽略 prompt 前日志；观察到轮转/截断时保守跳过已有内容。没有新增 CLI/HTTP/额度探测。普通 429 不写耗尽窗口；已输出、已调用工具或已提交工具结果时带 noRetry；取消后不再触发 watcher 失败。
2. 参考 [跨账号别名保护](https://github.com/magpie-community/plugins/commit/f52a5151def2ff3085a301c3e82634e5fc301ed0)，适配本仓分 profile 的 models.json，而非照搬上游 catalogKey。仅查有效目录缓存和 .ready 标记，不读取其他账号凭据或启动其他账号 CLI。已有工具回传不被后来出现的其他账号目录拦截。
3. 参考 [旧宿主晚写 checkpoint](https://github.com/magpie-community/plugins/commit/4836dc1)，takeParked 补读磁盘目标记录，仍校验账号绑定/历史/工作目录/时间；保留 32 条上限，不顺带扩容。

## 自审与验证

- 自审发现别名保护会拦截已有工具回传，先新增失败测试复现 HTTP 400，再修为新路由请求才检查；回传交付一次的回归通过。
- 新增 `test/upstream-sync.mjs` 六项假 ACP 回归：静默错误、部分输出 noRetry、旧日志/非 429 不误杀、晚写 checkpoint、跨账号模型防替代、在途工具回传。
- Node 定向 quota/upstream-sync/lifecycle 43 项通过（当时新增套件五项）；补第六项后独立 upstream-sync 六项通过。
- Bun 包装入口初次 34/34（含 fake CLI smoke）通过；随后用最终树重跑完整 `bun test`，结果见下文。
- `node --check index.mjs`、`node --check usage.mjs`、`git diff --check`、`npm pack --dry-run --json` 通过。
- 未访问真实 agy/Google 模型、未查询额度。未对当前运行 Magpie 做端到端账号/备用路由验收；本地离线测试不能替代宿主实际路由验证。

## 保留的边界和后续项

- 不合入主动额度/TUI 回退、TOS 十分钟后自动放行、提示词改写或原生工具权限扩张。
- 本次只新增 bare 429 的运行期 watcher，不另加 503 watcher；既有 503 结束错误分类保持。
- T3 的静默 prompt 完成证据、实际执行模型等仅研究，未在本次移植；它不是本仓账号冷却表的来源。
- 额度缓存仍以内存账号运行时 + selected 模型及 effort variants 为范围；不能声称已观测 executed model，也不推断整个 Individual/Third-party 池。登录切换后的 usage-first、相对 reset 观察时间锚及宿主 noRetry/备用路由仍按研究报告列为后续验收项。
- 包版本保持 0.2.19；本次按要求提交 main 并 push，不创建 tag、GitHub Release 或 npm 发布。

### 最终树验证结果

`bun test`：**40 pass / 0 fail / 168 expect() calls**（2 个入口文件，包含包装子套件及 fake CLI smoke），耗时 72.21 秒；日志 `.sandbox/sync-20261128/final-bun.log`。不是 40 个内部总用例。
