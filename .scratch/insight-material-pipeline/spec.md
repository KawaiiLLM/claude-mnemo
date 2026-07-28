# Insight 材料管线：提取端扩类 + dream 素材贯通 + 规则证据硬校验

**Status:** ready-for-agent
**Rev:** 2 — 吸收外部评审：证据存在性校验、处理顺序固定、提示词组装断言、交付边界澄清
**Date:** 2026-07-28
**Origin:** S15069 尾段设计讨论（自我 grill → 用户 reframe 定案）

## Problem Statement

规则挖掘系统上线一个完整版本后，8 条产出规则里 0 条 tool 触发类：工具层的反复踩坑（`timeout` 命令缺失、codex CLI 反复摸索）从未被挖成规则。根因是一条断裂的供给链：提取 agent 其实已经在 insight 字段产出机制级教训（填充率 57%），但 dream 的每晚素材把这个字段加载后丢弃，dream 从来没见过任何一条 insight；同时自我修复的摩擦（报错→摸索→绕过→成功）在 turn 摘要里被成功叙事抹除，insight 的现行定义（"key lessons"）也没把这类摩擦当成教训。另一端，规则证据允许同一 session 的引用堆积，已产出两对近重复、过拟合单次情境的琐碎规则。

## Solution

打通并硬化「提取 agent 供给关键材料 → dream 消费归纳」的通道，三处最小改动、零新机制：

1. **提取端扩类（sensing）**：insight 的定义扩为「所有对未来可能有用的、可推广的发现/经验/教训」，并把工具报错、反复摸索、重复操作、环境事实列为典型特征——自我修复的摩擦不再因结局成功而被抹除。
2. **素材贯通（transport）**：dream 每晚素材在 extracted turn 上渲染 insight（仅非空时），dream 无需额外工具调用即可看到当天全部机制级教训。
3. **证据硬校验（归纳质量门）**：propose_rule 在工具端强制新规则 ≥2 个不同支撑 turn，全局规则须跨 ≥2 个不同 session——琐碎与过拟合规则在入口被机械拒收，不依赖提示词遵从。

跨月复发证据的聚合面复用现有全文索引（insight 已入 FTS，recall 可检索），不新建 schema。

## User Stories

1. 作为用户，我希望工具层的反复踩坑（命令缺失、CLI 误用、环境陷阱）能被自动沉淀为规则，从而不在新会话里重复付出摸索成本。
2. 作为用户，我希望每条规则必须有真实复发证据支撑，从而不再收到琐碎、过拟合单次情境的规则提示。
3. 作为用户，我希望这三处改动不引入新表、新状态、新触发机制，从而系统的概念完整性不被稀释。
4. 作为提取 agent，我需要 insight 的定义明确覆盖工具报错、反复摸索、重复操作、环境事实，以便自我修复的摩擦不再被成功叙事抹除。
5. 作为提取 agent，我需要 insight 保持现有的短条目格式约束，以便扩类不导致字段膨胀。
6. 作为 dream agent，我需要在每晚素材里直接看到当天各 extracted turn 的 insight，以便不经额外工具调用就掌握机制级教训。
7. 作为 dream agent，我需要素材中 insight 内的内部 turn 引用被改写成公开 [S/T] 格式，以便直接把它们转成规则 evidence 引用。
8. 作为 dream agent，我需要 propose_rule 在证据不足时给出结构化拒绝而非异常中断，以便决定补证据、缩小 scope 还是放弃。
9. 作为 dream agent，我需要被明确告知可用 recall 检索历史 insight 收集跨 session 复发证据，以便满足证据门槛。
10. 作为主会话 agent（规则提示的消费者），我希望被注入的规则都以 ≥2 次真实复发为底，从而值得为其消耗上下文预算。
11. 作为维护者，我希望 evidence ref 的格式被工具端强制校验，从而「不同 turn / 不同 session」可机械计算、不依赖字符串约定。
12. 作为维护者，我希望 insight 渲染复用现有字段的 token 预算、截断与隐私剥离逻辑，从而 dream prompt 预算可控且无新泄露面。
13. 作为维护者，我希望仅非空时才渲染 insight 字段，从而不为约四成的空字段付任何 token。
14. 作为维护者，我希望给既有规则补证据的流程不受新门槛影响，从而已有 provisional 规则可以继续被增强而非卡死。
15. 作为维护者，我希望素材渲染的改动不影响 content-day watermark 语义，从而不触发多余的 dream 重跑。
16. 作为用户，我希望证据门槛对「全局规则」额外要求跨 session，从而声称普适的规则必须拿出跨情境的证明。

## Implementation Decisions

**A. 提取指令（insight 定义扩类）**

- insight 定义从 "key lessons" 扩为：所有对未来可能有用的、可推广的发现/经验/教训；工具报错、反复摸索、重复操作、环境事实是典型特征，即使本 turn 最终自我修复成功也应记录。
- 格式约束不变（1-3 条、每条 ≤50 字符、"- " 前缀），防止扩类导致膨胀。
- 只改定义与特征列举，不新增字段、不引入独立的「摩擦标注」通道（此前已在讨论中否决）。

**B. dream 素材渲染（insight 贯通）**

- extracted 分支在 summary 之外渲染 `insight` 键，仅当 insight 非空；非 extracted 分支不变。
- insight 走与现有字段相同的处理链：隐私剥离、每字段 200 token 预算截断、内部 `[T<n>]` 引用改写为 `[S<n>/T<m>]`。
- 内部引用收集（决定哪些 turn id 需要解析成公开引用）的扫描范围从 title/content 扩到 insight。
- 预算影响：约 100 turn/天 × 57% 非空率 × ~60 token ≈ 每晚 +3–4K token，接受，不设新的独立预算。
- content-day watermark 已包含 insight 输入，渲染改动不改变 watermark 语义，无迁移。

**C. propose_rule 证据硬校验**

- 新建规则（无 add_evidence_to）时强制：
  - evidence 数组 ≥2 项；
  - ref 必须匹配 `^S\d+/T\d+$`；
  - 每个 ref 必须解析到真实存在的 turn（session 存在、且该 prompt_number 的 turn 归属于它）——悬空引用（如 S999/T999）拒收；
  - 去重后 ≥2 个不同 turn ref；
  - `scope` 为全局时，ref 须跨 ≥2 个不同真实 session。
- 校验位置：仅在 propose_rule 处理器的**新输入边界**（独立的更严输入校验），不收紧共享的 evidence 持久化 schema——存量已持久化的 evidence 与既有事件重放必须继续可解析。
- 处理顺序固定（消除实现自由度）：既有边界检查（目标规则存在、tombstone、event uid——语义与现状完全一致，不改 throw 行为）→ 新增证据校验（结构化拒绝）→ 判重（结构化拒绝）→ 写入。含义：证据不足时不做相似度比对；「证据不足且撞判重」的提案先收到 insufficient_evidence。
- 校验失败沿用判重的结构化拒绝先例：`{ status: "rejected", reason: "insufficient_evidence", detail: <缺什么> }`，不 throw。dream 收到拒绝后可补证据重提、缩小 scope 或放弃。
- `add_evidence_to`（给既有规则补证据）不受数量/跨 session 门槛约束，但逐项校验 ref 格式与真实存在；存量规则不回溯执法。
- 校验放在工具端（与判重同层）；DB 层触发器不加新约束——evidence 门槛只针对 propose_rule 入口这一个写入面，工具端单层足够。
- 门槛的诚实边界：机械保证的是「≥2 个真实存在的不同 turn（全局规则跨 ≥2 个真实 session）」，是必要条件而非充分条件——同一事件拆成相邻两个 turn（项目级规则）仍可能通过；「引用确实支撑该主张」的语义判断仍由 dream 负责。

**D. dream 夜间提示词（归纳段一行）**

- 规则归纳段新增一条：提出规则前，用 recall 检索历史（insight 已入全文索引）收集跨 session 复发证据；证据不足的假设不要提交。
- 这是使 C 可满足的最小配套——工具端门槛负责拒收，这一行负责告诉 dream 去哪里找合格证据。不加更多流程指令。

## Testing Decisions

- 好测试只断言外部行为：给定输入行/工具参数 → 断言渲染输出/接受与拒绝结果，不测内部实现（不断言 SQL、不断言相似度算法内部）。
- **接缝一：素材渲染纯函数**（先例：diary-material 现有渲染测试，内存 SQLite 直测纯函数）：
  - 非空 insight 的 extracted turn → 输出含 insight 键，内容经截断与引用改写；
  - 空/NULL insight → 输出不含该键；
  - 超预算 insight → 按 200 token 截断；
  - insight 内 `[T<n>]` → 改写为 `[S/T]`（含引用收集扩展到 insight 的验证）；
  - 非 extracted 分支输出与现状逐字节一致（回归保护）。
- **接缝二：propose_rule 工具处理器**（先例：dream-write-tools 现有测试，覆盖判重与幂等）：
  - 0/1 条 evidence → 结构化拒绝；
  - 2 条 ref 指向同一 turn → 拒绝；
  - 全局 scope + 2 个不同 turn 但同一 session → 拒绝；
  - 全局 scope + 跨 2 个 session → 接受；
  - 非法 ref 格式 → 拒绝且 detail 指明格式问题；
  - 悬空引用（格式合法但 session/turn 不存在或归属不符）→ 拒绝；
  - add_evidence_to 路径带 1 条真实 evidence → 仍接受（数量/跨 session 门槛豁免）；
  - 证据不足且与既有规则相似的提案 → 先收到 insufficient_evidence（处理顺序测死）；
  - 存量已持久化的 evidence（含非规范 ref）在读取与事件重放路径仍可解析（回归保护）。
- **接缝三：提示词组装断言（轻量）**：不断言完整文案，只断言组装结果——提取指令包含 insight 扩类的关键类别锚词（工具报错/反复摸索/环境事实），dream 夜间提示词包含「用 recall 收集跨 session 复发证据」的指示。目的：防止「测试全绿但生产提示词没变」；措辞可自由重写，锚词变更时同步更新断言。
- 全部测试遵守 HOME 沙箱先例（测试预载重定向 HOME，禁止触真实数据目录）。

## Out of Scope

- **发布组合与 kill 门**：本 spec 的交付边界是 A–D 全部实现＋测试（见 Further Notes 交付说明）；但以哪种组合发布启用（先只启用 B 当分辨实验、还是一次全上），以及「N 周 0 条跨 session tool 规则则回退」的门槛数值——用户明确挂起（「先别急」），不在本 spec 内决定。
- 机械 Bash-error 谓词审计器（测 insight 摩擦召回率）——降级为将来可选项。
- 既有规则清理：两对近重复（判重失效产物）与全员 provisional 的生命周期停滞，另行处理。
- 判重算法本身的改进（阈值、比对字段）。
- 工具级失败（Edit/Read 类错误）不落观测记录的缺口。
- 存量 turn 的 insight 回填、存量 evidence 的 ref 格式回溯修正。
- dream 对 insight 的独立聚合工具（复用 recall 即可，不新建）。

## Further Notes

- 环境事实三条（timeout/gh/wrapper/python）已于 2026-07-28 硬编码进全局 CLAUDE.md「本机环境」节，不押在本管线上；本管线的价值主张是覆盖**未来未知**的教训总体，不是重挖已知事实。
- 「跨 session」要求当前绑定在全局 scope 上；若用户意图是所有规则一律跨 session，校验条件是一行改动，实现前可再确认。
- A 改的是提取 agent 的行为倾向，存在权重漂移风险（此前有 grading 漂移先例）：扩类后应观察摩擦类 insight 的捕获率与整体填充率是否失衡——这属于挂起的观察方案，不阻塞实现。
- insight 已参与 content-day watermark 哈希与 FTS 索引（extra 列），两处均无需改动；若将来清理 insight 字段，watermark 是隐藏联动点。
- 交付边界：A–D 四项全部实现并通过测试，按可独立发布的粒度组织提交（B 渲染、C 校验、A/D 提示词各自成组），使挂起的发布组合决策无需返工；提示词与渲染改动必须重建插件运行产物（worker 打包件）才会进入实际运行，重建属于交付的一部分。
