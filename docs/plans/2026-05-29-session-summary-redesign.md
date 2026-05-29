# Session 摘要重设计

**TL;DR**:session 级摘要会陈旧——`insight` 字段冻在旧话题,因为写入走「省略即保留」的字段合并。本 spec 把 session 摘要改成**整体重写 + 时间轴三段(已完成 / 当前 / 待办)**,借鉴 Claude Code compact 的整体重生成,顺带砍掉与 `memories` 重叠的 `insight`、清理已死的 obs 提取路径。迁移纯增量、零回填。

## 背景:摘要为什么会陈旧

一次活体检查发现 `S1730` 的 session 记录内部不一致:`title`/`content`/`next_steps` 已刷新到当前工作(0.2.14 运维),但 `insight` 仍停在上一阶段(0.2.13 streaming 的 D0 registry / processBatchImpl)。turn 级提取又快又准,session 级却落后一个话题阶段。

根因在写入语义,不在 agent 偷懒。`handleSessionRemember`(`src/mcp/remember.ts:317-320`)对每个字段做:

```ts
const nextInsight = input.insight ?? session.insight;  // 省略 → 保留旧值
```

叠加 SQL 层同样的 `COALESCE(excluded.insight, sessions.insight)`(`src/db/schema.ts` 的 upsert)。于是**只要 agent 在刷新时没重供某字段,该字段就被冻结**。话题转向时,agent 更新了它判断「变了」的字段、省略了 `insight`,旧值便永久滞留。

> 这是字段合并(field-merge)模型的固有缺陷:刷新是部分的,被省略的字段静默冻结。

对照之下,turn 级**整条重写**(`updateTurnById` 直接 `SET title=?,content=?,insight=?`,无 COALESCE;`remember.ts:150`),agent 每次重供全部字段(slice 从 `<prior_turn>` 重建),所以永不陈旧。session 应采用同一模型。

## 设计原则

三条原则贯穿全部决策,均源自上面的根因与 Claude Code compact 的对照。

**整体重写,不做字段合并。** CC compact 每次从满窗整体重生成,所以永不陈旧。session 摘要应当成一个整体 blob 重写,而非各字段独立 merge。

**存指针,不存副本。** 重要 turn 用 `[T<n>]` 指针引用,标题读时实时解析。任何把 turn 标题、状态固化进 session 文本的做法都会重蹈陈旧覆辙。

**三层各司其职。** turns / sessions 记「发生了什么」(会话域);`memories` 记「学到了什么持久的」(跨会话)。持久知识不该塞进 session 记录。

## D1:新 session schema

session 记录从「title / content / insight / next_steps」改成下表七个字段。`content` 保留原名(浏览级梗概);`next` 是**概念/展示名**,实际 tool 参数与 DB 列仍叫 `next_steps`(见下「字段命名」)。

| 字段(展示名) | tool 参数 / DB 列 | 内容 | 刷新语义 |
|---|---|---|---|
| `title` | `title` | 一句话标题 | 重写 |
| `content` | `content` | 浏览级梗概(recall 折叠视图的 `desc:`) | 重写 |
| `decision` | `decision`(新) | 关键决策 + 理由,内联 `[T<n>]` | 重写(扩写) |
| `done` | `done`(新) | 已完成工作,内联 `[T<n>]` | 重写(扩写) |
| `current` | `current`(新) | 当前状态 | 重写 |
| `next` | `next_steps`(复用) | 待办 / 下一步 | 重写 |
| `reference` | `reference`(新) | 外部锚点:参考仓库、URL、PR、项目外路径 | 重写(扩写) |

**字段命名**:`next` 只是叙述/展示名,**不新增 tool 参数**——`remember({ id:"S.." })` 的入参与 DB 列都保持 `next_steps`(`src/mcp/definitions.ts:42` 的 Zod schema 不动,避免 strict schema 拒绝 `next` 键与测试迁移)。读侧展示时把 `next_steps` 标作「next」即可。下文凡写 `next` 均指此列。

时间轴三段——`done`(过去)、`current`(此刻)、`next`(将来)——覆盖完整状态弧。`decision` 抓本项目最看重、最易丢的内容:设计选择的**理由**(代码里没有,正是 recall-first 要召回的东西)。`reference` 是当前缺失的一类——会话倚赖的外部锚点。

「扩写」与「重写」的区别只在 agent 指令层面,不在写库层面(见 D2):`done`/`decision`/`reference` 在 `prior_` 基础上追加,`current`/`next` 整段替换;两者都经同一套整条写入。

## D2:整体重写 + prior 注入

**专用 summary 写路径,不动通用 upsert。** `upsertSession()` 有 4 个调用方:`remember.ts:327`(summary 刷新)+ `stop.ts:180` / `context.ts:300` / `session-init.ts:50`(非 summary 写,负责建行、更新 `last_agent_session_id`/`completed_at` 等元数据)。后三者**不应触碰 summary 字段**——所以**通用 `upsertSession()` 保留 `COALESCE` preserve 语义**,新增专用 `updateSessionSummaryRewrite()` 只给 `remember({ id:"S.." })` 用,对七个 summary 字段做整条写入(无 `?? keep`)。两条写路径分离,非 summary 写永不误伤 summary。

> 不要全局删 `COALESCE`:`stop.ts:180` 现在「读出再原样回写」summary 值正是被迫感知 summary 的征兆;分离后这些路径可以彻底不传 summary 字段。

**整条写有清空风险,用 prior 注入化解。** agent 漏一个字段 → 被写空。照搬 turn slice 已验证的模式:注入 `prior_<field>`,让 agent **echo-and-edit**(在旧值上改),而非从零生成。turn slice 已这么做——`<prior_turn>` 带当前 `title`/`content`/`insight`,agent 在其上精炼(`src/worker/processors.ts:304-306`)。session 刷新内联**全部七个** `prior_*`:`prior_title` / `prior_content` / `prior_decision` / `prior_done` / `prior_current` / `prior_next` / `prior_reference`。

> `prior_current` / `prior_next` **不能漏**:它们虽是「重写」字段,但 all-or-nothing 下若不注入、agent 又恰好没重供,最关键的恢复状态会被置空。注入全部 prior 是清空风险的唯一防线。

刷新因此是 **all-or-nothing**:

- 无实质变化 → 0 次 `remember()`(同现状)
- 一旦刷新 → 重供全部字段,`updateSessionSummaryRewrite()` 整条写入

这消除「刷一半」的分叉:不存在「更新 title 却冻结 insight」的中间态。

**工具层强制,不只靠 prompt。** prior 注入 + 指令只是降低漏字段概率;真正的护栏在写路径:`updateSessionSummaryRewrite()` **校验七个 summary 字段的键全部存在**(`title`/`content`/`decision`/`done`/`current`/`next_steps`/`reference`,值可为空串——`decision`/`reference` 对纯执行 session 允许空),缺任一键 → 返回 parameter error、**整条 no-op**,绝不部分写入。这样即便 agent 漏字段,也是「整笔拒绝」而非「悄悄置空」,把 all-or-nothing 变成硬不变式而非 prompt 期望。

**为什么不让 worker 拼接(agent 只供新增、worker 追加旧值)?** 那需要新增 append 写语义,且 worker 无法重组/去重——一条 `done` 项被推翻、或 `[T<n>]` 指针重复时无从收敛,文本会无界增长。agent 侧扩写可在重供时压缩措辞(像 CC compact 重生成累加段),把收敛留给有上下文的一方。

## D3:砍掉 session 级 insight

`insight`(持久教训)与两处重叠:`decision` 的「理由」往往就是教训;`memories` 表本就是持久跨会话知识的家(type=feedback/project/reference/user)。它还正是最易陈旧的字段——因为「持久知识」不属于「这个 session 发生了什么」的框架,会飘。

**处置**:停止写入 session `insight`;会话域的决策理由并入 `decision`;真正可跨项目复用的教训提升为 `memory` 记录(可 `recall(M*)` 跨会话查)。这同时消除三处冗余:`decision`↔`insight`、`memories`↔`insight`、以及那个最爱陈旧的字段本身。

**为什么不保留两者、用硬边界区分?** 边界(「换个项目还成立吗」)要 agent 每次判断,正是当初导致漂移的那类逐字段判断,较脆。直接砍更稳。

物理上**不 DROP 列**(见 D7),仅停写;旧 session 的 insight 作历史保留可读。

## D4:done / decision 内联 turn 指针

`done` 与 `decision` 用散文 + 内联 `[T<n>]` 标记引用里程碑 turn,标题**读时实时解析**:

```text
done: 发布 0.2.14 [T91] [T92];compact 阈值门控 [T87];Codex 修复 [T88]
```

解析在读侧发生(recall 展开 + SessionStart 注入,见下),把指针换成**当前** turn 标题。这与 `memories` 已有的 `[[name]]` wikilink 同一套机制:只存指针,标题永远现取,**零陈旧**。

**指针语义:存 DB turn id。** `[T<n>]` 的 `<n>` = agent 在 `<turn id="T{db_id}">`(`processors.ts:404`)里看到的那个 id,即 **DB turn id**,**不是 prompt_number**。原因是 turn block 不暴露 prompt_number,agent 只能引用它看得见的 id;强行改存 prompt_number 就得在 turn block 里加 `prompt_number` 并指示 agent 用它而非 id,更易错。读侧解析:`db_id → turns 表 → {prompt_number, title}`,渲染成 recall 风格的 `S<id>/T<prompt_number> "title"`(读 turn 时本就要取 title,顺带拿 prompt_number 零成本)。上面例子里的数字仅作示意,实际存的是 db id。

**parser 规则(闭合)**:
- **只支持单个 `[T<n>]`,不支持范围**;多个 turn 写成 `[T<a>] [T<b>]`,不写 `[T<a>-T<b>]`。语法越简单,解析越不会出错。
- **跨会话校验**:解析时必须确认 `turn.session_id === 本 session.id`。不匹配(agent 幻觉的 id、或跨会话 id)则**原样保留 `[T<n>]` 字面、不解析**,绝不解析到别的 session 的 turn。
- turn 不存在 / 已 `undone` → 同样保留字面,读侧不报错。

**为什么内联指针、而非单列 `key_turns` 数组?** 内联让指针带语境(每条完成项天然挂着达成它的 turn),且复用整条写入,不需要新列。

**为什么不干脆派生、完全不存?** timeline 已能现算 phase/burst,但那是机械启发式,抓不到「哪几个是枢纽」的语义策展。`done`/`decision` 的指针是 agent 策展的子集;全量 arc 仍归 timeline 现算,不在 session 里铺开。

### 读侧消费方与渲染策略

摘要字段只有两个消费方;**timeline 不涉及**——它只用元数据(`lastCompactTurn`/`project`/时间戳)+ turn 派生数据(`type`/`title`),不读 `content`/`decision`/`done` 等,schema 改动对它零影响。

| 消费方 | 渲染范围 | 位置 |
|---|---|---|
| recall 折叠 | `title` + `content`(浏览梗概) | `format.ts` `formatSessionCollapsedWithMode` |
| recall 展开 | **全部字段**:`content` / `decision` / `done` / `current` / `next` / `reference`,`[T<n>]` 实时解析 | `format.ts` `formatSessionExpandedWithMode`(:415) |
| SessionStart 注入 | **全部字段** | `src/hooks/handlers/context.ts:123-125` |

两处的改动点:

- **recall 展开**(`format.ts:415`):现在只追加 `insight`(:427)+ `next_steps`(:442);改成渲染全部新字段,`[T<n>]` 解析成当前标题。
- **SessionStart 注入**(`context.ts:123`):现在注入 `content`/`insight`/`nextSteps`;改成注入全部新字段。
- **旧 session 回退**:两处都在 `decision` 为空时回退显示 legacy `insight`(保留 :427 现有逻辑作 fallback),`done`/`current`/`reference` 为空则跳过。回退逻辑两处必须一致。

折叠视图保持最小(`title` + `content`),浏览成本不变;全部字段只在**展开**和**注入**时铺开。

## D5:陈旧提醒(staleness reminder)

整体重写治「刷了但只刷一半」;但若 agent 长期判断「无实质变化」而根本不刷,摘要仍会陈旧。当前注入门控(`src/worker/server.ts:449`)只在摘要**变过**时才把 session 上下文挂给 agent——摘要一直不变就永不注入,agent 连刷新的机会都没有。

加一个 staleness reminder,但**做成纯计算型,不走 turn 的 tag 机制**:

- **为什么不复用 `ReminderReason` 的 notified tag**:那套靠 `turns.tags` 列持久化 pending/notified,而 `sessions` **没有 tags 列**(D7 也只加 4 个 summary 字段);session 级提醒没有存「已提醒」状态的地方。
- **触发规则(钉死)**:baseline 用 `COALESCE(summary_updated_at_epoch, created_at_epoch, 0)`——**绝不能裸用 `summary_updated_at_epoch`**,它为 `NULL`(从未刷新的新/旧 session)时 SQL `updated_at_epoch > NULL` 恒 false,最需要首次摘要的 session 反而永不触发。`N = count(turns WHERE session_id=S AND status='extracted' AND updated_at_epoch > <baseline>)`;`N >= 10` 即判定陈旧。用「自上次刷新以来已提取的 turn 数」而非 wall-clock,贴合「积累了多少未纳入摘要的实质工作」且避开时钟问题。每次 drain 即时算,无需持久化 reminder 状态。
- **天然去重(需配合 epoch 必推进)**:一旦 agent 刷新,`summary_updated_at_epoch` 跳变 → `N` 归零 → 提醒熄灭。但现有 `remember.ts:334` 是 `summaryChanged ? now : keep`——若 agent 完整 echo 了**字节相同**的字段,`summaryChanged=false` → epoch 不推进 → reminder 永远再触发(livelock)。**修复**:`updateSessionSummaryRewrite()` 在整条写成功后**无条件推进** `summary_updated_at_epoch`(去掉 `summaryChanged` 门控)——rewrite 模型下一次被接受的全字段写就是一次刷新,无论字节是否变化。这样 stale-forced 刷新即便内容没变也能清掉条件。
- **渲染位置(钉死)**:陈旧时置 `nextBatchNeedsSessionContext`,并在注入的 session 块上加属性——`<session id="S<n>" stale_turns="N">`,块内附固定指令行「summary 已 N 个 turn 未纳入,请重供全部字段做一次完整 refresh」。属性 + 固定措辞,便于 agent 识别与测试断言。

代价:陈旧期间每次 drain 都会重附该提醒(直到 agent 刷新)。这是可接受的持续 nudge;若实测过吵,再加一个 `summary_reminded_at_epoch` 列做节流(D7 范围外,留作后续)。复用的底层件只有 `nextBatchNeedsSessionContext` 标志,**不碰 `ReminderReason` 注册表**。

## D6:清理已死的 obs 提取路径

当前 streaming 模型**不再单独提取 observation**。实证:`S1730`(streaming 时代)obs 状态为 `extracted 0 / skipped 916`;全库 `extracted` 冻结在 1045(全是 pre-streaming 遗留,而 `skipped` 持续增长)。机制上,obs queue 项被缓冲(`src/worker/server.ts:1180`),只随 mini-turn 渲染、投递后标 `skipped`;agent 提取的是 turn,不是单条 obs。

以下是 pre-streaming 逐条提取模型的遗留,应清理:

- `## Observation messages` 整段系统提示(`src/worker/query-session.ts:265-275`)——教 agent 如何提取 obs,但 agent 再也收不到独立 `<obs>` 消息;虽走 prompt cache,仍误导且占 token
- `remember` 的 `O<n>` 路由(`src/mcp/remember.ts:167`)——agent 已不调用

**处置(本轮只动系统提示,保留路由)**:目标是「去误导」,所以不能只删一个 heading——`<obs>` 语义散在系统提示多处,要一并清掉:

- 删 `## Observation messages` 整段(`query-session.ts:265-275`)
- 角色描述(`:252`)「updating SQLite records for observations (O), turns (T), and sessions (S)」→ 去掉 observations(agent 不再更新 obs)
- unit-of-work 描述(`:256`)「an `<obs>` means update that single observation」→ 删此分支(agent 再也收不到独立 `<obs>` 消息)
- recall 限制句(`:261`)「Not usable from observation or session-summary messages」→ 去掉 observation

**保留 `remember` 的 `O<n>` 路由**作为向后兼容面——它影响 MCP schema、既有测试与外部调用面,贸然移除是 release 风险,而留着只是无害休眠代码。注意 obs 块仍作为**上下文**出现在 turn 消息内(`buildObsBlocksFromItems`),那部分不动。

## D7:已有数据库迁移

仓库无 `user_version` 版本表,迁移用「`CREATE TABLE IF NOT EXISTS`(新装)+ 守卫式 `ALTER ADD COLUMN`(旧库)」,守卫靠 `hasColumn`(`src/db/schema.ts:196`,查 `pragma_table_info`),幂等、每次启动跑。本次照搬。

**Schema delta**:新增 4 个 nullable 列。

```sql
ALTER TABLE sessions ADD COLUMN decision TEXT;
ALTER TABLE sessions ADD COLUMN done TEXT;
ALTER TABLE sessions ADD COLUMN current TEXT;
ALTER TABLE sessions ADD COLUMN reference TEXT;
```

每条加进 `CREATE TABLE sessions`(新装带上)+ 一段 `if (!hasColumn(...)) db.exec(...)` 守卫(镜像 `schema.ts:128-140`)。`next_steps` 复用为 `next`、`content` 保留——**零迁移**。`insight` 列**保留、停写**,不 DROP(SQLite DROP COLUMN 有风险且无必要,就地弃用保历史)。

**数据:不回填、不重提取。** ALTER 后 ~5500 条旧 session 新列默认 `NULL`。绝不重跑 agent 提取旧 session——成本巨大而旧/死 session 价值低,它们保留旧形态当历史。新列只由今后的刷新填充。

**读侧兼容(新旧形态共存)。** ALTER 后旧 session 新列为 `NULL`,渲染按 D4 的回退处理(`decision` 空 → 显 legacy `insight`;`done`/`current`/`reference` 空 → 跳过)。旧 session 照旧可读,新 session 走新字段,不破坏任何历史。

## D8:新字段进 FTS 搜索索引

新字段若不进 FTS,`recall(query=...)` 就搜不到 session 摘要里最有价值的内容(决策、完成项)。当前 `indexSessionToFTS()`(`src/db/search.ts:217`)只把 `title`/`content`/`insight` 喂进 `memory_fts`,调用 `indexFtsRecord(db, "session", id, title, content, insight→extra)`。

**做法(无需改 FTS 表结构)**:`memory_fts` 已有 `title`/`content`/`extra` 三列;`insight` 砍掉后 `extra` 槽空出。改 `indexSessionToFTS()`:把 `decision`/`done`/`current`/`next`/`reference` 拼接进 `extra`(`[T<n>]` 指针保留原文即可,FTS 按词索引)。同步更新两处:

- 写路径:`updateSessionSummaryRewrite()` 写完后调 `indexSessionToFTS()` 重建该 session 的 FTS 行(`sessions.ts:122` 已有此调用点)
- 全量重建:`search.ts:274`/`294` 的 reindex 查询补读新列

**测试**:`recall(query=<decision 里的词>)` 能命中对应 session——这是验收点。旧 session 的 `extra` 仍是 legacy `insight`,搜索行为不变。

## 实现顺序

schema 迁移与逻辑改动解耦,可分阶段落地;建议顺序:

1. **D7 迁移**——加 4 列(纯增量,先上,向后兼容,无行为变化)
2. **D1 + D2 + D3**——新增 `updateSessionSummaryRewrite()`(整条写、不动通用 `upsertSession`)、加新字段、停写 insight;`query-session.ts` 改 session 刷新指令 + 注入全部 7 个 `prior_<field>`
3. **D8 FTS**——`indexSessionToFTS()` 把新字段拼进 `extra` + reindex 查询补列(随 D2 写路径一起)
4. **D4 读侧**——`[T<n>]`(存 DB id)解析 + 全字段渲染 + 回退,改两处:recall 展开(`format.ts:415`)与 SessionStart 注入(`context.ts:123`);timeline 不动
5. **D5 staleness reminder**——纯计算(无 tag)+ 复用 `nextBatchNeedsSessionContext`
6. **D6 obs 遗留清理**——删 `<obs>` 系统提示段;**保留** `O<n>` 路由

**开放问题**:`current` 与 `next` 是否进一步合并成单字段 `resume`?字段数(7)偏多时,这是最可能的合并点——留待实现时按 recall 渲染效果定。
