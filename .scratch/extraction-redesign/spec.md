# 提取管线重设计：主 agent 自写摘要 + 段结构 + 无状态结算

Status: ready-for-agent
Rev: 6 (2026-08-08) — R1/R2 评审处置入 Rev 2–4；裁决 12–15（做笔记、琐碎判定、段锁、S/T 引用）；Rev 6 增裁决 16/17：系统文本与笔记一律英文（引用用户原文除外）、废除比喻性措辞
设计来源: S15069 T317 起的全程讨论；文献依据见 memory/reference_agent_memory_literature.md；生产实测数据内嵌于各决策条目。
评审记录: R1（job task-mskgd7po-xyukk5，17 条）处置入 Rev 2/3；R2 复审（job task-mskhrjti-ekd9m6，7P1/8P2/1P3）处置入 Rev 4。

## Problem Statement

现行提取体系的成本与故障面都长在同一个根上——**常驻 subagent 流式再摄取每个 turn 的全部内容**：

- 每个 turn 的内容付两遍钱（主 agent 一遍、提取 agent 再吃一遍），常态开销 ~7-10%；
- 常驻会话的上下文管理（/compact、resume 指针、stall watchdog）是独立故障类：compact 死亡螺旋单日烧 $36（0.8.6 仅止血）；
- 观察者归因错误：本会话实测 9 次「陈旧响应错挂到别的 prompt」，全部是从 transcript 流事后猜归属的结构性失败；
- insight 字段 56% 填充率、装满状态汇报，「都记住就是都没记住」；
- timeline 按天渲染在 325-turn 会话已 over budget；目标是 **1000-turn 级 session 仍能读出弧线与印象**（S1730：1,066 turns / 93 天 / 60 次 compact 是真实存量）。

## Solution

- **主 agent 随工具批次做笔记**（title/content/insight；行为统一命名「做笔记」，prompt 与文档措辞弃用「记忆提取」——自解释优先），它是意图的第一人称，归因错误结构性归零；漏写的 turn 排队等待后续批次，可跨 compact 与 session 间隙，不设常驻兜底；**零工具调用的 turn 判为琐碎，不做笔记**；
- **Sonnet 无状态结算**批量做全部后见工作：段归属、引用边、type/tag 纠偏、session summary 维护；
- 记忆新增**段**（与 turn 同 schema 的高层记忆），timeline 印象层渲染段脊柱（S1730 实测收敛为 34 条弧）；
- 等级取消打分，**纯派生排序**（ORDER BY 事实列）；
- worker 降级为**无 LLM 的图书管理员**（串行写库、机械捕获、触发派发）。

外部依据（均已核对一手）：harness 托管写入优于 agent 自愿（自愿 114 turn 零次，arXiv 2607.20972）；概览式注入无收益+20% 成本（arXiv 2602.11988）；收益开关是检索命中率而非存储结构（arXiv 2602.08316）；文本主题分段实测零增益（arXiv 2410.13070），改结构信号。

## User Stories

1. 作为主 agent，我在工具批次末尾用一次 remember 调用给上一个带工具的 turn 做笔记，所写即所历，无需任何观察者重建；纯对话 turn 判为琐碎，不欠笔记债。
2. 作为主 agent，我在工具结果之后（而非 turn 开头）收到待写提醒，纯问答轮永远不被记忆家务打扰，也不会被诱导发起多余的工具调用。
3. 作为主 agent，提醒里带着 turn id 与 prompt 前缀，我抄 id 即可寻址，不需要自己数轮次。
4. 作为主 agent，主任务紧要时我有明确授权跳过家务，代价只是稍后补写，不是记忆丢失。
5. 作为主 agent，被回滚的 turn 在提醒中明示「免提取」，我见过的每笔债都有可见的下场，不会因静默消失而困惑。
6. 作为主 agent，compact 之后我依然能凭 compact 摘要（必要时 replay 下钻）补写积压摘要。
7. 作为主 agent，我写 insight 时只记「有长期价值且不记就难以重获」的学习笔记，出生 turn 记一次，使用 turn 不再记。
8. 作为主 agent，我后续检索到自己写的摘要时，注意力优先命中这条为未来的我定制的索引，而不必扫描原始细节。
9. 作为结算 subagent，我每次被派发只处理**一个 session** 的一个窗口，一次调用内完成补洞、段维护、边完善、type/tag 纠偏与 session summary 更新，然后退出。
10. 作为结算 subagent，我拿到前 50 turn 的 recall 渲染、开放段列表与主题注册表作语境，判断段依附时先查后铸，铸新主题必须给出「为何无候选匹配」。
11. 作为结算 subagent，我写段身体时结论先行并按固定格式引证关键成员，这些引用被解析为段的 anchor。
12. 作为结算 subagent，我对边只做分类与补充——每条边尽量追溯到可观测行为（检索命中、文本引用、回滚事件），纯判断边单独标记。
13. 作为 worker，我全程不host任何 LLM 会话，任意时刻可重启，全部状态在 DB；优雅退出窗口内只落作业不派发。
14. 作为 worker，我在内容事件驱动下派发结算子进程；作业先落库带 claim/lease，迟到写回被 generation 校验丢弃；重试凭时间戳指数回退，封顶 3 次后标终态、游标照走。
15. 作为未来会话的读者，我看 timeline 默认得到段脊柱——1000-turn 会话收敛为几十行「章节」，每行有主 type glyph、tag、title、status 与相位轨迹。
16. 作为未来会话的读者，我用 recall 搜 `tag:X` 同时命中段记录与成员 turn，一次查询自带层次；`time=` 过滤覆盖按日期进入的需求。
17. 作为未来会话的读者，我下钻段时先看到 anchor（结算钦点的承重 turn），再按派生 rank 补齐名额，每一名次都能指出它的事实依据。
18. 作为用户，我的 `<private>` 内容经 strip 管线与指令纪律双层防护，不被主 agent 摘要带出；系统如实声明这不是绝对保证。
19. 作为用户，试运行期我能看到三个指标（遵从率、摘要盲评、compact 后错挂率）与明确的 no-go 规则，再决定切换；影子写入与生产数据完全隔离。
20. 作为用户，我旧会话的数据不被回填改写，era 边界两侧各按各的语义渲染。
21. 作为维护者，我删掉的代码（常驻会话管理、obs 摘要管线、新 era 的评分路径、独立 summary agent）多于新增的代码。
22. 作为维护者，我能从每条边的 provenance 列复算 rank，从铸造率监控发现命名漂移。

## Implementation Decisions

### D1 · 笔记通道（主 agent 亲笔的 remember 写入）

- MCP 工具新增 turn 摘要写入形态（与现有面向用户的 remember 语义区分，命名实现时定），参数恰为四个：`turn`（提醒携带的地址令牌）、`title`、`content`、`insight?`。
- **title ~20 token（建议值）**：格式 `[功能词+主题词]:[本 turn 的内容主题]`。必写「在干什么」，结论是可选尾巴（装得下一个短语才带）。功能词必须诚实反映信念状态（设计≠定稿）。前缀即弧坐标：平铺流中前缀相同 = 同车道，批量侧白拿归属草稿。
- **content ~100 token（建议值）**：结论先行、过程随后（截断消费者对齐：truncate 时露出的恰是 changelog 行）。删除测试：删掉这句结论推导还完整则删。必含真实败者（被否决的选项+理由），不记与推导无关的过程噪声。标注裁定权源（用户拍板/数据裁定/文献/推导）。预算花在专有名词上（FTS 寻址面）。
- **insight 不设限但默认空**：学习笔记——只记「有长期记住价值、且不记就难以重新获得」的知识（准入两问；琐碎/难迁移/易失效出局）。与本 turn 结论正交（结论住 content）。**记在事实的出生 turn，使用 turn 不再记**；跨会话冷重发现是合法新知，蒸馏侧把重复当 ≥2 佐证投票。insight 是语义记忆管线的原材料，非 turn 摘要的一部分。
- 语言（裁决 16）：**提示词、提醒、笔记内容一律英文**；引用用户原文时保留原语言。与既有库语料一致（历史 title/content 均为英文），token 效率更高，FTS 对两种语言均可检索。
- 试写样例（本会话 T332/T325 试写定形）：

```jsonc
note({
  turn: "S15069/T332",   // S/T id copied from the reminder
  title: "measure+note-routing: fallback share 32%→4%, deferral wins",
  content: "User correction: turns without a tool batch queue for a later one
    instead of falling back to the subagent. Measured on 10,174 turns: 96%
    eventually get a batch (89% within 3 turns); real cutoffs are compact
    (swallows 1%) and session end (3%). Deferred writing judged net-positive:
    pre-digests compact material, rehearsal effect.",
  insight: ""   // the lesson IS this turn's conclusion — fails orthogonality
})
```

### D2 · 笔记提醒协议

- 注入点：**PostToolUse**（本 turn 首个工具调用返回后），每 turn 至多一次；remember 自身的 PostToolUse 不再注入（防自激）。纯问答轮永不见提醒——提醒跟着车走，不跟着 turn 走。
- 实现约束（R1#11、R2#P2-6）：hook runner 的 `additionalContext` 与异步唤醒（asyncWork）互斥；PostToolUse 已注册两条入口，分工为**一条同步返回提醒、一条保持异步摄取**，不得并入同一 handler 响应。**台账所有权单一**：同步入口只读台账渲染提醒，一切台账写入（新增/清账/老化）唯一归 worker 异步侧。
- 触发条件：**待写列表新增**才注入；写入清项、划走清项不触发。**零工具调用的 turn 不入待写列表**（裁决 13：turn 完结时判琐碎标 skipped，永不成为笔记债；mnemo 自家工具调用不计入）——列表里只会有带实质工具调用的 turn。
- 内容：待写项 = `[S/T]` 全限定号 + prompt 前缀 + 已等待 turn 数，**展示最老 5 条**（显示上限）；回滚项出现一次并标注「已回滚，免写」后清账（台账显式闭合）。
- 措辞阶梯：1–2 条常规（跳过有授权）→ 3–4 条收回跳过授权 → 超期走 D3 老化。
- 静态纪律入注入的机制说明：主任务优先；摘要调用永远放批次末尾；不为写摘要发起本不需要的工具调用；关键数字不确定宁可不写（错误摘要会经注意力捕获遮蔽原文）；`<private>` 内容不得进入摘要。

### D2 附 · 注入原文原型（原型产物，实现按此微调）

静态机制说明（SessionStart 注入，~280 token，进缓存前缀）：

```
<mnemo-note-taking>
You keep notes on your own turns (episodic memory across sessions).
Trigger: after a tool result you may see a "pending notes" reminder. When it
appears, append a note call for the listed turns at the end of the current
batch. No reminder — do nothing. Never start a tool call just to write a note.
Skip when the main task is critical; the system will remind you again.
Fields:
- title (~20 tokens): "<activity>+<topic>: <what this turn covered>". Activity
  words (research/design/implement/fix/measure/review/write/ops) must state
  the real stage — never claim "finalized" for work still in design.
- content (~100 tokens): conclusion first, then the key steps. Include
  rejected alternatives with reasons, and who decided (user/data/literature/
  inference). Prefer proper nouns (file names, error names) over narration.
  Do not repeat the title.
- insight: study notes; empty by default. Only knowledge gained this turn
  that is worth keeping long-term and hard to reacquire — pitfalls hit,
  durable pointers, transferable lessons — and orthogonal to this turn's
  conclusion. Already-known facts, perishable state, and anything one search
  away do not qualify.
Rules: the note call always goes last in a batch; cite other turns only as
[S15069/T332] and only ids seen in reminders or injected context; omit
numbers you are not sure of; never include <private> content.
</mnemo-note-taking>
```

动态提醒（PostToolUse，列表新增才出现；升级措辞只换末行为 "Write the pending notes in this batch; skipping is no longer authorized."）：

```
<system-reminder>mnemo pending notes:
  [S15069/T332] "下一turn无工具,但是可以等到…" (pending 2 turns)
  [S15069/T333] "也就是说,主agent…" (pending 1 turn)
  [S15069/T330] rolled back — no note needed.
Append note(turn:"S15069/T332", ...) at the end of this batch; skip if busy.
</system-reminder>
```

（prompt 前缀为用户原文引用，保留原语言——裁决 16 的例外条款。实现注记：实际输出**不带** `<system-reminder>` 标签——CC 对 PostToolUse 的 additionalContext 自动包一层该标签，自带会嵌套；原型里的标签仅示意最终呈现。）

工具名候选 `note`（与裁决 12 命名一致，与面向用户的 remember 区分，实现时定）。静态部分刻意只含指令不含背景（指令被遵循、概览烧钱——文献依据同 Solution 节）。

### D3 · 排队与老化（无常设兜底）

- **琐碎 turn 先行出清**（裁决 13）：债务口径的工具计数**排除 mnemo 自家调用**（remember/recall/timeline——否则做笔记本身制造新债，R2#P2-5）；计数为零的 turn 判琐碎标 skipped（reason=trivial），不做笔记——纯对话的价值由段身体（结算后见撰写）与原文 FTS 承载。**判定点 = turn 完结事件**（下一 UserPromptSubmit 或 Stop），非创建时——创建时无法预知工具行为（R2#1）；中断 turn 同点判定。问答长跑的欠债问题就地消失。
- 笔记的消费晚于生产，故生产可排队等待后续批次：等待可跨 compact（compact 后凭 compact 摘要写——其对最近 turn 覆盖最好——必要时 replay 下钻）、可跨 session 间隙（resume 后照常补写；pending 列表在 DB 持久）。
- 积压年龄**通常**自限（实测 89% 在 3 turn 内等到批次），但这是描述不是协议保证（R2#15）——唯二硬界：提醒展示上限 5、下一条的 50-turn 截止。
- **pending 超过 50 turn → 机械标 `skipped`**，懒执行（下次读 pending 列表时判定，无启动扫描）。该规则同时收编回滚 turn 与死分支。skipped ≠ 丢失：原文、FTS、shape 信号俱在。
- 永不再续的会话尾：pending 冻结躺库，无害；其结算残留由 D9 的附带结算机制收编。
- 实测依据（全库 10,174 turn，裁决 13 前口径）：68% 在下一 turn 即有批次、89% 三 turn 内、96% 最终等到；被 compact 吞 1%、会话尾 2.9%。剔除琐碎 turn 后待写集只剩带工具 turn，等待分布只会更好。

### D4 · 机械回填与 turn schema

- 原文层照旧（hook 捕获，replay 底座）。机械列：坐标、原文、files_read/modified、tool_call_count、was_interrupted、was_rolled_back、compact_boundary_uuid、侧链归属。
- 新增机械列：`writer_model`（分桶评质量）、`ride_turn`（笔记实际写入时所在的 turn）、**`consulted_memories`**（本 turn recall/replay 实际命中的记录，**id 带类型前缀命名空间**，expanded/原文级读取为强命中）。
- status 生命周期：pending → extracted / skipped（skipped 带 reason：trivial / aged / rolled-back）。**era 治理扩展到 status 词表**（R1#8）：P1 期间新写手只落影子台账、不触碰既有 status 流转；P2 起新 turn 走新生命周期；era 按 **turn 级 epoch cutoff** 判归（R2#7，task-causality-era 先例），会话可跨代。
- 退役列：tags 判定语义（见 D5）、significance_grade（见 D8）、extraction_stall_*（宿主已死）。
- 弱模型会话的摘要照收（writer_model 落库观察，不预建质量地板——试运行数据说不可用再议）。

### D5 · type 与 tag（两级共用词表）

- **type**（功能词，多值）：`research 🔍 / design ⚖️ / implement 🔧 / fix 🔴 / measure 📊 / review ✅ / write ✍️ / ops ⚙️ / chat 💬` + **`回退`**（结论已被推翻/撤销，仅结算可写——需要后见）。生命周期状态（旧 ⏸⏳）不入 type，归段的 status。
- **tag**（主题词，多值）：主题注册表统一管理（含别名）；连续同主题延用同词；实现类工作主题名锚定 issue slug/模块名。
- 写入路径：出生时机械别名匹配 title 前缀落草稿值（近期渲染不空窗）→ 结算 Sonnet 复核补充多值 → 主 agent 新写法回收进别名表。
- 旧值不迁移语义，era 边界两侧各自渲染（grade era 先例）。

### D6 · 段（高层记忆）

- **与 turn 同 schema**：{title, content, type(多值,成员并集), tag, status}。段行 glyph = 主 type；recall 的 type:/tag: 过滤与 FTS 天然跨粒度。
- 定义：同一主题下的一次连贯工作章节；**功能切换不是边界**（type 累积，相位轨迹由成员 type 分组机械派生）；成员不要求 turn 号连续（生产实测 70% 主题弧非连续）。粒度校准锚：**日记里值得一行的单位**（S1730 实测 34 条 ≈ 印象层预算）。
- 存储：segments 表 + membership 多对多边表 + themes 注册表（name/aliases/status）。段不硬绑 session（主题跨会话）。
- 收口只剩两条命运规则：**交付收口**（发版/合并/定稿）；**静默废弃**（连续 N 个结算窗口无新成员且未交付，N 由 S1730 回放定）。同主题多年后再启 → 新段同 tag。
- **开放段 = 活文档可重写**（同 session summary 的 current 语义），段行携带 **revision**（供裁决 14 的写入 CAS）；**收口段冻结**，推翻走边（反改写：冻结历史，不冻结现状）。
- 段身体写作纪律同 content（结论先行、按 D7 格式引证成员）；解析出的引用即段的 **anchor 列表**。

### D7 · 引用格式与边

- 固定格式（裁决 15）：写端引用一律 **`[S15069/T332]` 全限定形式**（+ `[E47]` 段）——与 recall/timeline 读端语法同一套文法，读写一个格式。裸 `[T332]` 相对形式**全面废除**——R2 发现的 "coin flip" 歧义源是裸号，正解是**限定**而非全局化。解析走 (session_id, prompt_number) 唯一索引。
- **地址空间**（R1#10 → 裁决 15 终态）：对模型只有一种地址——S/T 全限定号；提醒令牌、笔记引用、结算引证同此，抄写即得。**全局 DB id 只在内部使用**（边表存储、工具解析后），永不出现在 prompt 与笔记文本中。
- 校验（0.2.34 裸引用 bug 的反向设计，R2#P2-4 落地形）：worker 维护每会话**曝光台账**（被提醒过、被注入过的 id 集）；被引 id 必须存在且在写手的曝光台账内；非法引用进日志不进边表。
- 边的四个候选来源 + 结算分类定型：检索命中（builds-on/evidence-for）、content 文本引用、回滚事件（重试 supersedes 回滚，纯机械）、结算读窗口序列补 supersedes。主 agent 从不显式写边，但其行为痕迹即边的全部原料。
- 存储：**通用边表**（节点 = turn 或段，带类型前缀的全局 id），主键 (citing_node, cited_node, relation) 幂等去重，provenance 列 ∈ {retrieval, text-ref, rollback, judged}——既有 turn↔turn 边表无法表达段级边（评审 #2，代码证实），新表收编旧数据。段级边同一 pass、同一套规则。

### D8 · 排序（零打分）

- 段内 top-N = **anchor 优先占位，剩余名额按派生 rank**（词典序 ORDER BY，非加权和——里程碑评分空结果实验的直接结论：权重从没干过活，干活的是键序）：

```sql
ORDER BY 是纠正者 DESC, type含回退 ASC,
         被引数(去重后的边入度) DESC,
         是交付成员 DESC, files_modified数 DESC, created_at DESC
LIMIT N   -- N = 渲染预算
```

- **计权去重**（评审 #16）：同一 (citing, cited) 对的 retrieval 命中与 text-ref 引用只计一次，provenance 仅供审计分层。
- 无存储分数（可物化缓存），读时可重算、逐行可解释、被引自动升权（检索即强化）。键序由 S1730 回放校准（一次离线实验，非持续债）。

### D9 · 结算（唯一的 subagent）

- **Sonnet 无状态一次性调用**，worker spawn 子进程，退出即无。**一次调用只处理一个 session 的一个窗口，永不混装**（裁决 11）。
- 触发器恰为两个：**连续 50 已提取 turn 攒满、compact**（「连续」= 自上次结算游标起，prompt_number 连续前缀全部 extracted/skipped——评审 #7 口径；50-turn 老化恰好接通连续性）。sessionEnd / resume / worker 启动 / 定时器一律不触发。
- **结算作业落库先行**（R1#1/#12、R2#5）：触发即写 durable job 行，**identity=(session, 窗口起点, 触发类型) 唯一**；认领带 lease，lease 逾期回收即消耗一次 attempt；派发子进程随后。**按 session 分区的副作用（成员边/引用边/type/tag/session summary）与游标推进在单一成功事务内提交**，写回带 job generation 校验，迟到或失败即整体丢弃；Sonnet 输出走结构化 schema（形状票级定）。compact 触发以捕获修复后的 boundary marker 为准；与连续 50 并发到期时先到先触发，同一 turn 只属一个窗口（R2#P2-2）。优雅退出窗口（60s）内只落作业不派发，作业由下次触发认领。
- **并发与段锁**（裁决 14，R2#6）：结算允许并发（本会话 + 至多 2 残留）；分区写互不相交，**跨作业唯一共享可变物是开放段**——锁做在工具侧：开放段重写在主事务内做 revision 校验，冲突段的写从本次提交剔除、随最新段身返回，结算侧仅重放该段的判断（补充小事务，不回滚已提交的分区写）；不做全局单飞（太慢，用户裁决）。
- **附带结算已关闭会话的残留**（裁决 11）：任一会话的触发事件，除结算自身窗口外，顺带查询已关闭会话的未结算残留，**每个残留会话单独派发一个结算调用**，最老优先，每次触发至多带 2 个（默认值，平滑成本），余量留给下次。**已关闭判据**（R2#3）= 无活跃 env 注册且最后活动 >24h（不建 close generation，误判竞态的损失上限是几条笔记）。**认领时先清空待写项**：残留作业认领已关闭会话时，先把其全部 pending 机械转 skipped（reason=closed）再按连续前缀开窗——该会话不会再有主 agent 补写，悬置 pending 只会堵死窗口。sessionEnd 本身仍零 LLM；已关闭会话在项目仍有未来活动时自愈，彻底弃置的项目保持不结算（既有裁决）。
- 语境装配走生产接口（防双源腐烂）：窗口 turn + 前 50 turn 的 recall collapsed 渲染 + 开放段列表 + 活跃主题注册表 + 里程碑/current session 注入构建器。不足时自行 recall 下钻，与任何读者同权。
- 职责清单：段依附判定（判定表：同主题同段续、静默久新段、无主题先搜后铸）、段身体撰写（含 anchor 引证）、边分类补充、type/tag 复核、**session summary 顺手维护**（decision/done ≈ 段收口汇总）、洞的酌情补写（skipped 停留为主，确需时凭 replay）。session summary 与段骨架注入**沿用现有预算合同为默认**（R2#P2-8），实现时只调数值不改形制。
- 防碎裂三纪律：先查后铸（prompt 要求陈述无候选理由）、段粒度密度约束（过碎合并/过粗拆）、**铸造率入监控**（每窗新主题数 = 命名漂移警报）。
- 机械先验供给、模型只确认：title 前缀、tag 草稿、文件集 Jaccard、时间间隔、成员 type 众数。
- 重试：作业行 attempts + retry_at，指数回退凭时间戳比较，**无定时器**（下次任意触发事件顺带检查），封顶 3 次，终态跳过游标照走（terminal-state-must-abandon-and-continue）。

### D10 · worker（图书管理员）

- 保留：DB 全局串行写、transcript 捕获解析、触发计数与作业派发、启动时零 LLM。
- 隐私（评审 #14 修正）：remember payload 过 **strip 管线**（与 transcript 捕获同一剥除逻辑，剥掉带 private 标记的内容）；库内无 private 明文可作子串比对，故**无绝对保证**——以指令纪律 + strip + 结算抽查三层围堵，并如实声明边界。
- 删除：常驻 agent 会话、agent compact 管理、resume 指针、agent stall watchdog、obs LLM 摘要管线、独立 per-session summary agent；里程碑评分器**退出新 era 路径**（legacy 渲染模块保留，评审 #9）。worker 生命周期全程无 LLM，上行下行对称干净。

### D11 · 渲染层

- **timeline 新 era 默认视图 = 段脊柱 + 孤儿锚点**（未归段但机械信号强的 turn 独立成行——评级轴对弧轴的安全网）；按天视图在新 era 删除（`time=` 过滤覆盖日期入口）；shape 信号保留；段内下钻按 D8。
- **recall**：新增段选择器 `E`（`[E47]`）；O 层渲染机械字段（工具名+参数前缀+结果前缀）。
- **FTS 摄取与 status 彻底解耦**（R1#5、R2#4）：机械捕获时即索引——turn 的 prompt/response 原文 + obs 截断原文（建议值：输入+输出各前 500 字符；全量 ~1.3GB 不可全索引）；status 只影响渲染不影响索引，**skipped 不删索引**（现行为删除，需改）。结算输入合同：琐碎 turn 以截断原文注入窗口（预算票级定）。
- SessionStart 注入的弧骨架改为直接查 segments 表渲染；注入预算实现时重切。
- era 边界（**turn 级**，R2#7）：按 created_at 与 cutoff epoch 比较判归——task-causality-era 的现成先例；会话可跨代（P2 前的会话 resume 后，旧 turn legacy 渲染、新 turn 走新体系），渲染按 turn 分路。旧数据只读不演化，不回填。
- replay 原文轴零改动。

### D12 · 分期与切换

- **P0（先行小补丁）**：dream agent 停运——现 config 无关停开关（R1#6，代码证实），需 enable 旗标补丁 + reload，**旗标必须门控全部三个独立入口**（R2#P2-1）。连带：diary index/persona 注入冻结在末次生成态；insight 收紧的供给约束自然解除。
- **P1（试运行，≥2 周）**：D1–D4 写入侧上线，**笔记债台账与笔记内容整体落影子侧**（R1#3、R2#2）：债务状态机（pending/提醒/清账/老化/回滚免提取）、笔记三字段、writer_model、ride_turn 全在影子表体系内运行，turn 全局 id 唯一键、清账幂等，**不触碰 turns 行与其 status**——旧管线继续独占既有状态流转；对 remember 工具调用的观测标记排除；盲评离线读双源。no-go 形式先行固定（R2#P3）：遵从率低于阈、盲评劣率高于阈、错挂率未降，三条**各自独立成立即 no-go**（停留 P1 或关旗标回退，不带病切换）；阈值数值由首周基线定（R1#17）。
- **P2（切换）**：达标后 D5–D11 上线，影子表数据转正为切换后新 turn 的正式写路（影子期存量仅供对比，不转正），D10 删除清单执行，era 边界落此。
- **P3（后续票）**：dream/diary 按新供给接口（段记录 + insight 池）重造复运，单独 spec。重启时注意（交叉审查 P3）：停运期 needs_regen 仍在累积，而 backlog 默认只保最新日期、旧日期会被静默终态化——P3 重启方案必须显式处置停运债务。

### D13 · 0.8.4 及既有机构的继承与废止（评审 #13 补全）

- **继承并收编**：K=50 结算节奏概念；渲染器的单元预算核心（选择逻辑除外——「统一渲染器」实为耦合 effGrade/前件拉入/日分组的复合层，只有预算核心可整体继承）。
- **收编重造**：turn_citations 数据迁入 D7 通用边表。
- **P2 废止（仅新 era 路径）**：两阶段评分、机械只确认降级、effGrade 判定语义、MCP remember 旧形态的 grade/regrade/cites 强制、worker reprime 的 G4/G3 任务骨架（改查 segments 表）、SessionStart 独立 milestones 注入（并入段骨架注入）、SessionEnd tail 结算作业（职能由 D9 的残留会话附带结算替代）。
- **legacy 保留**：旧 era 渲染路径全套（含评分选择），只读不演化。
- **明确不动**：`claim_generation`（属 transcript 修复账本，非弧脊柱机构，评审纠正，不得连坐）；rules/persona/diary 本体（评审核查无字段级断裂）。

## Testing Decisions

- **主缝 = worker 模块边界**（既有：fake clock + 存根派发，先例为 compact-recovery 测试套；HOME 沙箱 preload 已建，main() 必传 dataRoot）。新逻辑全部是纯码，落在这条缝后：
  - pending 台账与提醒构建：列表新增才触发、每 turn 至多一次、remember 不自激、展示上限 5、回滚免提取行、台账闭合、同步/异步双入口分工；
  - 老化懒执行：50-turn skip 判定在读取时发生、与「连续 50 已提取」触发的咬合；
  - 触发与派发：恰在 {50 连续, compact} 派发、**显式断言 sessionEnd/resume/启动不派发**、残留会话附带结算（单独派发、每触发上限 2、最老优先）、优雅退出窗口只落作业不派发；
  - 结算作业状态机：claim/lease/generation、迟到写回丢弃、时间戳回退、封顶 3、终态跳过、事件驱动认领；
  - 引用解析与校验：三种格式、本会话缺省解析、非法/来路不明引用拒收进日志；
  - 别名归一与 type 草稿：前缀匹配、匹配不上落 unknown、回退值仅结算可写；
  - rank：ORDER BY 确定性、anchor 优先占位、(citing,cited) 跨 provenance 去重；
  - 影子表隔离：P1 写入不触碰 turns 行、观测排除标记；
  - 隐私 strip：remember payload 过剥除逻辑。
- 好测试只测外部行为：给 handler 喂事件序列，断言 DB 行与派发调用，不窥探内部状态。
- 结算的判断质量（段依附、anchor 选择、边分类）**不进单测**，走离线回放 eval（S1730 + 私有 dump，先例为里程碑验证器）。
- 渲染：段脊柱与 E 选择器沿用现有 timeline/recall 渲染测试形态，era 双路快照。

## Out of Scope

- dream/diary 管线重造与复运（P3 单独 spec；本 spec 只承诺供给接口）。
- 旧数据回填、旧 grade/type/obs 摘要的语义迁移。
- rank 键序与静默 N 的最终取值（离线实验定，见 Further Notes）。
- content ~100 token 的检索充分性验证（十题召回重跑，实验项）。
- 博客文档（S15069 另一条线）；生产库三个卡死会话的清理。

## Further Notes

**用户裁决记录**（均在 S15069；T325–T335 已对库核实，T336 起为推算号，以入库后 timeline 为准）：

1. 主 agent 提取 + subagent 结算的总方向（T327）；兜底裁定为基本不需要（T349）。
2. 抛弃每 turn 一条记忆的均匀提取观 → 段/事件形态（T319/T330）。
3. 评级取消打分、纯派生（T320）；「打等级 = 写事实 + 算术」（T351）。
4. title 不硬写结论，主写在干什么（T338）；三字段预算 20/100/不设限为建议值（T339）。
5. insight = 学习笔记，两问准入（T341）；出生 turn 规则（T340）。
6. 段与 turn 字段统一、设计+实现合并一段（T355）。
7. 触发纯事件驱动，sessionEnd/resume/启动不触发（T353/T354）；50-turn 超期 skipped（T350）。
8. 回滚 turn 展示但免提取（T351）。
9. content 引用识别承重 turn（T360）。
10. 试运行后切换、dream 先停运、结算默认 Sonnet（T361）。
11. **残留会话结算**：sessionEnd 不触发；其他会话的 compact/连续 50 触发时附带处理已关闭会话残留，**每会话单独一个 subagent，不混装**（T369）。
12. 行为命名「做笔记」，prompt 与文档措辞弃用「记忆提取」（T370）。
13. **零工具调用 turn 判琐碎，不做笔记**——判定点为 turn 完结事件，价值由段身体与原文 FTS 承载（T370）。
14. **段并发冲突在工具侧做锁**（revision CAS），不做全局单飞——太慢（T372）。
15. **引用统一 S/T 全限定格式**，与 recall 读端同一文法；全局 id 只留内部——歧义源是裸相对号，正解是「限定」而非「全局化」（T374）。
16. **系统文本一律英文**：提示词、提醒、笔记内容全用英文，引用用户原文时保留原语言（T376）。
17. **措辞纪律**：spec 与提示词废除比喻性表达（顺风车/等车等），用正式直述（T376）。

**待跑实验**：rank 键序校准（S1730 回放对照已知里程碑）；静默废弃 N（同回放）；content 压缩十题召回（截断版下界+改写版真值）；P1 首周三指标基线与 no-go 阈值。

**监控随行**：遵从率/兜底率曲线（免费注意力压力表）、主题铸造率（命名漂移警报）、insight 填充率（准入遵守度指标，预期 56%→10-20%）。

**关键风险与围堵**：错误自摘要经注意力捕获遮蔽原文（D2 静态纪律 + 结算 replay 抽查 + P1 盲评）；命名漂移（注册表 + 先查后铸 + 铸造率监控）；「用摘要写摘要」净负（段身体必带 anchor 指针、下钻路径完整、eval 有对照）；隐私非绝对保证已明示（D10）。
