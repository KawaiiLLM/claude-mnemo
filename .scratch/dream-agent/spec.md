# Dream agent：日记＋记忆合并为单一夜间 agent，人味记忆＋分层遗忘（release 0.4.0）

Status: ready-for-agent

> 增量 spec：建立在 0.3.3「free-form 人物记忆」之上，是一次架构反转。0.3.3 的 free-form 双文档、动态注入加载器、三工具面（recall/timeline/read_doc）、可解析子集契约继续有效；**被取代的部分**：diary 与 persona 拆成两个 agent、persona 的 fold/rebase 生命周期、generations、rebuild_request/confirmed_epoch 与 persona 操作状态机、terminal tombstone、发布 token 预算校验、日记材料的「全量 title-only 清单」、DIARY_V2 三节抽取式产出。设计参照 CodeClaw 的 sakiko 实现（一个夜间 agent 一趟写日记并更新记忆）与其 `memory/user-profiles.md` 的人味质量标杆。设计哲学延续 bitter-lesson「给机制、不给知识」，并新增一条：**记忆是就地演进的活文档（像人脑），不是日记的确定性折叠视图**。

## Problem Statement

0.3.3 把人物记忆做成了 free-form，产出质量比 0.3.0 好，但结构上仍有三处代价，且它们互相加剧：

1. **两个 agent＋有损中间层，让记忆被稀释两次。** persona fold agent 读的是**日记**（摘要的摘要），而日记本身对 extracted turn 只拿到一行标题——原始素材经「turn→日记摘要→persona fold」两跳，人味信号在每一跳流失。实测：一次日记运行只 recall 了 5 个 turn，且 `depth=expanded` 不带 truncate、每字段卡 200 字符，等于目录读全了、正文几乎没读。
2. **fold 生命周期是一整类自找的失败面。** 0.3.2 那场挂死（rebase 越重试输出越大→三振→terminal tombstone→死锁全部 persona 维护）根源就是「独立的、有预算校验的、周期性的 fold 阶段」。sakiko 没有这套机制，因为它每天只做增量维护，也就没有这类 bug。
3. **记忆记成了工程流水账。** 现行画像开头是「用户同时并行推进多个技术与设计项目——法律RAG(ustcthesis)、KawaiiLLM、llm-portfolio……」——工程化的项目清单，且与 experience.md 重复。对照 sakiko 的 `user-profiles.md`，人味来自它记的东西：性格价值观、逐字原话（「越封我就越想破解」）、生活事件（离职→CodeClaw 冬眠）、印象深刻的对话——而不是「用了什么库、反复讨论的技术往返」。一个人工作一天后记住的是进度、结果、几次难忘的对话，不是 how-to。

一句话：**记忆的丰富度被「双 agent 的有损传递」压低，稳健性被「fold 机制」拖累，人味被「工程细节堆积＋画像/经历重复」稀释。**

## Solution

把 diary agent 与 persona 维护合并成**一个夜间 dream agent**，一趟读完前一天、写日记索引、就地 curate 人味记忆；记忆是不可从日记重建的活文档，靠自身历史存档恢复，靠分层遗忘控制规模。五个方面同时改：

- **合并为 dream agent（取代两个 agent）**：每天配置时刻（默认凌晨 4 点、可配时区）之后，**首次 session-start hook** 惰性补跑前一天（幂等，一天一次），取代任何常驻 daemon。一趟三件事：写当天日记索引 → curate 记忆双文档 → 记忆快照进历史存档。模型**可配置**（不写死）；因夜间修剪不可逆、判断密集，默认档位取当前最强模型。
- **记忆＝就地演进的真源，不可从日记重建**。恢复不靠重放日记，靠记忆文档自己的历史存档（每晚 curate 前快照）。这是有意的人脑式取舍：一份活记忆整固与遗忘，而非每天 re-fold 出来。
- **分层遗忘，从不硬删**：记忆分热（注入的当前文档）与冷（archive，不注入、可搜、只进不删）。修剪＝把休眠条目从热降级进冷。**提回**（冷→热）由 dream agent 在写「新」事实前先搜 archive **与日记索引** 去重触发：命中则带原 citation 提回、不重写；并在 curate 前 diff 最近几天记忆文档的变化以捕捉趋势、降低漏搜概率。**越久远、越不值得记的条目，剪得越狠**。
- **人味记忆，工程细节下沉到日记**。记忆双文档（画像＋经历）只记人味：这个人是谁、项目推进到什么进度、结果如何、印象深刻的对话或原话。工程细节（用什么库/算法、技术往返）进**日记**——日记是索引层、不是记忆的一部分、不参与修剪。画像与经历分工明确：**画像＝谁**（性格/价值观/品味/沟通风格/关系，不含项目与进度）；**经历＝发生了什么**（按项目/时间的进度、结果、印象深刻的瞬间，带日期）。
- **注入预算重排，archive 不注入**：session-start 注入画像 2k＋经历 2k＋日记索引 1k（优先最近日记）＝约 5k；archive 冗余、不注入。发布预算与注入预算彻底解耦后，热文档以「注入预算＋加载器截断」为准，不再有独立的发布 token 校验。

## User Stories

1. As the user, I want one nightly dream agent instead of a diary agent plus a separate persona maintainer, so that memory is updated from the day's raw material in a single pass rather than through a lossy diary-to-persona relay.
2. As the dream agent, I want to run once per day, triggered by the first session-start after the configured hour, so that I process yesterday lazily without a resident timer and never run twice for the same day.
3. As the dream agent, I want my model to be configurable, so that the operator can trade cost against curation quality instead of a hardcoded tier.
4. As the operator, I want a capable default model for the dream agent, so that the irreversible, non-rebuildable nightly pruning gets the best judgment out of the box.
5. As the user, I want the curated memory to be the source of truth and NOT rebuilt from diaries, so that memory evolves like human memory rather than being re-derived nightly.
6. As the user, I want the dream agent to snapshot memory to a history before each curation, so that a bad prune or a crashed run is recoverable by restoring a prior snapshot.
7. As the user, I want pruning to demote entries into a cold archive rather than hard-delete them, so that a dormant-but-durable fact (e.g. "user is a pianist") is never permanently lost.
8. As the dream agent, I want the cold archive to be searchable, so that when a dormant topic resurfaces I can find and promote its entry instead of writing a duplicate.
9. As the dream agent, I want to search both the archive and the diary index before writing a "new" fact, so that I catch a prior mention that was phrased differently and reduce missed promotions.
10. As the dream agent, I want to promote a resurfaced fact carrying its original citation, so that re-surfacing preserves provenance instead of minting a fresh unsourced claim.
11. As the dream agent, I want to diff the last few days of memory-document changes before curating, so that I curate against the recent trend rather than blind to it.
12. As the dream agent, I want to prune older and less-consequential entries more aggressively, so that memory converges on what still matters instead of accreting forever.
13. As the user, I want memory to record human, memorable things — who I am, project progress and outcomes, memorable conversations — and NOT engineering detail, so that reading memory feels like being remembered, not like a work log.
14. As the user, I want engineering detail (libraries, algorithms, technical back-and-forth) to live in the diary, not in memory, so that the two layers have a clear division of labor.
15. As the user, I want the profile to describe who I am (personality, values, taste, communication style, relationships) with no project list or progress, so that it does not duplicate the experience document.
16. As the user, I want the experience document to record what happened (per-project progress, outcomes, arcs, dated memorable moments), so that the project list and progress live in exactly one place.
17. As the dream agent, I want the diary to be a per-day index of noteworthy events, each with an [S/T] pointer, so that full detail stays recoverable from the turn database without bloating the diary.
18. As the dream agent, I want engineering detail permitted in the diary, so that the day's technical specifics are captured somewhere even though they are excluded from memory.
19. As the Claude Code agent, I want session-start injection of the current profile (2k), experience (2k), and a recent-first diary index (1k), so that I start each session with a compact, human picture of the user and pointers to recent days.
20. As the Claude Code agent, I want the cold archive excluded from injection, so that injected context is not paid for redundant demoted material.
21. As the dream agent, I want the day's turns delivered as an enriched manifest (per turn: user prompt plus, for extracted turns, the extraction summary, or for unextracted turns, the response), each field capped at ~200 tokens, so that I can write the diary and curate memory from real substance without loading full transcripts.
22. As the dream agent, I want to pull deeper via recall/timeline for a verbatim quote or a cross-day thread, so that signature statements enter memory as exact 「」 text.
23. As the dream agent, I want manifest fields truncated at a sentence or word boundary with an ellipsis, so that entries do not dangle mid-word.
24. As the dream agent, I want internal database turn ids embedded in extraction text converted to [S/T] citations, so that my material carries valid, resolvable references rather than opaque ids.
25. As the dream agent, I want the redundant title prefix dropped from an extracted turn's material so its summary budget goes to content, so that I read the summary, not the title twice.
26. As the developer, I want the persona fold/rebase lifecycle, generations, rebuild epochs, the persona operation state machine, the terminal tombstone, and the published token-budget validator all removed, so that the class of deadlocks fixed in 0.3.2 cannot recur.
27. As the developer, I want the injection loader to remain a pure function over (document text, injection budget, display path), so that the new budgets and the diary-index rendering are unit-testable without an agent run.
28. As the user, I want the agent's own identity kept static and read-only to the dream agent, so that nightly pruning of user memory never erodes the agent's persona and the agent/user person separation holds.
29. As the user, I want skipped-turn responses treated as low-trust material, so that mid-turn insertion artifacts never become memory or diary facts.
30. As the user, I want the main-session recall truncate cap unchanged at 2000 while the dream agent's recall stays uncapped, so that my live context window stays protected.
31. As the developer, I want the diary layer to remain durable and never pruned, so that it stays a permanent index into the turn database even as memory forgets.

## Implementation Decisions

### 层次结构与职责分工

四层，职责不重叠：

- **原始层**：SQLite turn DB，全量、无损、永不修剪（现有）。
- **日记层**：每日一份日记文档（当天值得记的事＋[S/T] 指针，工程细节允许，第一人称）＋一份日记索引文档（诸日记的 recent-first 目录，注入用）。**durable、不修剪、不是记忆**。
- **记忆·热层**：画像文档＋经历文档，人味、每晚 curate、注入。
- **记忆·冷层**：archive 文档，降级下来的条目，可搜、只进不删、**不注入**。

### Dream 作业与触发

- 新增 dream 作业处理器，取代现行 diary job processor 与 persona 维护 runner；两者合一。
- 触发改为 hook 驱动、惰性：记录「上次成功跑到的日期」；每次 session-start，若当前时刻已过配置时刻（默认 04:00，时区可配）且前一天尚未处理，则入队/运行前一天的 dream。幂等：一天一次，重复触发是 no-op。删除任何常驻定时器。
- 一趟三步（同一 agent、同一 session）：① 写当天日记（含索引更新）；② curate 画像与经历；③ 把 curate 前的记忆双文档快照进历史存档。
- 模型可配置（配置项，非硬编码）；默认取当前最强档位，理由是修剪不可逆、无重建、判断密集。
- 若某天无材料，写一条「安静的一天」并跳过 curate。

### 记忆真源与恢复

- 记忆双文档是**真源，就地演进**，**不**从日记重建；删除任何「re-fold 日记→记忆」的自动算子。
- 恢复语义 = 从记忆的历史存档回滚到某个快照，而非重放日记。历史存档保留策略（保多少份/多久）作为配置项。
- 可选的「人工全量重整」（读全部日记＋当前记忆，重写一份记忆）保留为**手动、罕见**的维护动作，不进自动管线（见 Out of Scope）。

### 分层遗忘（demote / promote / dedup）

- **降级（热→冷）**：curate 时把休眠、过时、低价值条目移入 archive，从不硬删。「越久远、越不值得记，剪得越狠」写进 curate prompt 作为原则，不做硬阈值。
- **提回（冷→热）**：dream agent 在写「新」事实前，先用 recall/read_doc **搜 archive 与日记索引**查重；命中则把该条提回热文档并**保留原 citation**，不重复写。
- **防漏**：curate 前先 diff 最近几天记忆文档的历史快照，看近期增删趋势；提回搜索覆盖 archive＋日记两处以降低改写漏搜。archive 必须可被工具检索（read_doc/grep 或 recall）。

### 人味记忆的 curate 判据

- 记忆记「故事」不记「工艺」：项目进度/结果、印象深刻的对话与逐字原话、性格价值观关系——**排除**用什么库/算法、技术往返、反复讨论的中间过程。工艺进日记。
- **画像＝谁**：性格、价值观、品味、沟通风格、关系、人味怪癖；**不含项目清单与进度**。
- **经历＝发生了什么**：按项目/时间的进度、结果、印象深刻的瞬间，带日期。项目与进度只此一份（在经历）。
- 质量标杆为 CodeClaw `sakiko-export/memory/user-profiles.md`：自由组织、逐字原话「」、带日期事件、价值观与关系。curate prompt 引用该风格作示范，但不引入固定 schema（延续 0.3.3 free-form 底线：只要求至少一个 markdown 标题）。

### 日记（索引层）

- 日记从 DIARY_V2 三节抽取式产出，简化为**每日索引-日志**角色：第一人称、按项目分组、每条值得记的事带 [S/T] 指针、允许工程细节。人味信号的抽取从日记环节移到记忆 curate 环节（dream agent 一趟内完成）。
- 日记索引文档：诸日记的 recent-first 目录，注入预算 1k，优先最近。
- 日记不修剪、durable，是回取全量 turn 正文的入口。

### 材料（dream agent 的输入清单）

- 当天材料＝按 session 分组的 turn 清单（session 行＝项目＋标题；turn 行＝编号＋状态＋字段），沿用 0.3.3 push 清单＋pull 深入的模式。
- 每 turn 字段：extracted turn ＝ user prompt ＋（title＋content 合为一个字段）；未提取 turn ＝ user prompt ＋ response。**每字段截到约 200 token**（用项目现有 CJK 感知的日记 token 估算，非 char/4）。实测该形态对一个 4-session 重日约 4.8 万 token。
- 材料渲染三修：① 截断落在句读/词边界并补省略号，不断在词中；② extraction 文本里内嵌的 DB turn id（形如内部 [T####]）转成 [S/T] 引用；③ 去掉 extracted turn 的 title 前缀冗余，把 200-token 预算全给 content。
- skipped turn 的 response 低信任，以 prompt 为准。
- dream agent 可用 recall（worker audience，无截断顶）、timeline、read_doc 自主深入拉取逐字原话与跨天上下文。

### 注入加载器（预算重排）

- 复用 0.3.3 的纯函数加载器 `render...Injection(document, injectionTokenBudget, displayPath)`；改动仅是预算与被注入文档集合：画像 2k、经历 2k、日记索引 1k；archive **不**在注入集合内。
- 删除发布 token 预算及其校验器；热文档规模由「注入预算＋加载器逐节截断＋每节尾部『还有 N 行，见 <path>』指针」共同约束，不再有独立的重写规模上限。

### 删除的机制（0.3.2 那类失败面的根除）

- persona 的 fold/rebase 算子、每日自动维护、generations 目录与 CURRENT 代际协议、rebuild_request_epoch/rebuild_confirmed_epoch、persona 操作状态机、terminal tombstone 与 supersede 逻辑、发布预算校验、逐条强制引用的重试拉锯——全部移除。dream 作业单一路径取代之。
- 迁移：现有 gen3 的 user-profile.md／experience.md 作为初始热文档就地接管（去代际化到单一当前文档＋历史存档），不做内容重写（首夜 dream 会按新 curate 判据自然收敛）。

### 人设（agent 身份）

- **本 spec 不新增独立角色扮演人设文件**。agent 就是 Claude Code；sakiko 那种角色圣经（情绪层次/关系网/扮演要点）是陪伴场景刚需，此处范畴错配。
- 如需给日记/记忆里的第一人称「我」一个稳定叙述声音，做法是在已注入的 global CLAUDE.md 里补一两句语气/价值观约定——**静态、人工编辑、对 dream agent 只读**。dream agent 只 curate 用户记忆，永不修改 agent 自身身份，以维持「我=agent、用户=用户」分离。

## 合同补全（v2 — 解决评审 Blocker/Important；与上文冲突处以本节为准）

### 提交事务与崩溃恢复（Blocker 1、2；Important 3）

- dream agent 不自由写文件；本夜全部产物（当天日记、日记索引、画像、经历、archive 增量）通过**单个 commit 工具**原子提交。
- commit 工具内部固定顺序，agent 不可打乱：① 读旧画像/经历/archive → ② **原子写 pre-curate 快照到历史目录**（带 hash manifest）→ ③ 校验（token 界＋可解析）→ ④ staging 写全部新文档 → ⑤ 原子 rename 发布 → ⑥ 落 success marker（记 `last_successful_date`）。**快照先于发布**，修正上文步骤③顺序矛盾。
- 崩溃语义：任一步失败、未落 marker，则该日视为未处理、下次触发重跑；因「先快照后 staging-rename」，半更新不会成为真源（旧文档仍完整或已回滚），重试不会基于半更新记忆再次 demote/promote。
- 恢复原语：历史目录内每份快照 = 一组 dated 文档＋hash manifest；提供内部 restore primitive（list / verify-hash / 原子 restore 某快照为当前）。默认保留：最近 30 份＋每月 1 份滚动（可配）。

### 工具面与作用域（Blocker 4；安全）

- dream agent 工具面 = recall / timeline / read_doc（现有）＋**内建 Read＋Grep（放开）**＋**commit（新）**。
- Read/Grep/read_doc/commit **全部钉死在 diary＋memory 工作区子树**（复用 read_doc 的 `allowedDocumentSubtrees` 守卫，用权限 hook 施加于内建 Read/Grep）：不可读 dataRoot 下的 DB/config，更不可越出到 `~/.claude/projects`（原始转录含 `<private>` 标签）或任意磁盘。
- 提回/去重靠 **Grep 搜 archive 与日记**（不是 recall——recall 只查 SQLite，搜不到 markdown 文件）。

### 分层遗忘的保证强度（Important 4 — 软语义）

- archive 保持 free-form markdown 文件、不进 DB。因此 **demote/promote/只进不删/citation 原样 均为 agent 软语义**，靠 prompt＋commit 工具的弱校验（仅结构与 token 上限），**不做强制**：校验器不判定「删的内容确实进 archive」「提回删了冷副本」等。相应 User Story（7–10）保证降为 best-effort。

### 记忆规模界（Important 1）

- 软：prompt 提醒每份记忆文档 ≤ 3k 中文字。
- 硬：commit 工具校验**每份记忆文档 ≤ 5k token**（项目 CJK 感知估算）；超限则拒绝提交并返回错误，指示 agent 多降级（force-demote 最旧/最不值得条目进 archive）后重提——删掉发布预算后的替代确定性压缩闸。archive 无上限（只进不删），read/grep 结果分页读取。

### 触发、断档补跑与迟到回填（Blocker 3；Important 5；Minor 1）

- 触发：每次 SessionStart，若配置时刻（默认 04:00）已过且存在未处理日则入队。时区用 **IANA**（默认 Asia/Shanghai，可配）；非法时区回退默认并告警；DST 跳/重时以当日是否已落 marker 判「一天一次」，不重复。
- 补跑：不删 `reconcileBacklog`，改靶为处理 `last_successful_date + 1 … yesterday` 全部日期（每天都产 durable 日记，无 material 日写「安静的一天」）；单次 SessionStart 封顶入队 N=7 天（可配），逐日**独立事务**。
- 迟到回填：保留 `needs_regen`/watermark；昨天的 turn 在 dream 成功后才落盘时置 `needs_regen` 让该日重新入队，重跑覆盖当日日记与「基于当日的记忆增量」（记忆按幂等 upsert 当日贡献，避免重复 curate）。

### 迁移（Important 2）

- 不写死 gen3。迁移读取 persona **CURRENT 指针指向的 generation**，校验文档完整（hash/可解析），**原子复制**为单一当前画像/经历；去代际化（不再有 generations 目录与 CURRENT 协议）。CURRENT 缺失/损坏/初装：以空文档起步、置首夜 dream 全量填充，记录告警，不阻断。

### 模型配置（Important 6）

- 配置键 `dreamAgentModel`（loadConfig）。允许值 = 已知 model id 集合。**当前默认写死为一个具体 opus model id 常量**（不随「最强」漂移）；非法值回退默认并告警；版本升级不自动改默认（改默认需显式改常量，走版本记录）。

## Testing Decisions

好的测试只验外部行为，不验实现细节；纯函数直接单测，agent 行为类走「注入假 agent runner」的编排测试与「真 LLM」的冒烟测试。**首选最高缝＝dream 作业处理器（注入假 agent runner）**，其余为纯函数缝。

- **Dream 作业处理器（编排缝，最高）**：注入假 agent runner，断言——一趟内既产出日记又产出记忆更新；无材料日走「安静的一天」并跳过 curate；curate 前发生一次历史快照。先例：`tests/worker/diary-runtime.test.ts`（已有假 agent runner 模式）。
- **触发闸（纯函数）**：给定（当前时刻、时区、上次成功日期），断言「过点后当天首次触发一次、幂等、无常驻定时器」。先例：`tests/db/diary-state.test.ts` 的状态判定风格。
- **材料渲染（纯函数）**：断言 200-token 截断、句读/词边界＋省略号、DB-id→[S/T]、去 title 前缀、extracted 与未提取两种字段形态、skipped 低信任。用项目 CJK token 估算函数计量。先例：`tests/diary/domain.test.ts`。
- **注入加载器（纯函数）**：断言画像 2k／经历 2k／日记索引 1k 的逐节截断与「还有 N 行」指针；archive 不出现在注入产物中。先例：`tests/diary/persona-render.test.ts`。
- **可解析子集与日记索引解析（纯函数）**：标题/前言/fenced-code 规则沿用 0.3.3 契约；日记索引 recent-first 排序确定性。先例：`tests/diary/verify.test.ts`。
- **人味 curate 质量与分层遗忘（真 LLM 冒烟）**：在真实数据上跑 dream agent，人工/断言核验——记忆无工程流水账、画像不含项目清单、经历不与画像重复、休眠事实降级进 archive 且带 citation、resurface 时从 archive 提回而非重复写。先例：0.3.0/0.3.3 的真实数据冒烟测试流程。
- **删除项回归**：断言 persona 状态机/tombstone/发布预算校验相关路径已移除且不再可达（旧 deadlock 场景无法复现）。

## Out of Scope

- **archive 搜索精度的语义化**：本 spec 定「Grep 搜 archive＋日记、带 diff 防漏」，但 literal grep 对改写（「触键手感」vs「钢琴演奏者」）仍可能漏；语义/embedding 检索留待后续，先用 Grep＋日记双源覆盖降低漏率。archive 结构化入 DB（可强校验 demote/promote）已评估并放弃，改采 file＋Grep＋软语义。
- **夜间 thrash 的迟滞机制**：边界条目在热↔冷来回摆的抑制（如「连续 N 天不活跃才降级」）不在首版，先靠 curate prompt 的「越久远越狠」原则与 agent 判断。
- **人工全量记忆重整**：保留为可能的罕见手动动作，但其触发、UI 与实现不在本 spec。
- **独立 agent 人设文件**：明确排除；仅允许 global CLAUDE.md 内的静态叙述声音约定。
- **历史存档的保留策略调参**：保多少份/多久作为配置项存在，具体默认值与清理策略后续再定。

## Further Notes

- **成本**：dream agent 一趟做的活比现行日记多（日记索引＋记忆 curate＋archive 查重），实测日记单趟 Sonnet 约 $0.30；整趟换最强档位约 $45–75/月量级。模型可配置正是为让操作者按此权衡，而非锁死。
- **为什么合并不牺牲可重建性的替代品**：日记仍每天写、durable，是回取全量正文的索引；记忆的恢复改由自身历史快照承担。两条恢复路径（日记回取原文、记忆回滚快照）互补，替代了被删掉的 fold-重建路径。
- **与 0.3.3 的关系**：free-form 双文档、注入加载器纯函数、三工具面、可解析子集、skipped 低信任、主会话 2000 截断顶——均保留复用；本 spec 只动「谁来写、何时写、写什么质量、如何遗忘、如何注入预算」。
