# Magpie agy-cli 增量同步（2026-11-27，未发布）

## 固定基线与范围

- 本地 HEAD `b42f976116d4b22f1f705dcf8327330877f97d5c`，包版本保持 0.2.19。开始前已有 9 个跟踪文件修改及研究/测试新文件，全部保留；原 diff 备份于 `.sandbox/upstream-sync-20261127/preexisting.patch`。
- 本轮 fetch main 为 [`3feae3425239c2ed01bd8b2f745bd7dec911bf51`](https://github.com/magpie-community/plugins/tree/3feae3425239c2ed01bd8b2f745bd7dec911bf51/packages/agy-cli)，包最近提交 [`24d86c5`](https://github.com/magpie-community/plugins/commit/24d86c5ef39203b952387d1bd9d09df643da6dd7)，0.1.156。
- 相对上次核对 `bbd3a2e`，路径历史新增 36 个提交。仅选择性移植下列三个补丁，不宣称完整同步全部上游功能；保留本仓版本线和账号/停用策略。

## 已落地

1. **开放工具对象参数**（[24d86c5](https://github.com/magpie-community/plugins/commit/24d86c5ef39203b952387d1bd9d09df643da6dd7)）：sanitizer 在 pattern 处理后补开放声明，涵盖递归对象和 nullable object；不覆盖显式 additionalProperties 或限制性的 unevaluatedProperties。附原上游完整 schema 回归及 MCP tools/list 断言。
2. **显式思考档位**（[a911229](https://github.com/magpie-community/plugins/commit/a911229)）：环境覆盖 → 显式档位 → model alias 档位 → budget 推断。thinking disabled 不采纳头部档位。HTTP Request、普通 init headers、大小写/空白、非法值 fallback 均覆盖。
3. **原生斜杠命令误触**（[cef8824](https://github.com/magpie-community/plugins/commit/cef88244874cb819fb03e2e723bad03daeadd87a)）：在唯一 ACP prompt 发送边界处理全部 text part（包括初始历史、续问和迟到结果）；仅完整命令词插入 U+2060，采用 Go 空白边界，接收会话动态命令。MCP 参数递归移除同样的插入字符，避免 Edit old_string 无法匹配。未复制其他 cloakUser 改写；桥接请求不是原生 slash-command 控制入口。

## 明确未同步及原因

- **额度查询**（0.1.123 / 0.1.135 / 0.1.140 / 0.1.153）：本仓已明确移除在线额度与 CLI usage，不恢复上游 TUI fallback，也不新增后台请求。
- **账号/gateway 环境改造**（0.1.133 / 0.1.148 / 0.1.150）：上游单账号导入/缓存模型与本仓具名隔离不同，不能直接套用；没有变更真实登录或凭据。
- **宽松历史匹配、模型切换复用、重放分片和跨宿主恢复**（0.1.122 / 0.1.127–132 / 0.1.137–139 / 0.1.142–147 / 0.1.152）：需单独验证本地账号、目录、宿主 session/subagent 和取消隔离；不为追平版本削弱已有边界。优先后续做 tool_result 幂等回放与跨宿主 checkpoint 兼容性。
- **图片生成、原生搜索、音视频**（0.1.136 / 0.1.141 / 0.1.155）：新执行器/附件权限边界，不是低风险补丁；需独立设计和端到端测试。
- **无容量提前中止、十分钟禁用缓存**（0.1.125 / 0.1.149）：前者增加日志轮询与进程中止，后者不能代替本地 TOS 持久硬停止，本轮不改变生命周期。
- **minimal-agent 风险提示**（0.1.134）：属于既有高级选项的文档警告，本仓已保留风险报告；本轮不变更该选项或把它称为防封手段。
- **跨账号模型别名保护**（0.1.126）：值得下一轮优先适配，但上游读取的账号目录与 catalog key 不同，本轮不直接复制。

## 验证

测试均使用临时 HOME 与假 ACP/CLI，不使用真实账号或模型额度；testkit 禁止意外 fetch。没有声称操作系统级断网。本机 Docker daemon 不可用，未重跑 Linux 容器或 Windows。

- 新的 effort + slash 集成在本轮修改前 index 上 **7 fail / 3 pass**，确认捕获旧缺陷；原始 index 取自开始时工作区，包含之前未提交的版本门槛。
- schema + slash 定向 Bun 集成 **28 pass**；effort **7 pass**；cloak 含新增边界测试 **6 pass**。
- 全套与 smoke 最终结果见下方追加。

无 commit/push/npm 发布。T3 研究另见 `reports/t3-agy-latest-review-20261127.md`。

### 最终结果

- macOS / Bun 1.3.7：完整入口 **38 pass / 0 fail**（包含各子套件包装测试），日志 `.sandbox/upstream-sync-20261127/final-bun.log`。
- 独立假 CLI smoke **368 checks 全过**；Node 24.18.0 三个定向套件 **35/35**；不把包装测试数当作全部内部用例数。
- `node --check index.mjs`、`node --check cloak.mjs`、`git diff --check` 通过；`npm pack --dry-run --json` 确认 24 个发布文件，版本仍为 0.2.19。
- 新增测试覆盖了代码变更；原多账号、TOS、版本门槛、取消、续接和工具结果回归均保留并运行。测试不证明真实供应商服务可用或任何封禁效果。

### T3 最新研究摘要

已固定核对 `cbcc74737d5931c67defcb236f88d1c415fe3cb6`，研究结果在[独立报告](/Users/gold/code/agy-cli/reports/t3-agy-latest-review-20261127.md)。值得后续优先做：目录/健康检查展示版本拒绝原因、缩窄 prompt 前恢复失败分类；其次实际执行模型诊断。延迟工具代理属于独立架构工作，不在本轮顺手移植。以上是静态审查建议，不是本轮已实现功能。
