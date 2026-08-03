# 弧脊柱重设计：两阶段评分 + 统一行渲染 + 引用结算

**Status:** ready-for-agent
**Rev:** 4 — 吸收 Codex 三轮核销（9/15 闭、6 部分＋6 新缺陷，见 review-codex-rev3.md）：作业租约与升序认领、冻结成员持久化、严格批量 schema、规则豁免对齐 S#/T# 多证据模型、单元帽终止规则、改型全列处置、修复高水位游标。前两轮见 review-codex.md / review-codex-rev2.md
**Date:** 2026-08-03
**Origin:** S15069 尾段设计讨论（里程碑视图质量疑问 → 五轮实证研究 → 全链路定案 → Codex 评审）

## Problem Statement

用户需要「只读 20% 的 turn 就掌握一段 250-turn 工作弧的大局与决策弧」，但当前系统在三层同时失效：

1. **评分层**：到达时即时评分系统性漂移（G3 库存 27.5% vs 重评后 19.6%，主因是诊断链每步都拿 G3；G4 全纪元只有 0.5%，弧起源常因零工具调用被 skip 规则先吞掉）。任务因果本质是回溯性质的——到达时每个决策都像改变了弧，只有事后才知道哪些活下来。
2. **选择层**：里程碑加权打分是加法混分，bonus 跨度（insight 2 + spec 3 + 引用 4）超过整个等级量程，而 insight 在 G2/G3 上无判别力（73.2% vs 74.8%），导致 G2+insight 压过 G3 无 insight 的系统性倒挂；日预算一族常数与等级互相拉扯；基础分不做 era 门控而内容分做（同文件半套门控，761 条旧语义等级直接喂进基础分）。
3. **渲染层**：等级完全不显示；注入路径在预算压力下将标题降到 50 字符（80→50 的静默降级档，实测标题 P50=72，结论半句被砍）；现有渲染虽经 correction/reference 机制带出最多 2 条 ↳ 前件行，但非系统性拉入——盲测证实纯看行会得出方向相反的重建（两次大反转在受害行上零标记），每个 G3 平均拖 0.68 个 G2 前件；G1 的派发 turn 占主行、真结论压成 ↳ 阴影行的倒挂实例存在。（以上为部署快照上的实测；行为细节以源码为准。）

另有捕获层缺陷：compact 边界打点 9 次只成 2 次（PostCompact 只认领最新边界＋落盘竞态＋promptId 被抢注致幻影 turn），~138 条 turn 的 promptId/行号链接缺失影响按 promptId 关联 transcript 的读取面。

## Solution

一条因果链上的四处联动改动，合成一个包（压缩与拉入必须绑定，只做压缩会丢信息）：

1. **两阶段评分**：提取时评暂定等级＋写结构化引用；每跨 K 个已提取 turn 触发一次结算，由提取 agent（工具面含 timeline 与 recall）对 trailing 窗口重评。目标分布 G4/G3/G2 ≈ 2%/10%/25% 作为每次评定的校准提示。机械信号只做确认（入度≥1），降级必须过模型。
2. **引用结构化**：独立边表 `turn_citations` 成为机器源；supersedes 与 implements 强制；行内 `[T<n>]` 保留给人读。
3. **统一行渲染器**：turns 视图、弧（milestones）视图、SessionStart 注入的 milestones 段共用一个行渲染器；等级直读；脊柱行带 desc、↳ 拉入行只带 title；🚫 行带反链。渲染单元 = 脊柱行＋其 ↳ 行，单元预算上限 100 token，全局预算下按分数从低到高先降 desc 再移除单元。
4. **捕获修复**：compact 边界认领与链接 reconcile 移到 UserPromptSubmit（增量扫描、带持久游标），SessionEnd 兜底；PostCompact handler 整体移除。

算术：(2%+10%) × 1.68 拉入系数 ≈ 20.2% 读者负载；250 turn → ~30 条脊柱 + ~20 条拉入 ≈ 50 个关键 turn。100 token 是单元上限而非配额（完整脊柱行约 70-85 token，均值随降级混合浮动），全局预算 2500 兜总量（锚集合是唯一允许的超预算残量）。

## User Stories

1. 作为未来会话的 agent（读者），我希望只读弧视图的 ~50 行就重建一段 250-turn 工作弧的大局与决策弧，从而不必逐 turn 下钻。
2. 作为读者，我希望每行直读等级标记，从而「多重要」不再靠 type 图标和标题动词推断。
3. 作为读者，我希望被推翻的结论行带「→被 T<n> 推翻」反链，从而不把已被否定的结论当作现行事实。
4. 作为读者，我希望脊柱 turn 引用的 G2 前件以 ↳ 行出现在其下方（跨脊柱去重、首个引用方名下渲染），从而「推翻了什么」「基于什么证据」不断链。
5. 作为读者，我希望脊柱行的 desc 提供过程与证据（~50 token）、title 提供结论（~10 token）且互不重复，从而 17 类下钻歧义中的 14 类在行内解决。
6. 作为读者，我希望用户原话前缀出现在行内、task-notification 类 prompt 自动塌缩，从而标题之外的转折信号可见且不占预算。
7. 作为用户，我希望 SessionStart 注入的 milestones 段就是 timeline 弧视图的调用结果（state/recent/digest/persona/rules 各段不变），从而注入与工具视图不再是两套渲染。
8. 作为用户，我希望注入超预算时按分数移除低分单元（先降 desc 再移除、移除折回 +N more），而不是静默把所有标题砍半。
9. 作为提取 agent，我在每次评定时看到 trailing 窗口实际分布与目标分布并排，偏离过多时新 G3 须通过指名设计工件的 before→after 判别。
10. 作为提取 agent，我把对前件的消费写进结构化 cites（含 relation 类型），从而结算不再从叙事散文里 regex 引用。
11. 作为提取 agent，我持有 timeline 与 recall 工具，从而结算时能拉取窗口弧视图、并对降级候选下钻核实。
12. 作为结算过程，我以持久化的结算工作单元运行（水位线游标、原子批量写、每轮变更摘要留痕），从而重试幂等、不产生半写状态。
13. 作为结算过程，我产出 supersession 反链与受害者降级（由 supersedes 边直接推导，不再依赖受害行先被打 tag），从而渲染反链与等级结算是同一趟的两个输出。
14. 作为用户，我希望弧起源 turn（确立当前任务弧的动机/问题/成功判据）被评为 G4——即使是零工具调用的纯讨论 turn——且该评定是暂定的，结算按弧的实际规模确认或降级。
15. 作为读者，我希望被脊柱引用的 skipped turn 能作为 ↳ 行复活（新数据有最小标题，存量以 prompt 前缀充当）。
16. 作为用户，我希望 compact 边界在下一次 prompt 到达时被幂等认领（以边界 UUID 为身份键），promptId 被抢注的幻影 turn 被事务性改型修复。
17. 作为 recall/replay 使用者，我希望 turn 的 promptId/行号链接被 link-only 补齐（只填 NULL 字段、绝不改写既有内容），从而按 promptId 关联 transcript 的缺口收敛。
18. 作为规则挖掘管线，我希望被 rule_events 引用的规则类 turn 豁免引用降级，从而持久规则不因「永不被引用」而被机械误杀。
19. 作为用户，我希望旧数据（era 前、旧 title/desc 风格、无结构化引用）不需重提取即可在新渲染与新结算下工作。

## Implementation Decisions

### A. 两阶段评分与结算工作单元

- 提取时等级为**暂定**。结算是一等公民的持久工作单元：
  - **触发与口径**：K 与 H 均按「同一 session 的已提取（extracted/skipped 计入分母、见校准节）turn 数」计（K=50）。跨界时**枚举全部被跨过的边界**（49→151 产生 50/100/150 三个作业）；每个作业的输入以其边界**冻结**（窗口 = 止于该边界的 trailing H 行，不随执行时的尾部漂移）。SessionEnd 收尾作业仅当「修复前活动快照为真 且 terminal 数 > 最近成功边界」时入队，身份同键。
  - **持久作业**：新表 `settlement_jobs(session_id, boundary, frozen_member_ids, status: pending|claimed|done|failed, attempts, claimed_at, change_summary, 时间戳)`，`UNIQUE(session_id, boundary)` 防重。**冻结成员在入队时持久化**——此后 turn 的终态变化不改变 cohort。**认领与顺序**：每 session 同时至多一个 claimed、按边界**升序**认领（CAS pending→claimed 置租约 claimed_at），提交因此天然有序；租约超时（10 分钟）的 claimed 回收为 pending；failed 且 attempts<3 回收为 pending，attempts=3 置终态。游标 `lastSettledBoundary` **只在成功事务内推进且单调**（推进到最高的连续完成边界）——入队不动游标，失败不丢工作。
  - **执行**：由提取 agent 执行（dream 只顺手纠正，非主责）。其工具面**新增 timeline 与 recall**；输入为 trailing H=100 窗口的弧视图渲染＋机械信号三件套（每 turn 被引用数、supersession 事件、零入度暂定 G3 名单）。
  - **写协议**：结算是独立的 worker 消息类别（非 turn 工作；消息契约显式授权在冻结窗口内改写既有记录）。模型输出为严格 JSON 批量 `[{turnId, grade}]`——每元素恰好两键，turnId 为冻结窗口内**唯一**整数，grade 为 0-4 整数；未知/越窗/重复 id、越界 grade、多余键、缺字段任一命中即**整批拒收**置 failed，无半写；空数组合法（=全确认无改动），部分覆盖合法（未覆盖=不变）；成功则等级、supersedes 派生反链、change_summary（每条 old→new）与游标在单事务落库。remember 的现有单条嵌套 regrade 保留用于提取中途的目击修正。
  - **机械规则只有确认方向**：入度≥1（任意等级引用方）自动确认。降级一律过模型（实测纯机械降级误杀 ~10% 真 G3）；降级候选逐个允许 recall 下钻。
  - 不加宽结算窗口（引用距离 p50=2/p90=11，漏引是结构性的）。
- **校准提示**：分母为窗口内全部 turn（含 skipped 与 ungraded，与现行块及评分时可见性一致）；窗口样本 <30 turn 不出百分比；渲染 trailing 实际分布 vs 目标 G4/G3/G2 ≈ 2%/10%/25%，注明「大部分 turn 应是琐碎/重复/中间过程」；**偏离判据**：窗口 G3 占比 > 15%（目标+5pp）时新 G3 须指名改变的设计工件（文件/spec/schema/接口、评测方法、或以 supersedes 引用的被推翻结论）及 before→after，说不出则评 G2。只做举证门，不做机械 floor。现行密度警报删除；断言旧行为的校准测试同步重写。
- **等级可变性与消费方**：结算改写等级**不**触发 diary 失效（diary 不读等级，等级变更不改变叙事内容；如未来 diary 消费等级，再把 grade 纳入其失效比较）。timeline/注入读当前值。
- **era 门控修复**：基础分与内容分同样按 era 门控；见 §C 真值表。

### B. 结构化引用（边表）

- 新表 `turn_citations(citing_turn_id, cited_turn_id, relation, created_at_epoch)`，主键 (citing, cited, relation)，`cited_turn_id` 建索引（入度是主查询）。relation ∈ builds-on | implements | supersedes | evidence-for。
- **写入契约**：remember 的 turn 输入新增可选 `cites` 数组，元素严格 `{id: 整数, relation: 枚举}`。流式重放语义为 **replace-set**：每次给出即携带该 turn 当前完整边集、整体替换先前边；字段缺席＝不变；显式空数组＝清空并置记录标志。校验：id 必须解析为已存在 turn；无效/未来 id 与**自引用**丢弃并记日志（自引用会让 turn 自证入度、击穿结算唯一的机械确认规则）；重复边去重。turn 更新、边集替换、嵌套 regrade 在**同一事务**内。
- **从无 vs 为空**：以每 turn 的 `cites_recorded` 标志（与边写入同事务置位）区分——未置＝legacy 回退行内解析；已置＝以边表为准（空即确无）。不用创建时间做谓词（部署前创建、部署后才提取的 turn 会被误判）。结构化与行内不一致时结构化优先。
- **引用完整性与跨会话语义**：两端 id 均 `REFERENCES turns(id) ON DELETE CASCADE`（随 session 级联清理）。跨 session 边仅作 provenance——**不计入**确认入度、受害降级与 ↳ 渲染三个会话内算法。入度按 **DISTINCT 引用方 turn** 计（同一引用方的多关系边只计一次，防虚增确认）。
- **supersedes 边直接派生**受害者标记与反链——不再要求受害行先带 rolled-back tag（修复「部分推翻不触发」与「corrector 先于 victim 检查」两个旧缺陷）。
- **存量行内解析器**升级为字面文法并配正反 fixture（每例含期望展开的 DB-id 数组）：单引用 `[T8501]`；逗号列表 `[T8075, T9824]`（空格可选）；闭区间范围 `[T8942-T8964]` 展开上限 8、超限只取两端；带注解形式 `[T9019 approval]` 取前导 id；无数字/畸形整体忽略；跨形式合并去重；id 一律为 DB id 命名空间；dangling 忽略。
- **消费方清单**：timeline 选择/结算读结构化（era 前经行内适配器）；task-skeleton 的 reprime 与 diary-material 的行内改写**有意保持文本路径**（它们渲染散文而非图），可能的图/文不一致接受并记录，迁移不在本 spec 范围。
- 强制引用类（提取提示词）：supersedes（陈述推翻/证伪/替换者必须引用受害者，标错比漏标更毒）；implements（执行先前锁定决策者必须引用该决策——所有明确误降案例属此类）；明确允许并鼓励引用紧邻 turn。
- **规则类豁免**：解析规则子系统的**规范引用命名空间** `S<session_id>/T<prompt_number>`（经 session＋prompt 解析为 DB turn id；dangling 不豁免）。豁免集 = proposed 事件的**多证据引用**（实现即要求 ≥2 条 evidence refs）所指 turn ∪ judgment 事件经 `source_event_id` 追溯到源事件的引用所指 turn。不使用单数 turn_ref、不假设 `[T<n>]` 形式。豁免仅阻止**引用零入度导致的降级提名**，不阻止模型或用户的显式改评。

### C. effGrade 真值表与保留优先级

- **effGrade**：
  | 情形 | effGrade |
  |---|---|
  | era 内已评级 | 原值 |
  | era 内未评级 | 0（不入池，待评） |
  | era 前（legacy） | type 映射 {decision:3, feature/refactor/bugfix:2, change/discovery:1, 其余:0}；artifact 类无文件→0；有 insight +1；**封顶 3**，永不为 4，永不 always-keep 锚 |
- **优先级（按序应用）**：① 受害者降级：被 supersedes 边指向 → effGrade=min(effGrade,1)，失去脊柱资格（**先于**②，corrector 自己又被推翻不保锚）；② corrector 晋升：effGrade=max(effGrade,3)；③ always-keep：端点 ∪ 非受害 corrector ∪ 无 corrector 的被推翻者 ∪ era 内 effGrade=4；`type='compact'` 不入 always-keep 与 kept 槽位；④ 脊柱准入：effGrade≥3；⑤ 拉入：被已准入脊柱经引用边（era 前经行内适配）引用的 effGrade≤2 turn（**含 skipped**），渲染为 ↳；⑥ 预算降级排序作用于以上结果集。
- 交叉情形：legacy 端点→按③保留（结构性、与等级无关），渲染为紧凑行；G0 corrector→②晋升（除非①先命中）；被引用 skipped→↳ 行，新数据有最小标题（见 §E），存量以 ≤60 字符 prompt 前缀充当伪标题；被推翻的 G4→①降级，锚由其 corrector/再奠基承接。
- 删除：type 基础分表（仅存于 legacy 回退）、tag-family 权重、files 空守卫、日预算一族常数。tie-break 维持现有次序（分数→工具数→更早 prompt）。

### D. 统一行渲染器与预算

- 一个行渲染器服务三个表面；**注入矩阵范围**：统一渲染器只替换 SessionStart 的 milestones 段，state/recent/digest/persona/rules 各段与其触发矩阵不变。
- 行密度两档（原型定型）：

```
脊柱行:  T48 ⚖️ G3 如果原文没有写卷数怎么办，从下游消费来看… → Scrapped volume-anchoring; adopted experience-cursor slicing  ✏️distill_cards_v2.py
             User questioned whether volume numbers are even needed downstream, exposing the
             volume-anchoring axis [T47] as a design misstep — the 12-14% error was structural…
拉入行:  ↳ 🚫 T43 ⚖️ G2 Selected gpt-5.6-sol as distillation teacher →被T48推翻
```

- title=结论（~10 token）；desc=过程与证据（~50 token 可伸缩）；desc 不重述 title；↳ 行只含 title（🚫 追加 ~20 字符反链）。task-notification 前缀塌缩为标记。
- **渲染单元与预算**：单元 = 脊柱行＋归属它的 ↳ 行；**每单元 ↳ 上限 4**，超出渲染为 `↳ +N 前件`（recall 可查）；被多个脊柱引用的前件在**时间最早的引用方**名下渲染一次，其余引用方行内保留 `[T<n>]`；任何单元被移除后，其名下共享前件**重归属**到仍保留的最早引用方（沿用稳定 tie 序，迭代至不动点）。单元上限 100 token 为**硬上限**，终止规则依序：截 desc → ↳ 折叠入 `+N 前件` 直至适配 → 对标题行（↳ 标题先于 spine 标题）做 token 级截断（Han 感知、带省略号）——titleCap 是字符上限，token 硬帽由此步保证；全局预算（注入默认 2500）不足时按分数从低到高先「desc→title」再移除整单元；always-keep 单元可降 desc 但**不可移除**——若降无可降的锚集合仍超全局预算，照常渲染并附一行超预算注记（绝不静默丢锚）；`+N more` = 当日未作主行渲染的 turn 数（↳ 不计入）。token 计量用 `estimateDiaryTokens`（Han 感知、确定性）；「~50 token」指 desc 正文，完整脊柱行含标签约 70-85 token，100 为上限而非均值。
- **视图契约保全矩阵**：`view` 名称不变（turns/milestones/phases）；phases 不动；pageSize 继续按主行计数、↳ 随行不占页槽（现行为保留）；turns 视图保留 line/time/gap/stats 列并新增等级列；shape signals 各视图保留；`titleCap`（默认 100 字符）与 `tokenBudget` 为注入内部参数，**不进公开 MCP schema**（公开视图以分页为唯一尺寸机制）。旧四档降级与渲染后字符串手术删除。

### E. rubric 修法包（提取提示词）

1. 链条规则：诊断→决策→定稿链条中只有落地改变的 turn 评 G3，证据 turn 评 G2。
2. **G4 起源义务（弧作用域）**：当前任务弧（以 reprime 骨架/新的顶层 ask 划界，同 session 可有多弧）内尚无 G4、且本 turn 确立其动机/问题/成功判据 → 评 G4；该评定为暂定，结算按弧实际规模确认或降级（短命任务降 G3/G2），从而不与「同弧仅一 G4、再奠基须引用」冲突。
3. worked example（泛化）：起点提问=G4；spec 定稿、核心机制锁定=G3；关键问题的发现节点、spec 的重要修正=G2；派发 worker、跑查询、更新文档=G1；重复尝试、无结论轮询=G0；发布/提交本身=G2。
4. 反例与正例入列：发布/提交=G2、派发=G1；eval-validity 缺陷的**发现**=G3。
5. skip 判定不得只看工具调用数；**skipped turn 也须给一行最小标题**（供引用复活渲染）。
6. 等级落在重发的终稿 turn，不落在断裂草稿。
7. title/desc 措辞与结构化引用义务（见 §B、§D）。

### F. 捕获修复

- **UserPromptSubmit**（创建新 turn 之前，10s 预算内）：
  - 增量扫描：session 持久保存扫描游标 = **字节偏移＋最后完整提交行号**；从字节偏移 seek 起读（5MB 上限由 seek 保证、不重扫）；**绝不越过不完整的末行**（游标停在其前）；单次上限 5000 行，超限处理已读部分、余量顺延下次事件。SessionEnd 截断扫描的余量在同一 content session 的下次 resume 事件恢复；若再无任何后续事件，漏认领接受并记日志（显式完备性边界）。
  - **compact 认领**：以边界 UUID 为幂等身份键（marker turn 持久化该 UUID，唯一约束）；一次扫描按 transcript 序认领全部未认领边界，**新插入的** marker 取当刻 MAX+1 编号；trigger/preCompactTokenCount 从 transcript 边界条目的 compactMetadata 读取（PostCompact 独有的 input.raw 值声明放弃）。**promptId 抢注修复（改型）**：wrapper promptId 已被普通 turn 占有时不建重复 marker，而在同事务内把该 turn 改型，**全列处置显式化**——保留：prompt_number、user_prompt、created_at_epoch、content_prompt_id；设置：type=compact、status=extracted、title='/compact'、边界 UUID、updated_at；清空：content、insight、tags、significance_grade、assistant_response、assistant_transcript、files_read、files_modified、tool_call_count、was_interrupted、was_rolled_back、extraction-stall 重试字段族；其 observations 置 skipped、其 obs/turn-stop 队列项删除（与 SessionEnd orphan 终态语义一致），防止后续提取覆盖 marker。改型测试**断言全行**。link-only 字节不变规则**不适用**于此改型路径。
  - **link-only reconcile**：新的只链接更新口——仅当 content_prompt_id / transcript_line_start 为 NULL 时填入，绝不触碰 response/status/提取字段（测试断言字节不变）。候选集 = 主链、非 sidechain、非系统注入、非中断标记、promptId 未被占有的条目；配对严格按「transcript 序 × NULL 链接 turn 的 prompt 序」推进，user_prompt 全文精确且窗口内唯一才写入；重复文本、已占有 promptId、次序错位一律跳过并记日志，不猜（编辑重发的草稿与终稿各有 turn，天然各自配对）。不做通用 turn 补建（普查实测真实 prompt 丢失=0）。
- **SessionEnd 兜底**（2s 预算）：先快照 session-run 活动判定（新 turn 门在任何修复插入**之前**取值，或修复类写入不计入该门），再跑一次有界（≤500 行）快速补扫；transcriptPath 以 hook 输入为准、回退 sessions 持久化路径、缺失则静默跳过。
- **PostCompact handler 整体移除**（评审证实 marker 创建外无其他职责）。
- 历史已漏边界不补（编号已前进），接受历史缺口。

## Testing Decisions

好测试只断言外部行为：渲染出的文本、hook 执行后的 DB 行、结算后的等级值与运行记录。

- **渲染器 seam**：fixture 会话 → 三表面渲染 → 行格式、等级列、↳/🚫、单元预算与降级顺序、`+N more` 守恒、titleCap、notification 塌缩、视图保全矩阵（pageSize 主行计数、turns 列集、phases 不变）。对抗用例：共享前件去重与移除后重归属（至不动点）、↳ 上限 4 与 `+N 前件` 溢出、四条满长汉字标题的单元硬帽（token 级标题截断终止）、always-keep 单元超预算只降不删、锚集合超全局预算照常渲染＋注记、等分 tie 稳定序、超大单行截 desc。
- **hook seam**：fixture transcript → session-init/session-end → 边界 UUID 幂等、多边界一次认领、promptId 抢注改型（全行断言：每列处置符合 preserve/set/clear 清单、观测置 skipped、队列删除）、link-only 字节不变断言、候选歧义/次序错位跳过、字节游标不越半行、扫描上限顺延与 resume 恢复、SessionEnd 活动门快照序、2s 有界。对抗用例：占用编号、并发提交、部分 JSONL 行、glance+旧 orphan 共存。
- **结算 seam**：SDK query 边界 mock 模型 → 多边界跨越一次入队（49→151 → 50/100/150）、`UNIQUE(session,boundary)` 防重、冻结成员持久化（延迟终态不改 cohort）、升序单认领与租约回收（crash-after-claim、乱序完成）、游标只在成功事务推进且单调、attempts=3 封顶、写中途崩溃无半写、批量校验拒收矩阵（未知/越窗/重复 id、越界 grade、多余键）与空批/部分覆盖语义、SessionEnd 收尾门（快照 × terminal 数）、机械确认/降级候选组装、supersedes 派生反链与受害降级、规则豁免（S#/T# 多证据解析、judgment 经 source_event_id 追溯）、era 边界 effGrade、corrector-as-victim。
- **迁移 seam**：旧库（无 turn_citations、无新列）打开即用；`cites_recorded` 谓词（未置回退行内、已置空即确无）；replace-set 重放（后发覆盖先发、缺席不变、显式空清空）；FK 随 session 级联删除；行内文法正反 fixture（列表/范围/注解/畸形各含期望 id 数组）。
- **校准块**：actual-vs-target 渲染、<30 样本不出百分比、15% 偏离触发；重写现有断言旧行为的用例。
- release-artifacts 守卫的机制哨兵（行内解析、correction graph 等符号名）随替换同步更新；全量套件绿＋rebuild 为完成线。

## Out of Scope

- 多问题 turn 的按问题分解；存量数据重提取；task-skeleton/diary-material 的引用图迁移。
- `sessions.project` 漂移 —— 独立 ticket：`.scratch/session-project-drift/`（已按评审锁定 immutable transcript 来源方案）。
- 33 条 env 消失僵尸 turn 的日级 floor；insight 管线 kill-gate 期限；phases 视图；dream 架构改动。

## Further Notes

实证基础（产物在 /tmp/mnemo_audit、/tmp/mnemo_ceiling、/tmp/mnemo_citation、/tmp/mnemo_missing_turns；评审在 review-codex.md）：

- 重评审计：153 turn 抽样、32 分歧，G3 27.5%→19.6%，主犯链式膨胀。
- 上限模拟：机械 floor 误伤:拦对 ≈ 2:1 → 只做举证门。
- 盲测收敛：盲选弧集合与重评 G3+ 15/16 重合；拉入系数 0.5-0.68 独立收敛；20% 为跨形态平均。
- 下钻日志：desc 决定性 15/17、observations 0/17；supersession 反链为最高价值单项。
- 引用审计：G3 引用覆盖 92.6%、精度 55/55、解析 100% 零 dangling；零入度 G3 中 ~2/3 被消费未引用 → 降级必须过模型；「G≥2 引用方」限制实测更糟（63→73），弃用。
- 普查：14 天 1524 prompt 真实丢失=0；compact 9 缺 7 机制闭环；~138 条链接缺失。
