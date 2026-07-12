# 04 — 通用工具面：recall 无顶／read_doc／timeline 共享 SDK server

**What to build:** 日记与 persona 两个 SDK agent 共用同一个工具面定义，包含三件通用工具，旧 prompt 下日记 agent 即可跑通（本票不改 prompt）：

- **recall**（worker audience）：truncate 无硬顶——实现为按 audience 分流的 schema 与渲染策略，主会话 audience 的 2000 顶与行为完全不动；渲染输出过一遍 stripPrivateTags（防绕过入库剥离的历史脏数据）；单次工具返回设总量上限常量，超限截断＋「用分页或收窄选择器继续」提示。
- **timeline**：worker 侧接线，行为与主会话一致。
- **read_doc**：read_diary 改名＋作用域调整为数据根下 diary/ 与 persona/ 两棵子树的 `.md` 文本文件（config、日志、operation manifests/checkpoints、数据库均拒绝）；安全语义沿用现有日记文件读取惯例——realpath 解析＋根与目标均拒绝 symlink、UTF-8 严格解码、单文件大小上限；作用域随请求参数化（沿既有 per-request allow-set 机制），rebuild 请求下 persona/ 子树整体不可见。
- **read_turn 删除**：全文访问由无顶 recall 覆盖。

工具返回皆数据：system prompt 声明＋沿用现有结构化包装与转义惯例，覆盖 pull 通道的注入面。

**Blocked by:** None — can start immediately.

**Status:** done

- [x] audience 分流测试：worker recall 无顶可返回超 2000 字符字段；主会话 recall 的 schema 与渲染钳制完全不变
- [x] worker recall 渲染剥离 private 标签有测试锚定
- [x] 单次返回上限：超限截断＋继续提示
- [x] read_doc 安全用例：子树外路径拒绝、symlink 拒绝、超大文件拒绝、数据库文件拒绝、rebuild 作用域下 persona/ 不可见
- [x] allowedTools 恰为三件；read_turn 及其测试移除
- [x] 日记 agent 冒烟（假 SDK 缝）：三件工具可被调用并返回包装后的数据
- [x] `bun test` 与 `tsc --noEmit` 全绿

## 参考

- Spec：`.scratch/freeform-person-memory/spec.md`（「工具面（两 agent 共用一个 SDK MCP server）」一节）

## Comments

- 单次工具返回上限常量：`WORKER_TOOL_RESULT_MAX_CHARS = 100_000`（字符），超限保留继续分页或收窄选择器提示。
- audience 分流：主会话继续使用 `recallInputShape` 与默认 `MAX_TRUNCATE = 2000`；worker 使用 `workerRecallInputShape`，并在 handler 构造边界显式传入 `truncateCap: Number.MAX_SAFE_INTEGER`，同时做 private 标签剥离与总量 gate。
- `read_doc` 作用域参数形状：`allowedDocumentSubtrees: ReadonlySet<"diary" | "persona">`；日记及 persona fold/rebase 传两棵子树，persona rebuild 只传 `new Set(["diary"])`。
