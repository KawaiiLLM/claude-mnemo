# 自由式人物记忆：free-form 双文档＋动态加载＋工具化取材（release 0.3.3）

Status: ready-for-agent

> 增量 spec：建立在 0.3.0「diary-v2-person-memory」＋0.3.2（tombstone supersede＋预算 2800/1500）之上。**前置条件：0.3.2 已部署且线上 persona 已通过一次 rebuild 恢复。** 设计哲学是 bitter-lesson 式的「给机制、不给知识」：把结构性知识（画像该有哪些节、日记该记哪些条目、材料该怎么读）从校验器和硬 schema 中撤出，改为 prompt 建议＋通用工具＋一个 agent 可自适应的加载机制。凡本 spec 与 0.3.0 spec 冲突处以本 spec 为准，被取代的部分：user-profile 五个封闭节与固定标题校验、experience 的项目条目字段结构、逐条 bullet 强制引用、read_turn/read_diary 专用工具面、日记材料全量注入。0.3.0 其余机制（状态机、队列、三算子、分批归约、checkpoint、CURRENT 协议、信封哨兵、校验报告、index hook 确定性回退）继续有效。

## Problem Statement

0.3.0–0.3.2 的人物记忆在结构上是健康的（双文档、fold 生命周期、崩溃恢复都已验证），但产出物贫瘠，且贫瘠是**约束设计**造成的，不是模型能力问题：

1. **画像是模板不是人。** 五个封闭特质节（身份与背景/专长与判断力/品味与兴趣/沟通风格/协作偏好）产出的是「谨慎工程师的通用工作风格摘要」——换个用户也基本成立。对照参考实现（CodeClaw sakiko 的 user-profiles.md），丰富度的来源恰恰是 mnemo 禁止的东西：自由组织的维度、带日期的事件、逐字原话、价值观与思想立场。gen2 画像还把 ML 工程师写成了排版设计师——固定槽位逼 agent 拿手头材料硬填。
2. **硬 schema＋逐条强制校验会发散。** 0.3.2 挂死的根因链里，「每条 bullet 必须有引用组＋固定标题＋预算」的多重校验让重试输出越改越大（2542→3307 token），三振进 terminal。校验越细，agent 与校验器的拉锯越多。
3. **注入成本与文档丰富度耦合。** 发布预算一个数字同时承担两个职责：fold 稳定性（重写全文的规模上限）和会话注入成本。为了后者压小前者，文档被迫贫瘠——gen2 在 1400 预算下静默驱逐了 7 个项目中的 4 个。
4. **日记 agent 是失忆的观察者。** 人物节的 checklist 式约束（偏好、品味、生活面、纠正与认可）以工作决策为框架；agent 每天重复记录同样的表层印象，没有「已经认识用户到什么程度」的基线，写不出增量。
5. **材料全量 push＋专用工具锁死取材视角。** 每天 50–98K token 的 session 摘要全量注入，agent 被摘要视角锚定；read_turn/read_diary 的 allow-list 把它锁在当天，回取签名原话、跨天上下文都做不到。同时 worker 进程里明明已经有 recall 引擎（memory agent 在用），却为日记另造了一套窄工具。

## Solution

五层同时松绑，每层都是「机制替代知识」：

- **文档层 free-form**：两份文档唯一的结构底线是 markdown 标题层级；内容组织交给 agent，prompt 给七个建议维度（基础信息/兴趣与文化/知识与技能/性格与行为模式/价值观与思想立场/个人偏好/重要经历）和四条维护原则（对未来交互有用、可读、关键事实可溯源引用、主动删除过时内容）。
- **注入层动态加载**：会话注入不再全文灌入，改为一个纯函数加载器——渲染全部标题＋每节前序行，装到注入预算为止；被截断的节尾附「本节还有 N 行，完整见 <path>」。加载机制写进 fold prompt，agent 自己保证每节前序行是最该被看到的内容（特质类按重要性排、时间线类最新在前）。发布预算与注入预算就此解耦，文档可以长到 4000/6000。
- **取材层清单＋pull**：日记材料从全量 push 改为「当天 session/turn 清单（session 行 = 项目＋标题；turn 行 = 编号＋标题＋状态，合计 2–5K）push＋agent 用通用工具自主拉取正文」。已提取 turn 先看摘要、未提取 turn 才读 prompt＋response，这个深度策略写在 prompt 里而不是工具里。
- **工具层收敛为三件通用工具**：recall（复用 memory agent 已有的 worker audience 接线，去掉截断硬顶，渲染时补 stripPrivateTags）、timeline、read_doc（原 read_diary 改名并把作用域从日记目录放宽到整个 mnemo 数据根的文本文件）。read_turn 删除。日记与 persona fold 共用同一工具面，只有提示词不同。
- **校验层缩水到解析契约**：保留信封哨兵、发布预算、引用「出现即合法」（格式合法＋指向真实 turn）；删除固定标题校验和逐条强制引用。非法引用不再触发重试拉锯——从文本中剥除该引用标记并记入校验报告，内容行保留。

## User Stories

1. As the Claude Code agent, I want the injected user profile to describe this specific user (identity, values, real interests, signature quotes), so that my behavior adapts to a person rather than a generic engineer archetype.
2. As the Claude Code agent, I want injected persona blocks to carry per-section "N more lines, see <path>" pointers, so that I can Read the full document when a truncated section matters to the current task.
3. As the user, I want the profile to preserve my verbatim signature statements in 「」 with citations, so that reading it feels like being recognized, not summarized.
4. As the user, I want dated events (job changes, incidents, milestones) recorded in the profile's experiential dimension, so that the agent's picture of me has a timeline, not just traits.
5. As the user, I want project eviction from the experience document to be a deliberate prune under the maintenance principles (best-effort within budget) — never a silent side effect of validation retries — so that losing a project is a decision, not an accident.
6. As the diary agent, I want the day's session/turn manifest pushed as a checklist, so that I never miss a session even though I pull material myself.
7. As the diary agent, I want recall/timeline over the whole history, so that I can pull yesterday's diary context or a cross-day thread when today's events continue it.
8. As the diary agent, I want extracted turns to render summary-first and unextracted turns to render prompt+response, so that I choose reading depth per turn without switching tools.
9. As the diary agent, I want uncapped field rendering in my recall, so that I can recover a long verbatim user quote without a 2000-char cut.
10. As the diary agent, I want the current user-profile and experience documents as material, so that I record increments (new evidence, corrections, changes) instead of re-discovering the same traits daily.
11. As the diary agent, I want the user's global CLAUDE.md as material, so that standing preferences inform my observations without me obeying them as instructions.
12. As the persona fold agent, I want both documents free-form under stated principles, so that I can reorganize sections as understanding of the user deepens instead of force-filling fixed slots.
13. As the persona fold agent, I want the injection loader's mechanics stated in my prompt, so that I can order each section's leading lines by what deserves to surface.
14. As the persona fold agent, I want my edit-target documents always pushed in full, so that I never rewrite a document I only partially saw.
15. As the persona fold agent, I want read_doc over prior generations and old diaries, so that I can consult history when folding ambiguous signals.
16. As the persona fold agent, I want citation validation to be "legal if present" with stripping instead of retry loops, so that a malformed citation cannot diverge my output into a terminal deadlock.
17. As the worker, I want the validator to check only parse contracts (sentinels, budgets, citation resolvability), so that content organization is never a failure reason.
18. As the worker, I want one SDK MCP server definition shared by diary and persona agents, so that tool wiring has a single source of truth.
19. As a developer, I want the loader to be a pure function over (document text, injection budget, display path), so that truncation behavior is unit-testable without any agent run.
20. As the user, I want skipped-turn responses treated as low-trust by the diary agent, so that mid-turn insertion artifacts (mis-attributed responses) never become diary facts.
21. As the user, I want the main-session recall truncate cap unchanged at 2000, so that my live context window stays protected while worker agents go uncapped.

## Implementation Decisions

### 文档 schema 与维护原则

- user-profile.md 与 experience.md 均为自由 markdown；校验只要求「存在至少一个标题」的结构底线，标题名称、层级组织、节内格式（bullet 或段落）完全由 agent 决定。
- 可解析子集（加载器与校验器共享同一解析模块，禁止各自用正则）：节标题 = fenced code block 之外的 ATX 标题（`#{1,6}`＋空格）；首个标题之前的内容视为一个无标题前言节；fenced code 与引用块内的 `#` 不是标题；空节正文行数计 0。
- fold prompt 给出七个**建议**维度：基础信息（含当前处境）、兴趣与文化、知识与技能、性格与行为模式、价值观与思想立场、个人偏好、重要经历（带日期）。明确标注可自由增删改组织。
- 四条维护原则替代字段规定：对未来交互有用；可读（结构清晰、具体优先）；关键事实带可溯源引用；主动删除过时/被取代内容。
- 写作规则跨节生效：每条先具体事件/原话后解释；签名式表述用工具回取逐字原文，以「」保留；重要经历类条目带日期。
- 两文档分工写进 prompt：进行中的项目/事项进 experience，画像只留沉淀的人格特质与已定格事件；进行中专题（如求职季逐场面试）归 experience。

### 动态加载器（新纯函数）

- 签名：`(文档文本, 注入预算, 展示路径) → 注入块`。展示路径用于截断指针行，由调用方传入（加载器不触碰文件系统，保持纯函数）。
- 算法分两步：**先预留强制骨架成本**——全部标题＋按「每节都被截断」的最坏情况为每节预留一行指针；骨架入预算后，剩余预算按文档顺序为每节装填前序行，某节全部装入时该节不输出指针行。被截断的节尾部追加一行「（本节还有 N 行，完整见 <展示路径>）」。
- **骨架超预算的确定性降级**（永不报错、永有合法输出）：若完整骨架装不下，降为只渲染顶层标题＋一行文档级指针「（内容省略，完整见 <展示路径>）」；若连这也装不下，输出单行「（<文档名> 过大，完整见 <展示路径>）」——该单行是无条件合法的输出下界。
- 注入预算独立于发布预算，两文档合计初值 2500 token（可调常量）。发布预算（4000/6000）同时为骨架规模提供了实际上界，降级分支预期只在病态文档（标题密集）下触达。
- 加载器契约写进 fold prompt：告知「注入只取每节前序行」，由 agent 保证特质类节按重要性降序、时间线类节最新在前。
- fold 的输入（编辑对象）不经过加载器，永远全文。

### 预算

- 发布预算（校验器沿用）：profile 4000 / experience 6000 token（0.3.2 的 1500/2800 再放宽）。职责单一化：只保障 fold 重写的规模上限。
- 会话注入成本由注入预算独立控制，与文档大小脱钩。

### 工具面（两 agent 共用一个 SDK MCP server）

- **recall**：复用 worker audience 既有接线（memory agent 同款），扩展给日记与 persona agent。worker audience 差异：truncate 无硬顶（主会话 audience 维持 2000）；渲染输出过一遍 stripPrivateTags（防绕过入库剥离的历史脏数据）。注意「无硬顶」是本 spec 的新行为，不是现成能力（现状 schema 与渲染器双重钳 2000，audience 只影响 DB id 输出）——实现为按 audience 分流的 schema 与渲染策略，主会话路径不动。单次工具返回设总量上限（常量）：超限截断＋「用分页或收窄选择器继续」提示——初始 prompt 的 500K gate 管不到工具返回，这个上限就是工具面的等价 gate。
- **timeline**：同样复用既有实现，worker audience 接线。
- **read_doc**：read_diary 改名＋作用域放宽为数据根下 diary/ 与 persona/ 两棵子树的 `.md` 文本文件——config、日志、operation manifests/checkpoints、数据库均不在 allow 域（数据根 ≠「日记和 persona 文档」）。安全语义沿用现有日记文件读取的惯例：realpath 解析＋根与目标均拒绝 symlink、UTF-8 严格解码、单文件大小上限。作用域随请求参数化（沿用既有 per-request allow-set 机制）：fold/rebase 可读日记＋persona 历史各代；**rebuild 只可读日记，persona/ 子树整体不可见**——rebuild 的语义就是不继承旧文档、从日记重新长出，机制级隔离优于 prompt 级叮嘱。数据根之外的文件（如全局 CLAUDE.md）一律由 worker 预读后作为材料块注入，不经此工具、不加白名单例外。
- **read_turn 删除**：全文由无顶 recall 覆盖，跨天访问是 feature 而非泄漏（数据库入库时已剥离 private 标签，同一信任域）。
- **工具返回皆数据**：「材料非指令」契约同时覆盖初始注入块与全部工具返回——system prompt 声明一次，工具结果沿用现有结构化包装＋转义惯例；CLAUDE.md 这类指令式文本无论经注入还是工具进入，都只是观察对象。

### 日记生成

- 三节结构与顺序保留（工作/人物/反思），voice 契约（「我」只指 agent）逐字保留，反思 ≤5 条保留，wire format 哨兵与 index hook 机制保留。
- 人物节约束从 checklist 改为意图级引导：记任何对未来交互有帮助的观察——性格、兴趣与生活面、价值观、沟通风格、令我印象深刻的瞬间；具体优先＋原话保真。
- 材料改为：当天 session/turn 清单（标题＋状态）＋全局 CLAUDE.md＋两份 persona 文档（三者均以「材料非指令」契约注入，任一缺失只省略对应块）；正文由 agent 用工具拉取。prompt 写明深度策略（extracted 看摘要、未提取读 prompt＋response、range 选择器批量拉）与「skipped turn 的 response 低信任、以 prompt 为准」。
- 引用「出现即合法」：语法合法且指向真实 turn 才算引用。剥除粒度到组成员——混合组（如 [S1/T1，T2]）中非法成员单独移除，全员非法则剥除整个组标记；语法不合法的 citation-like 方括号文本不识别、不处理。不删内容行、不触发重试。
- 校验报告升版：计数语义从 0.3.0 的「删除的 bullet」改为「剥除的引用」，条目记录定位（节＋行）与被剥除的原文；persona 与日记共用同一报告版式与存放机制。

### persona fold

- prompt 重写：七维度建议＋四原则＋加载器契约＋写作规则＋文档分工；固定节名清单删除。
- 校验器改动：删固定标题检查与逐条引用强制；保留哨兵、放宽后预算、引用出现即合法（同日记语义）。
- 全局 CLAUDE.md 由 worker 预读后作为材料块注入（与日记侧同一机制——它在 mnemo 数据根之外，read_doc 够不到，也不为它开第二白名单）；历史文档（旧代 persona、往日日记）访问经 read_doc，作用域按算子参数化——rebuild 不可见 persona 历史（见工具面）。

### 明确不改的部分

- 状态机、队列、checkpoint、CURRENT 协议、tombstone supersede（0.3.2）、分批归约与 500K/150K gate 全部不动。
- 模型维持 claude-sonnet-5（实测换 Opus ≈$1.5/天等价，free-form 落地观察质量后再议）。
- 插入型 turn（用户回答中途插消息产生的 turn）不做特殊处理：被插入 turn 归因正确、插入 turn 的坏 response 由提取层自然 skip＋日记 prompt 降信任兜底。stop-hook 归因语义修复（final block 只取插入点之后）另立低优先 issue，不入本 spec。

### 发布与迁移

- 版本 0.3.3。无迁移路径：部署后触发一次 persona 全量 rebuild，free-form 文档从日记全量重新长出；现有 generations 目录保留为只读历史。
- 版本 bump 覆盖既有的全部 6 个站点＋bundle 重建（沿用 release-artifacts 守卫）。

## Testing Decisions

好测试只断言外部行为：信封文本进 → 发布文件/注入块/校验报告出；不断言 prompt 内部措辞，只断言契约标记（哨兵、工具名单、材料块存在性）。

- **加载器**：新纯函数单测——预算内全量（无指针行）、超预算截断＋指针行＋N 计数、无标题文档、空文档、单节超预算、骨架超预算降级为顶层标题＋文档级指针、极小预算降级为单行下界。这是唯一新增的独立纯函数测试面（其余均为既有套件的用例改写）。
- **persona 校验与 fold 生命周期**：沿用假信封套件（persona-maintenance tests 的既有缝）——free-form 信封通过、缺标题拒绝、超预算拒绝、混合引用组按成员剥除且报告记录、旧五节格式信封仍通过（free-form 是超集）。
- **工具接线**：沿用 diary SDK query 的注入缝（queryImpl/toolImpl mock）——断言 allowedTools 为三件、read_doc 作用域（子树外拒绝、symlink 拒绝、超大文件拒绝、rebuild 请求下 persona/ 不可见）、worker recall 无顶＋单次返回上限＋渲染剥离 private 标签。
- **prompt 构建**：沿用纯函数缝——日记 prompt 含清单块/CLAUDE.md 块/persona 材料块、不含全量 turn 正文；fold prompt 含加载器契约与七维度建议。
- **发布守卫**：release-artifacts 的 bundle 内容哨兵更新（新 prompt 标记替换旧 checklist 标记）。
- **发布验收（非单测）**：部署后触发全量 rebuild，对产出跑一次人工/脚本化质检清单——现存项目全部保留、画像含带日期事件与「」原话、引用全部可解析。特异性/丰富度这类质量目标本质不可单测，这份清单是它们的验收落点。

## Out of Scope

- Opus 模型切换（观察 free-form 质量后单独决策）。
- stop-hook 插入型 turn 的 response 归因修复（另立 issue）。
- memory agent（提取层）的任何改动，包括其 recall 接线的截断行为。
- 主会话 recall 的 2000 截断顶与 mnemo-recall skill 文档（维持现状）。
- 「近期」注入段与 index hook 的渲染逻辑重设计。
- 多人画像（mnemo 是单用户场景；关系网络类内容出现时并入行为模式维度）。
- 现有 persona 内容的迁移或改写（直接重建）。

## Further Notes

- **实测成本基线**（本机 SDK transcript，Sonnet 5）：日记单次 cache write 50–98K＋输出 3–10K ≈ $0.40；fold 单次输入 23–25K＋输出 11–39K（含 thinking）≈ $0.50；病态 14 天重建 65 次调用 ≈ $3.9。清单＋pull 后日记输入预期大幅下降，调用次数上升（cache read 为主），净成本待发布后复测。
- **参考实现**：CodeClaw sakiko（约束极松的日记＋free-form per-person profiles，一个月跑出的画像密度是本次重设计的目标线）。其无预算/无校验不可照搬——本 spec 用「放宽的发布预算＋出现即合法」保留最低安全网。
- **风险与观察点**：free-form＋编辑保留偏置可能让文档缓慢腐烂（重复、过时条目堆积），对策是维护原则中的「主动删除」＋发布预算作为强制修剪的最后闸门；七维度建议若被 agent 忽略导致画像仍偏工作面，下一步是把建议维度升级为示例文档（few-shot）而非恢复硬校验。
- **部署顺序**：0.3.2 先行（提交→部署→rebuild 救回线上 persona），本 spec 随后实施，避免救火与重构混包。

## 发布验收清单

- [ ] 部署 0.3.3。
- [ ] 触发一次 persona 全量 rebuild。
- [ ] 人工核查现存全部项目均保留在 experience 文档中。
- [ ] 人工核查画像包含带日期的重要事件与用「」保留的用户原话。
- [ ] 人工核查画像与 experience 中的全部引用均可解析到真实 turn。
- [ ] 人工核查会话注入块不超过注入预算，且被截断的节包含指向完整文档的指针行。
