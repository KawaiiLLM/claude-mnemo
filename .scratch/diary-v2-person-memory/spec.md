# Diary v2 与人物记忆双文档（release 0.3.0）

Status: ready-for-agent

> 增量 spec：`docs/plans/2026-07-11-diary-agent.md`（v6）的实现已存在于工作树（0.2.41 工作版本，**从未发布**）。本 spec 覆盖其后一轮设计迭代的增量改动，随 0.3.0 发布。**无迁移路径**：不存在线上 v1 数据，实现可以直接替换 v1 代码路径（四节常量、降级校验器、self.md 产物、SELF_V1 哨兵），开发机残留的 diary/persona 数据允许清空重建。凡本 spec 与 plan v6 冲突处以本 spec 为准，被取代的章节：日记四节格式与 `[背景]`/`[引用待核]` 降级机制（v6 §4.1–4.3）、persona 文件集与 self.md 准入（v6 §5.1）、注入的独立日记索引块（v6 §6）。v6 其余章节（状态机、队列、三算子、分批归约、checkpoint、CURRENT 协议、500K/150K gate、完整性巡检、**per-request 引用 allow-set 矩阵**）继续有效。

## Problem Statement

0.2.41 工作版本暴露出五个问题：

1. **Agent 没有「经历感」**。persona 只有 user-profile.md 和 self.md 两份特质文档，没有情景层——agent 不知道自己陪用户做过什么项目、各做到什么程度，每个新 session 都像失忆后初次见面。
2. **日记四节有结构性冗余**。「人物信号」与「协作反馈」按表达对象强行切分同一信号（对 AI 协作方式的反馈几乎总是用户特质的一次具体表达）；「未决与杂记」基本复读 session summary 的 `next` 字段，且是诊断性残留和 `[引用待核]` 降级内容的堆放场。
3. **日记逐日复读已知特质**。日记 agent 看不到 persona 文件，同一特质（如「指令极简」）每天被当作新发现重记一遍，烧预算且逼 fold 天天去重（真实数据模拟已复现：连续两天重复记录同一沟通风格特质）。
4. **引用降级污染下游**。引用校验违规的 bullet 被改写为 `[引用待核]` 保留在日记里；且 index hook 在校验前由 agent 生成，可能概括着一条随后被判非法的 bullet，再经「近期」注入长期传播。
5. **self.md 定位含混**。「Agent 的自我」既想装先验人设又想装后验教训；实际上先验人设已经活在用户的全局 CLAUDE.md 里，mnemo 再维护一份是重复建设。

## Solution

记忆模型收敛为「**一份先验 + 两份后验**」：

- **先验人设（global CLAUDE.md）**：用户的全局 CLAUDE.md，机制外，mnemo 只读不写。self.md 从 fold 产物中移除。
- **user-profile.md（用户画像）**：五个封闭节的特质层文档。
- **experience.md（经历）**：新的情景记忆文档——每个语义项目一个条目（含路径/进度/反馈/印象）+ 一个通用桶，注入时与代码渲染的「近期」段拼为一块。

日记改为**第一人称三节**（工作/人物/反思），生成时把三份记忆文件作为**可选增强素材**注入（任何一份缺失/损坏都只省略对应块，日记生成永不因此失败——这同时解决冷启动依赖环：第一天没有 persona，日记照常生成，persona 随后由 fold 产生）。接受回声风险，不设 prompt 护栏；引用越界由代码门兜底。引用校验从降级改为**删除 + 版本化校验报告**；发生删除时 index hook 不再信任 agent 产出，回退为确定性生成。persona 产物新增结构校验与预算提交门；注入侧对最终渲染块再压一道总预算硬界。

## User Stories

1. As the Claude Code agent, I want a persistent experience document injected at SessionStart, so that I know which projects I have worked on with the user and how far each has progressed.
2. As the Claude Code agent, I want project entries keyed by a semantic project name with a machine-parsable source-path list, so that the same project spanning multiple sessions and directories reads as one continuous thread.
3. As the Claude Code agent, I want each project entry to carry a single always-current 进度 line, so that I can resume a project without re-deriving its state from summaries.
4. As the Claude Code agent, I want per-project 反馈 lines recording collaboration lessons learned in that project, so that I repeat fewer mistakes the user has already corrected.
5. As the Claude Code agent, I want dated 印象 bullets under each project, so that memorable events (reversals, breakthroughs, retractions) stay recallable as impressions rather than technical logs.
6. As the Claude Code agent, I want a 通用 bucket in the experience document, so that projectless content — chitchat, life events, cross-project lessons, tooling housekeeping — has a home and is not force-fitted into a project.
7. As the Claude Code agent, I want the user profile limited to five closed sections of abstract traits, so that the profile stays a dense character sheet instead of drifting into an event log.
8. As the diary agent, I want the three memory files — 先验人设（global CLAUDE.md）、user profile、experience — included in my material when they exist, so that I write deltas and continuations instead of rediscovering the same traits daily.
9. As the diary agent, I want diary generation to proceed normally when any memory file is missing or unreadable, so that a cold start or a corrupted persona never blocks the diary pipeline.
10. As the diary agent, I want to write in the first person with a 反思 section, so that day-level syntheses — reassessments, cross-day patterns, operational lessons — are captured where per-bullet sections cannot hold them.
11. As the diary agent, I want the 人物信号/协作反馈 split merged into one 人物 section, so that I record a signal once instead of splitting it by addressee.
12. As a user, I want diary bullets with invalid citations deleted and recorded in a structured validation report rather than kept with a warning tag, so that everything that remains in a diary is trustworthy.
13. As a user, I want a diary generation to fail and retry when the deleted share of bullets exceeds one third, so that a hallucination-heavy generation never settles.
14. As a user, I want the index hook regenerated deterministically from surviving bullets whenever any deletion occurred, so that a summary of deleted hallucinated content can never reach the long-lived 近期 injection.
15. As a user, I want the persona fold to update a reinforced trait by appending citations instead of adding a duplicate bullet, so that the profile stays within budget while support strength stays measurable.
16. As a user, I want old impressions merged upward into their project's impression line before eviction when the experience document exceeds budget, so that forgetting is gradual (details fade, the gist survives) rather than abrupt.
17. As a user, I want contradictions with existing persona content kept and marked （已变化） rather than silently overwritten, so that trait evolution stays visible.
18. As a user, I want the fold to reject diagnostic/meta observations and multi-fact bullets, so that experience entries stay single-fact impressions (both defects observed in simulation).
19. As a user, I want one piece of information allowed to live at two abstraction levels (trait in the profile, supporting event in the experience doc), so that neither layer is starved to keep the other unique.
20. As a user, I want persona documents that violate the closed-section lists, the project-block structure, the per-operation citation allow-set, or the output budgets to fail the operation before publication, so that malformed or oversized personas never become CURRENT.
21. As a user, I want no two project entries to share a normalized source path, so that one project can never silently split into multiple entries under different names.
22. As a user, I want the final rendered injection capped per block and in total (profile ≤1K, experience ≤2K, combined ≤3K) with whole-unit trimming, so that per-session overhead stays flat and a trimmed injection never contains orphaned sub-bullets.
23. As a user, I want corruption of CURRENT or generation files detected at any read entry to schedule a rebuild automatically, so that a damaged persona heals without manual intervention.
24. As a maintainer, I want the prior-persona path to be a typed config key with a fixed default, explicit size cap, and omit-on-error semantics, so that reading an external file can never crash or bloat the diary job.
25. As a maintainer, I want the persona envelope to use an EXPERIENCE_V1 sentinel in place of SELF_V1, so that the artifact names match the new document set unambiguously.
26. As a maintainer, I want persona inputs excluded from the diary watermark, so that persona updates can never mark historical diaries dirty and trigger a regeneration loop.
27. As a maintainer, I want all diary read entries to route validation failures through one validate-and-mark-stale path, so that an invalid file is queued for regeneration no matter which consumer touched it first.
28. As a maintainer, I want the release version asserted in one guard test covering all version-bearing artifacts (including the SDK MCP server version constant), so that a partial version bump cannot ship.

## Implementation Decisions

**日记格式 v2**

- 节清单从四节改为三节：`## 工作`、`## 人物`、`## 反思`，顺序固定。人物节合并原「人物信号」「协作反馈」职能，prompt 以信号类型清单（偏好、品味、生活面、对 AI 的纠正与认可）保住对协作反馈的注意力；反思节为当天级综合（评估修正、跨日模式、假设、操作教训），≤5 条，推测性判断须带不确定措辞。全文第一人称。
- **正文语法（封闭）**：bullet 行匹配 `^- `（日记 bullet 一律顶格、不嵌套）；项目引导行为**整行**匹配 `^\*\*[^*\r\n]+\*\*$` 的独立行（非 bullet），**仅允许出现在工作节**，且其后必须紧跟 ≥1 个 bullet——引导行与首个 bullet 之间出现其他行 = envelope 非法；人物、反思节只允许 bullet 及其延续行（节标题与首 bullet 之间出现非空行 = envelope 非法）。既非节标题、非引导行、又不匹配 `^- ` 的行是**延续行**，归属其上方最近的 bullet。项目块末尾允许至多一行未决（普通 bullet，同受引用校验）。
- **引用组的语法定义**：只有内容以 `S<n>/T` 起始的方括号才是引用组；其他方括号（如印象日期前缀 `[YYYY-MM]`）是正文，由各自 parser 消费，不计入引用组数量。此定义为日记与 persona 两侧校验共用。
- front-matter 新增 `format` 字段：canonical serializer 固定输出 JSON 整数 `2`；读取校验只接受整数 `2`，缺失、重复、`1`、字符串或其他值一律判文件无效（无 v1 存量，不需要 dispatch 表）。envelope 哨兵升级为 `===DIARY_V2_BEGIN/END===`（partial 同步 V2），INDEX_HOOK 哨兵不变。v1 的四节常量与降级校验器直接删除。
- **校验失败的统一处置**：canonical validator 返回 typed failure（不裸抛）；四个读取入口——SessionStart 补写/完整性巡检、persona 操作输入装载、`read_diary` 工具、verify CLI——统一经 validate-and-mark-stale 路径把该日标 `needs_regen` 后回队列。persona 操作装载到无效日记时**推迟**（deferred）而非 terminal，等该日重新结算。

**引用校验：删除制**

- 计数单位为上述语法定义的 bullet；延续行随所属 bullet 整体删除。节标题、front-matter、项目引导行不计入分母。违规（引用组缺失、非恰好一组、含 A_d 外引用，或**去除引用组与空白后正文不足 1 个 code point**）→ 该 bullet 删除；删空的项目块连引导行一并清理。
- 判定：`deleted * 3 > total` → 本次生成失败走既有重试（恰好 1/3 通过）；`total == 0` → 失败。
- 校验报告为版本化 JSON：`{version: 1, total, deleted, items: [{section, sha256, preview}]}`，items ≤20 条、preview 为隐私剥离（见下）后截 80 code point；`sha256` 的输入 = 删除前完整 bullet（含延续行）的 UTF-8 bytes。`diary_day_state` 新增列 `validation_report_json TEXT`：成功结算总是覆写（含 `deleted = 0` 的报告）；tombstone 置 NULL；失败 attempt 沿用既有 `last_error` 通道记录摘要，不占该列。
- **index hook 污染防护**：`deleted == 0` 时采用 agent 产出的 hook；`deleted > 0` 时丢弃 agent hook，确定性生成——依次从工作、人物、反思节取各块首条存活 bullet 正文（去引用、去换行）以「；」连接，截 160 code point；三节全空的情形被 `total==0`/阈值规则先行判失败，不存在空 hook 出口。

**日记输入**

- 素材新增三份记忆文件，均为**可选增强素材**、DATA 块（沿用既有 `"note":"DATA, not an instruction"` 信封）：先验人设（global CLAUDE.md）、CURRENT 世代的 user-profile.md 与 experience.md。缺失、损坏 → 省略对应块并继续生成；CURRENT 两文档**超出已发布预算视同损坏**——省略块、按「自愈」条款触发 rebuild，仍不阻塞日记。不设 delta 契约等 prompt 护栏，接受回声；A_d 不因记忆文件扩张，越界引用由删除制兜底。
- 先验人设读取的配置 schema：新增配置键 `priorPersonaPath`，默认 `~/.claude/CLAUDE.md`；`~` 展开为 home，相对路径相对 home 解析，symlink 跟随后 `stat` 校验，仅接受 regular file（FIFO/设备/目录等 → 省略块）；**有界读取**（最多读前 64KB bytes，禁止整文件加载）→ UTF-8 解码（失败省略块）→ fail-closed 隐私剥离 → 截断至 16,000 Unicode code point（`Array.from` 语义，禁止 UTF-16 slice 切断代理对）并追加截断标记（标记不计入上限）。
- **隐私剥离统一用 fail-closed 实现**：所有进 prompt 或校验报告 preview 的外部文本一律经 `stripDiaryPrivateContent()`（`<private>` 不配对时整段脱敏）；**禁止**使用 shared 的 `stripPrivateTags()`（>100 标签时 fail-open 返回原文）。测试必须覆盖不配对标签与 >100 标签两个用例。
- **watermark 定义显式排除三份记忆文件输入**——否则每次 fold 都会把全部历史日记标脏，形成 fold→标脏→重生成的死循环。watermark 仍只取当日 turn 素材。

**persona 文档**

- fold 产物 = user-profile.md + experience.md；self.md 及 SELF_V1 哨兵删除，替换为 `===EXPERIENCE_V1_*===`，双块同现规则保留。冻结输入/checkpoint/manifest 中的 `self` 命名一律改为 `experience`（无兼容负担）。
- 项目条目结构（来自模拟原型；路径改为机器可解析的数据行）：

  ```markdown
  - **<语义项目名>**：一句话印象 [引用]
    - 路径：["/abs/path/a", "/abs/path/b"]
    - 进度：<恰一行，fold 时覆写不累积> [引用]
    - 反馈：<该项目沉淀的协作教训，分号连接> [引用]
    - [YYYY-MM] <无标签日期条目即印象事件> [引用]
  ```

  路径行为 JSON 字符串数组（避免逗号/括号歧义）；规范化 = 绝对路径的 lexical normalize（`~` 展开、消解 `.`/`..`、去尾部 `/`，不做 realpath、大小写原样）。
- **结构校验（代码，envelope 解析时，违规 = 操作失败重试）**：
  - 节标题恰为封闭集：user-profile 五节（身份与背景/专长与判断力/品味与兴趣/沟通风格/协作偏好）、experience 两节（项目/通用），顺序固定、不得增删。
  - 每个项目块：恰一个首行、恰一行 `路径：`（合法 JSON 数组、元素为绝对路径）、恰一行 `进度：`、`反馈：` 0–2 行、印象行必须匹配 `- [YYYY-MM] ` 前缀（日期前缀按「引用组的语法定义」不计入引用组）；不允许未知缩进层级或游离子项。
  - **路径 allow-set**：输出中所有规范化路径必须 ⊆ 本次 request 的 `allowedProjectPaths`——fold = baseline persona 已有路径 ∪ 本篇日记 front-matter `projects`；rebase 批 1 = baseline ∪ 本批日记；rebase/rebuild 后续批 = accumulator ∪ 本批日记；rebuild 永不含旧 CURRENT。与引用 allow-set 同批构造、同一 lexical normalize（防 agent 凭空制造项目来源）。
  - 每个 bullet（首行、进度、反馈、印象、通用条目、profile 条目；路径行除外）恰好一个引用组（按「引用组的语法定义」，组内全角逗号分隔），且全部引用 ∈ **本次 SDK request 的 allow-set**。allow-set 沿用 v6 矩阵、与 `read_turn` 工具共用同一集合：fold = 旧 persona ∪ 本篇日记；rebase 批 1 = baseline persona ∪ 本批日记；rebase 后续批 = accumulator ∪ 本批日记；rebuild 批 1 = 本批日记；rebuild 后续批 = accumulator ∪ 本批日记，**永不包含旧 CURRENT**。
  - **任意两个项目条目的规范化源路径集合不得相交**（防同一项目分裂为多条目——语义合并靠 prompt，分裂防线靠此校验）。
- **预算提交门（代码，CURRENT 发布前，用生产 render 函数校验）**：profile 按注入渲染（含块标题与包装）后 ≤1K token；experience 渲染正文 ≤1.4K token（为「近期」段预留 0.6K）。超限 = 操作失败重试。估算器沿用既有 Han 加权实现。此门保证注入侧最终门在 profile 与经历正文侧恒可满足（见「注入」）。
- **重试纠错反馈**：结构/引用/路径/预算失败后的下一 attempt，prompt 附带版本化的 validator feedback（错误代码、超限 token 数、违规条目索引等结构化字段），使稳定输出有修正依据；禁止附带未经清洗的完整失败输出。
- **自愈（本次实现范围，替代 spec 早稿的「既有路径不变」表述——现状代码只把 CURRENT 缺失当空状态，其他损坏会裸抛）**：CURRENT 或世代文件在任何读取入口（注入、日记素材装载、操作基线装载）解析/哈希失败或超出已发布预算 → 在一个事务内置 `rebuild_requested = 1`，本次消费按缺失处理（跳过注入/省略 DATA 块）；已在跑的 non-terminal operation 不受影响——为此 operation 状态在启动时**持久化 `base_generation` 与 `target_generation`**，恢复与发布只依赖这些冻结字段与 checkpoint/input hash，**不读 live CURRENT**（CURRENT 损坏不得导致 operation terminal 或代次回退）；rebuild 标志仅在成功发布后清除，并按 v6 §5.3 的 wake 尾调度消化。
- fold 准入规则（prompt 层，模拟验证）：一条 bullet 只装一件事；诊断性/元观察禁入；跨项目协作教训归通用桶（即使发生在某项目会话内）；双写允许（特质进画像、支撑事件进经历，各自带引用），同文件内去重；被新日记强化的既有特质追加引用而非新开条目；矛盾旧条不删、文末标 `（已变化）`。项目身份：素材中的源路径命中既有条目路径列表时必须并入该条目（改名允许，路径列表保留并集）。
- 衰减（预算门驱动）：项目下最弱印象事件先**向上合并**进该项目首行印象句（引用随迁）再淘汰；通用桶按支撑最弱→最陈旧淘汰；长期无更新的项目**归档形态 = 保留首行 + 路径行 + 进度行（改写为 `进度：已归档——<一句话>`），删除反馈与印象行**——归档条目仍满足结构校验。进度/反馈行不参与衰减。
- 三算子（fold/rebase/rebuild）、分批归约、150K gate、checkpoint、CURRENT manifest 提交协议不变。

**注入**

- 独立的 Diary Index 块移除。注入结构：persona 块 = user-profile.md；经历块 = experience.md 正文 + 代码渲染的 `## 近期` 段（近 14 天逐日 + 月摘要行）拼接。
- **最终渲染门（含块标题、包装与空行）**：profile 渲染块 ≤1K token、经历渲染块 ≤2K token、两块合计 ≤3K token，断言作用于实际注入字符串；提交门已用同一 render 函数保证 profile 与经历正文合规，注入时 profile 仍超限属异常 → 按损坏处理（跳过注入 + 自愈），不做 bullet 级裁剪；经历块的可变部分（近期段）由 AST 裁剪收敛。
- **经历块超预算时按 AST 整单元裁剪**，顺序：① 月摘要行（最旧先）→ ② 日摘要行（最旧先）→ ③ 印象事件 bullet（连延续行）→ ④ 通用条目 → ⑤ 整项目块。③④⑤ 的时间序**由引用解析**：单元时间 = 该单元引用指向的 turn 的最大 `created_at_epoch`（注入侧查 DB 解析）；无法解析的引用视为最旧；同时间以文档顺序在前者先裁；⑤ 以进度行时间为准。任何裁剪不得产生孤儿子项。
- persona 缺失/损坏时跳过注入并触发自愈（见上）。

**发布**

- 无迁移：数据根按新 schema 从零建立；开发机残留的旧 diary 文件、persona 世代与 operation 状态直接清除（可提供一次性 dev 清理命令或手动 rm，不进产品逻辑）。
- 版本号 0.3.0：既有五处版本位（package.json、marketplace.json ×2、plugin manifest、release-artifacts 守卫）之外，SDK MCP server 的硬编码版本常量纳入同一守卫测试。

## Testing Decisions

好测试只断言外部行为：给定素材/envelope 输入，断言产出文件字节、day-state 行、注入文本——不断言内部函数调用序列。复用四条既有实现缝 + 一条发布守卫，不开新缝（已与用户确认）：

- **domain 纯函数缝**（先例 tests/diary/domain.test.ts）：v2 三节语法（bullet/引导行整行匹配、引导行仅限工作节、引导后无 bullet 非法、延续行判定）与 V2 哨兵；引用组语法定义（`[YYYY-MM]` + 单引用组合法、双引用组非法、仅日期无引用非法、空正文 bullet 按违规删除）；`format` 严格校验（缺失/重复/字符串/`1` 全拒）返回 typed failure；删除制（AST 分母口径、延续行随删、空项目块清理、恰 1/3 通过、`total==0` 失败、报告 JSON 形状与 preview 截断）；hook 污染防护（`deleted>0` 时确定性 hook 的三节回退与截断）；隐私剥离 fail-closed（不配对标签、>100 标签）；watermark 对记忆文件输入不敏感。
- **diary-job 假 runQuery 缝**（先例 tests/worker/diary-job.test.ts）：prompt 含三份记忆文件 DATA 块；任一文件缺失/损坏/超预算时省略对应块且生成继续（冷启动：三块全缺）；先验路径配置解析（`~` 展开、非 regular file 省略、有界读取、读取错误省略、code point 截断）；校验报告持久化到 `validation_report_json`（成功覆写、tombstone 置 NULL）；产出 front-matter `format: 2`。
- **persona-maintenance 假 runPersona 缝**（先例 tests/worker/persona-maintenance.test.ts）：EXPERIENCE_V1 envelope 与双块同现；结构校验各违例（节集、项目块形状、路径行 JSON、引用组、路径相交）= 操作重试；**allow-set 按算子/批次正确构造**（fold、rebase 批 1/后续、rebuild 批 1/后续——rebuild 批 2 引用 accumulator 中批 1 的引用必须通过、引用旧 CURRENT 必须失败）；路径 allow-set 按算子/批次构造（凭空路径 = 重试）；预算提交门（生产 render）超限 = 重试；**重试的第二次请求含结构化 validator feedback 且可修正成功**；装载无效日记 → 标脏 + deferred；CURRENT 损坏 → 事务内置 rebuild_requested，且**批 1 后 CURRENT 损坏、批 2 凭冻结的 base/target generation 仍成功发布**；归档形态项目条通过校验；artifact 命名 `experience` 全链路往返。
- **context 注入缝**（先例 tests/hooks/context.diary.test.ts）：无独立 Diary Index 块；近期段拼接在经历块内；最终渲染门（1K/2K/3K，含包装开销）；AST 整单元裁剪顺序（①→⑤）、引用时间解析与无孤儿断言；persona 缺失/损坏回退 + rebuild 置位。
- **release-artifacts 守卫**：0.3.0 断言扩展到 SDK server 版本常量。

另外四个读取入口（SessionStart、persona 装载、`read_diary`、verify CLI）各需一个「无效文件 → 标脏」用例，分布在上述对应缝内。

fold 语义类断言（覆写进度行、追加引用、衰减合并、（已变化）标记、语义合并判断、单事实/元观察准入）属于 LLM 行为，不进单测——由 prompt 承载，质量靠模拟评估（见 Further Notes）；代码只测校验器、预算门与管线。

## Out of Scope

- 任何 v1→v2 迁移路径（旧版从未发布）。
- sakiko-export 历史数据导入 mnemo。
- 反思节的跨日模式挖掘、经历文档的检索接口（recall 集成）。
- 0.2.40 遗留：drain sweep、citation guard（bracketBareTurnReferences 的同 session/距离校验）。
- 先验人设文件的内容模板或编辑工具（用户自管 CLAUDE.md）。
- 日记/persona 的多用户或多机同步。

## Further Notes

- **模拟证据**（2026-07-11/12，Sonnet，真实 DB 数据）：三步链（7-11 日记 map 142K token → 冷启动 fold → 增量 fold）全程 **208 处引用零幻觉**；增量语义兑现（旧条保留、强化特质追加引用、单项目条跨天合并、进度句更新）；衰减在预算压力下真实执行且淘汰理由有判断力。两个 fold 缺口（多事实 bullet、诊断性元观察漏入）即来自模拟，已升级为 **prompt 准入规则并由模拟评估**（代码无法确定性识别多事实/元观察，不宣称结构校验）。格式对照组：prompt 未钉分隔符时出现 2 处 `][` 连排、钉死后零违规——格式规则必须 prompt 与代码校验双写。
- **成本实测**：重度日（130+ turns）日记 120-150K token ≈ $0.4-0.5（Sonnet 5）；生产 fold 单次 ~10K 级，忽略不计；月度粗估 $5-8。
- **先行系统验尸**（CodeClaw/sakiko，19 天真实运行）：双头画像漂移→印证 CURRENT 单一真相源；记忆点 append-only 无界增长（单人 19 天 110 条）→印证衰减合并；日记目录因未入索引在压缩后丢失→印证索引状态入 DB；人格漂移实录→印证先验隔离在 fold 外。事件嵌套实体条目、第一人称叙事日记两个形态选择直接来自该系统的成功面。
- 0.2.41 实现与 plan v6 的一处既有偏差就地转正：日记 prompt 从未真正带昨日日记；v2 由三份记忆文件（经历含近期段职能）接管延续性，不再引入昨日日记输入。
- 设计过程完整记录在 2026-07-11 至 07-12 的 mnemo session 中：四轮 plan 审查（47 findings）+ 三轮本 spec 审查（r1：3 Blocker/8 Important/3 Minor；r2：2 Blocker/9 Important/2 Minor；r3：2 Blocker/5 Important/2 Minor），全部处置——迁移类因「从未发布」出栈，其余落为上述决策。
