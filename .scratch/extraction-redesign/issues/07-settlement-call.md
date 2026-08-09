# 07 — 结算调用本体：语境装配与原子写回（P2）

**What to build:** Sonnet 无状态结算调用的全部内容（spec D9）。语境装配走生产接口：窗口 turn（笔记 + 琐碎 turn 的截断原文）、前 50 turn 的 recall collapsed 渲染、开放段列表、活跃主题注册表、里程碑/current session 注入构建器；不足时结算自行 recall 下钻。职责：段依附判定（判定表：同主题同段续、静默久新段、无主题先搜后铸，铸新必须陈述无候选理由）、段身体撰写（结论先行、S/T 格式引证成员→解析为 anchor）、边分类补充（四候选来源定关系类型）、type/tag 复核多值化（含回退）、session summary 维护（沿用现有预算合同）、洞的补写——**中间洞必补**：认领清账的 pending 中其后仍有 noted turn 者，随窗注入截断原文（prompt+response，~1000 token/turn），产出重建笔记并带结算侧 provenance；尾部洞与活会话 aged 洞停留为主（确需时凭 replay）。写回：结构化输出 schema，按 session 分区的副作用与游标在单一成功事务提交、带 job generation 校验；开放段重写走 06 的 revision CAS，冲突段以补充小事务重放。密度纪律与主题铸造率计数入监控。

**Blocked by:** 05 — 结算作业基建；06 — 段/主题/边 schema 与机械层。

**Status:** done

- [x] fixture 窗口端到端：段/成员边/引用边/type/tag/session summary 一次事务落库
- [x] generation 过期的写回被整体丢弃（迟到作业测试）
- [x] 段 CAS 冲突触发补充重放，不回滚已提交分区写
- [x] anchor 从段身体的 S/T 引用解析而得，非法引用不入
- [x] 中间洞（后有 noted turn 的 skipped(closed)）获原文注入并产出带 provenance 的重建笔记；尾部洞不注入不补写
- [ ] S1730 离线回放抽查：段粒度与日记行粒度相当（人工 spot-check 记录在案）— **deferred**：需要生产库数据，本票在隔离 worktree 中不得触碰
- [x] 每窗新主题铸造数落监控计数

**实现落点：** `src/worker/note-settlement-context.ts`（语境装配、中间洞派生、曝光台账登记）、`src/worker/note-settlement-prompt.ts`（英文职责提示词 + 输出 schema 文本）、`src/worker/note-settlement-response.ts`（结构化输出解析，整批拒收）、`src/worker/note-settlement-writeback.ts`（单事务写回 + 冲突段补充重放）、`src/worker/note-settlement-dispatch.ts`（载荷本体 + 监控计数）、`src/worker/note-settlement-sdk-query.ts`（子进程调用）、`src/worker/server.ts`（旗标开启时注入真载荷）、`src/db/schema.ts` + `src/db/shadow-notes.ts`（`writer_origin` 列）、`src/metrics/p1/*`（三处查询加 origin 过滤）。测试：`tests/worker/note-settlement-call.test.ts`、`tests/metrics/p1-settlement-origin.test.ts`。

## Comments

**实现记录（本票落地时的取舍，后续票需知）**

- **type/tag 复核只落在段上**。06 没有给 turn 建多值 type/tag 列，且 P1 影子隔离禁止改 turns 行；`applySegmentWrites(source:"settlement")` 已经是「回退值仅结算可写」的唯一执行点。turn 级 type/tag 复核若确需，属 08/09 的 era 切换范围。
- **单事务的边界含作业完结与游标**：写回自己在同一事务里做 `completeNoteSettlementJob` + `advanceNoteSettlementCursor`，调度器随后那次完结是幂等复述（CAS 只比 generation，不比 status）。这样才满足「分区副作用与游标推进在单一成功事务内」，同时 05 的作业机器一行未改。
- **generation 栅栏在事务内最先执行**，且在任何写之前返回，所以迟到作业不是「回滚」而是「从未写」。
- **anchor 边 = `builds-on` / provenance `text-ref`**；模型显式分类的边落 `judged`。同一 (citing, cited, relation) 两者都出现时按 06 的升级格自动取 `judged`。方向上「段 builds-on 被引 turn」读得通，而 `evidence-for` 反了。
- **曝光台账由装配侧写入**（source=`injection`，ride turn = 窗口末 turn）。不写就没有任何段身体引用能过 `validateReferences` 的曝光闸。段曝光集 = 注入的开放段 id，走 `exposedSegmentIds` 参数。
- **type 词表越界 = 整批拒收**（在解析器里判）。`normalizeTypeValues` 对未知词抛异常，若留到写回会在事务中途炸；解析器拒收把失败点收到一处，且符合本票「malformed 整批拒收」的规则。
- **CAS 冲突重放会再发一次模型调用**（窄提示词：最新段身 + 本窗想写的内容 → 合并段身），每段至多一轮；段若已冻结/消失则不重放，只记日志——D6 说冻结段用边推翻，不重写。
- **`shadow_notes.writer_origin`**（`agent` / `settlement`，默认 `agent`，ALTER 迁移）。P1 三处指标查询（compliance 的 writer_model 众数 / 债务 LEFT JOIN / 无债笔记计数、blind-pairs 候选、misattribution 的 shadow-note 通道）统一加 `agentAuthoredNotePredicate()` 过滤，否则结算补写会伪造遵从率。
- **重建笔记只允许写本窗口的中间洞**：写回侧持有中间洞 turn id 集合并拒绝其余（尾部洞、aged 洞），所以模型多产出也不会污染台账。
- **监控计数走结构化日志行**（前缀 `[claude-mnemo] note-settlement`，含 `topicsMinted`/`topicsReused`/段数/边数/洞数/CAS 冲突数），并可用 `metrics` 回调注入；worker logger 用 `info`，`console` 用 `log`。
- **新增最小缝**：`src/mcp/session-output.ts` 导出 `renderSessionStateInjection`（既有 bounded 渲染的入口，避免复制 2000-token 降级阶梯）。其余装配全部复用 `buildCollapsedTurnsForSession` + `formatTurnCollapsed`、`renderSessionMilestoneInjection`。
- **未做**：里程碑/timeline 注入里出现的尾部洞 prompt 前缀不做抑制——那是生产 timeline 视图自己的选择逻辑，与窗口材料预算是两个面。
