# Spec: 规则笔记（rule notebook）——结构化经验的归纳、推送与评审闭环

Status: draft（v2——按外部评审补齐六项实现协议，待用户复核后晋升 ready-for-agent）

## Problem Statement

dream agent 每晚在日记里产出的「反思」已经是高质量的经验归纳（claim + `[S/T]` 引用 + 置信度标注），但这条通道目前只写不读：反思沉底在每日文件里，不进任何注入通道，对后续会话的行为零影响。同时它没有身份与生命周期——同一条规则在 13 天里被独立重新归纳过六次（「可溯源材料比抽象结论更易换来认可」），标注「待验证」的假设从未被回访；而已有的全量注入记忆（MEMORY.md、persona）存在遵从失败：教训躺在库里，当班 agent 在最需要它的时刻想不起来（「Bash 必须设 timeout」在有记忆的情况下仍被违反过）。

## Solution

把经验从散文升级为带主键的规则行，存入 mnemo DB；dream agent 夜间分析当天轨迹，经结构化工具提出经验假设（hypotheses）入库；规则的触发条件编译成索引，由三个静态注册的 hook 分发器在运行时匹配（用户 prompt 关键词、工具调用参数、工具结果特征），命中即以 tips 形式注入当班 agent 上下文（additionalContext，用户不可见），实时引导行为；每次命中向 sidecar 追加一条带唯一 ID 的 hit 记录。次晚 dream agent 经幂等摄入取得 hit，按身份信息（非单纯时间戳）解析到具体 turn，用新增的有界读取工具下钻轨迹，判断该次注入是否发挥了正面作用（遵从≠有用），给出开放词汇的判断标签并计数，并据此调整规则（驳回、替换、优化、采纳等）；被驳回/替换的规则留作墓碑，杜绝重复发明。无触发条件的规则渲染为摘要，作为 SessionStart 注入的一个新增区块（独立预算），dream agent 的 experience 文档同时退役。

## User Stories

1. As a 当班 agent, I want 在执行 Bash 前收到「该场景须设 timeout」的 tip, so that 我在犯错之前而非复盘之后被提醒。
2. As a 当班 agent, I want 在工具结果出现已知错误特征（如连接错误）时收到对应诊断经验, so that 我不重蹈「瞬时错误被终态化」这类已付过学费的弯路。
3. As a 当班 agent, I want 用户 prompt 涉及特定任务类型（如成本异常归因）时收到相应方法论提醒, so that 我先校准计量再谈因果。
4. As a 当班 agent, I want 每条规则每会话至多注入一次、单事件至多两条, so that 上下文不被重复提醒污染。
5. As a 当班 agent, I want 注入的 tips 对用户终端不可见, so that 引导不打扰用户的阅读流。
6. As a dream agent, I want 通过结构化工具提出新经验假设, so that 我的归纳被 schema 校验、判重与记账，而不是散文一次性沉底。
7. As a dream agent, I want 提出的假设与全库（含墓碑）按相似度自动判重并强制表态, so that 我昨晚驳回的坏规则今晚不会被我重新发明，重复归纳自动转为既有规则的佐证累积。
8. As a dream agent, I want 一个返回待评审 hit 及其已解析 turn 的读取工具, so that 我不必自行拼装定位逻辑。
9. As a dream agent, I want 一个有界的 turn 细节读取工具（先报真实长度，再按需取内容）, so that 我能在预算内下钻大轨迹。
10. As a dream agent, I want 对每次 hit 提交开放词汇的判断标签并附理由, so that 上线后的计数分布可审计、可回溯，为后续校准硬规则提供数据。
11. As a dream agent, I want 判断之外附带结构化调整动作（驳回/替换/优化/采纳等）, so that 规则库随实践证据持续收敛而非只增不减。
12. As a dream agent, I want 规则带作用域（全局或特定项目目录）, so that 钢琴评分器的经验不会被注入到 mnemo 发版会话里当噪音。
13. As a 用户, I want 推送规则总量有确定的名额与淘汰算法, so that 每条规则的 hit 样本集中、夜间评审的判断有统计意义。
14. As a 用户, I want 分发器热路径有硬延迟预算与可复现的度量方式, so that 记忆系统不拖慢我的每一次工具调用。
15. As a 用户, I want hit 记录经 rotate + 幂等摄入 + checkpoint 后才清理, so that 校准所依据的计数既不静默丢失也不重复。
16. As a 用户, I want 无触发条件的认知型经验进入会话开头的独立摘要区块, so that 「涉及排他性断言先自问」这类无法机器触发的规则仍有送达通道。
17. As a 维护者, I want 规则增删只写 DB 并重渲染索引、hook 注册一次性静态安装, so that 规则变动不产生 settings 配置抖动、不依赖会话重载。
18. As a 维护者, I want 所有生命周期变更以事件账本记录前值与后值, so that 出现争议判断时可以重建完整决策链。
19. As a 维护者, I want 触发谓词是受限声明式词汇（初版无正则）, so that 不存在 ReDoS 与任意代码执行面。
20. As a 维护者, I want 幂等键覆盖 dream 侧全部写操作, so that dream 运行中途失败重试不产生重复 evidence/judgment。

## Implementation Decisions

### 数据模型

**`rules` 表**，一行一条经验：

- `id` 主键；`name` 唯一短别名（kebab-case）
- `claim` 规则正文（≤300 字符）：一句可证伪的「条件→动作」祈使句
- `rationale` 起源机制；`scope`：`global` 或项目目录绝对路径
- `trigger_kind`：`prompt` / `tool` / `result` / `none`；`trigger_spec`（JSON，≤1KB，schema 见下）
- `status`：`provisional` / `confirmed` / `refuted` / `retired` / `digest_only`；**refuted 与 retired 是墓碑，永不删除**；`digest_only` 用于超出推送名额的降级（可逆）
- `evidence` JSON 数组 `{ref, note, at}`；重复归纳向此追加
- 时间字段沿用项目惯例 **epoch 秒**（`created_at_epoch` / `updated_at_epoch` / `last_evidence_at_epoch`）；任何毫秒字段必须带 `_ms` 后缀
- 初版不含 `mode` 与 `graduated_to`

**`trigger_spec` discriminated union**（by `kind`，初版全部无正则——安全子集问题整体消解）：

```text
{kind:"prompt",  keywords: string[≤8, 每词≥3字符], match:"any"|"all" (默认 any),
                 大小写不敏感（CJK 无此维度）}
{kind:"tool",    tool: string(精确工具名), require_param?: string, param_absent?: string,
                 command_prefix?: string[≤4]（Bash 子命令前缀匹配）, path_glob?: string
                 （glob 相对 session cwd；比较前双方均规范化为绝对路径）}
{kind:"result",  tool?: string, patterns: string[≤4, 每条≤64字符]（固定子串，OR 语义），
                 只扫描结果头部 8KB}
```

**`rule_events` 表**——统一事件账本（hit、judgment、生命周期变更同表）：

```text
id（主键）, event_uid（全局唯一幂等键）, rule_id, event_kind,
source_event_id（judgment → 所评审 hit 的外键；其余为 NULL）,
turn_ref, label（开放词汇）, rationale, adjustment_json,
status_before, status_after, created_at_epoch
```

- hit 事件由夜间摄入写入（`event_uid` = sidecar 内的 hit_id，天然幂等）；judgment 经 `submit_judgment` 写入并以 `source_event_id` 指向 hit；替换/优化等调整在 `adjustment_json` 内携带结构化载荷（含 replacement rule id、改写前后 claim）；一切 status 变更记录前值与后值。

**判重算法**（`propose_rule` 内置）：入参 claim 对全库（含墓碑）做 trigram 相似度检索（复用现有 FTS 基础设施），相似度超阈值即拒绝并返回候选列表——命中墓碑附当初驳回理由；命中活跃规则提示转为 `add_evidence`。dream agent 若坚持新建，必须重新提交并携带 `distinct_from: [id...]` 显式表态（进事件账本供审计）。名称精确重复直接拒绝。

**推送名额与淘汰**：会话候选池 = 全局规则 + 当前项目规则；池内可推送规则（`provisional` 与 `confirmed` 均占名额）≤10。超额时按确定性优先级淘汰：`confirmed` 优先于 `provisional`，同级按 `last_evidence_at_epoch` 新者优先；被挤出者降级为 `digest_only`（不删除，名额空出时按同一优先级回补）。

### 运行时推送（三个分发器）

- 注册为现有 hook 命令入口的新子命令，事件为 UserPromptSubmit、PreToolUse、PostToolUse；**需要一并泛化现有 hook 输出层**——当前输出契约把事件名硬编码为 SessionStart，须扩展为按事件参数化（这是对既有契约的修改，不是纯新增）。
- 注入通道 additionalContext（经 CC 源码验证三事件均支持；Claude 可见、用户不可见）。
- 节流：每规则每会话至多一次（会话级状态文件）；单事件至多两条。
- 延迟预算与度量：分发器全程 p95 ≤ 50ms。度量协议——固定 fixture（满额 10 条规则的索引）、预热后连续 100 次采样、取 p95 断言；不以单次 wall-clock 为准。
- **hit sidecar 协议**（零丢失且不重复）：
  1. 每条 hit 带全局唯一 `hit_id`（uuid），记录 `content_session_id`、事件类型、`ts_ms`、命中规则 id，以及**身份信息**：tool 事件记工具名 + `tool_input` 前 200 字符的摘要（hook 输入若提供 tool_use_id 则一并记录）；prompt 事件记 prompt 前 200 字符摘要；
  2. 追加写按日活跃文件（O_APPEND）；
  3. 夜间摄入前先**原子 rotate**（rename 活跃文件，新 hit 落到新文件），绝不原地清空；
  4. 摄入在单个 DB 事务内按 `hit_id` 幂等 upsert；
  5. 成功提交 checkpoint 后才删除 rotated 文件；崩溃后文件保留、重放安全。
- **hit→turn 解析器**（夜间，不进热路径）：`content_session_id` 映射到 session 行；tool 事件按（session、工具名、`tool_input` 前缀摘要）匹配 observations，时间戳仅作同值裁决；prompt 事件按 `user_prompt` 前缀摘要匹配 turn。无法解析的 hit 标记 `unresolved` 保留并计数，不静默丢弃。时间戳不作为唯一定位依据（DB 时间为秒粒度、同秒多 turn、`updated_at_epoch` 会被覆盖）。

### 夜间闭环（dream agent）

- **写路径**两个结构化工具：`propose_rule`（判重内置，见上）与 `submit_judgment`（`rule_id` / `source_event_id`(hit) / label 开放词汇 / rationale 必填 / adjustment 可选结构化载荷）。**所有写操作携带幂等键**（`event_uid` 由入参内容决定性生成），规则写入独立即时提交，**不与日记文件事务原子一致**——dream commit 失败重试时靠幂等键去重，不回滚规则写入。
- **读路径**两个新工具（需注册进 dream agent 工具面、允许列表与预算合同——现有工具面只有 recall/timeline/read_doc/commit 等，无轨迹读取能力）：
  - `list_rule_hits(date)`：返回该内容日待评审 hit、所属规则、解析出的 turn_ref（含 unresolved 标记）；
  - `read_turn_detail(turn_ref, opts)`：返回 turn 三段文本与 observations，默认截断、永远先报真实长度，语义与既有 raw 轴 CLI 一致。
- 「有用」判定原则：**遵从≠有用，只有正面作用才算**；初版不预设晋升/降级硬规则——每 hit 一个判断标签 + 必填理由 + 计数，硬规则等上线后按分布校准。

### 摘要投影（C 层）

- `trigger_kind = none` 与 `digest_only` 规则渲染为摘要文档。**注入为 SessionStart 的一个新增独立区块**（现有注入不含 experience 内容，不存在可复用的槽位——这是新增区块，不是替换）：独立预算 500 token，不挤占 RecentSessions + DiaryIndex 共享池。dream agent 的 experience 文档产出同时退役。

### 发布产物

- 发布守卫覆盖：分发器脚本、索引 renderer 及索引 schema。**用户 DB 动态渲染的触发索引本身是运行时产物，不是发布产物**，不入守卫。

## Testing Decisions

- 只测外部行为。两条契约缝覆盖两个进程（seam 决策经用户确认），其下为 store 与纯函数：
  1. **运行时侧**：hook 子命令契约——stdin 事件 JSON fixture → 断言 stdout additionalContext（命中/不命中/去重/双条上限/名额淘汰后不推送）与 sidecar 追加行（含 hit_id 与身份摘要）。输出层泛化后须回归三事件的 hookEventName 正确性。先例：现有 hooks 处理器测试。
  2. **dream 侧**：四个工具在函数层测——propose_rule 的判重拒绝/墓碑理由回带/distinct_from 表态入账、submit_judgment 的幂等重试不重复、list_rule_hits 的 unresolved 标记、read_turn_detail 的截断与长度元数据。先例：diary 域测试。
- 支撑层：双表 store 沿用 db store 测试模式；索引渲染、sidecar rotate+幂等摄入（含崩溃重放：rotated 文件存在时重复摄入结果不变）、hit→turn 解析器（同秒多 turn、unresolved 路径）各测输入输出。
- 延迟按上文度量协议做基准断言，不做单次 wall-clock。

## Out of Scope

- enforce/deny 拦截模式及其手动晋升流程（初版 tips-only）。
- 规则「毕业」为独立 hook / CI 检查的机制与 `graduated_to` 字段。
- 晋升/降级/淘汰的硬阈值状态机——待 `rule_events` 计数分布校准（名额淘汰的确定性算法除外，已定案）。
- 整个系统的 kill 门指标（用户裁决暂缓）。
- 触发谓词的正则支持（初版固定子串；含 ReDoS 防护在内的正则安全子集随之整体出栈）。
- UserPromptSubmit 的语义/embedding 匹配。
- 视觉参照类证据的存档。
- 逐规则修改 settings/hook 配置的任何形式。

## Further Notes

- 设计依据的实证：22 篇日记反思分析（六次重复归纳、四天连续同构教训、「待验证」零回访、反思通道零注入）；S13090 与 S11231 的 turn 表验证纠正弧可从轨迹表层识别。
- 墓碑红线出处：判重必须对含墓碑全库做，否则被驳回规则每晚重现。
- v2 修订说明：初稿的两处事实错误已订正——项目 epoch 惯例为秒（初稿误作毫秒，同一错误曾进入 raw 轴 CLI 并已修复）；现有注入不存在 experience 槽位（改为新增独立区块 + 独立预算）。hook 输出层泛化被确认为对既有契约的修改。六项实现协议（触发语言、事件账本、sidecar 幂等、turn 解析器、dream 读取面、度量方式）为 v2 新增定案。
- Open item（预登记 kill 门）：观察期、失败判据、判死范围暂缓。风险共识：校准决策全押在计数上，判据后定存在护假设倾向。
- 上线依赖：hook 配置新增随插件发布并重载后生效。
