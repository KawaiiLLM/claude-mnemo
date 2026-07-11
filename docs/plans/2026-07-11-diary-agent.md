# 日记 agent spec（daily diary + persona 折叠）

> 状态：设计定稿 v6（Codex 五轮审查：r1=15、r2=11、r3=11、r4=10、r5=10，共 57 条全部采纳——落点映射见附录 B）。版本位 0.2.41+。
> 决策来源：2026-07-11 grilling 两轮 + 两次 Sonnet 实盘模拟（附录 A）+ Codex 源码级审查五轮。

**一句话**：在现有 turn 级情景底座上加第二个提取镜头——以天为单位的人物中心日记，再从日记流折叠出两个常驻注入的 persona 文件（用户画像、自我记忆），填补「只有 session 级工作记忆、没有跨会话语义记忆」的缺口。

## 1. 目标与非目标

**目标**：

- 捕获工作镜头按设计丢弃的人物信号：偏好、品味、闲聊、生活事件、表达习惯、对 AI 的反馈风格。
- 建立跨项目、用户级的语义记忆层（persona 文件），每 session 常驻注入。
- 每条语义断言可沿出处回放到原始 turn 验证。

**非目标**：

- 不修改工作提取管线（skip 规则保持原样，附录 A.2）。
- 不重建 durable M 层——存储是 md 文件 + 既有 turns 表 + 三张小状态表。
- 不做当天实时日记（次日补写，persona 滞后一天为已接受取舍）。
- projects.md 已裁决删除。

## 2. 架构总览

```text
turns（SQLite，无损情景底座）
  ├─ 镜头 1（已有）：session summary / milestone —— 项目中心
  └─ 镜头 2（本 spec）：日记 job —— 人物中心，跨 session、跨项目按天聚合
        ↓  map(当天 turns)，watermark 幂等重生成；超 gate 走分段合成（§4.6）
     ~/.claude-mnemo/diary/YYYY-MM-DD.md + INDEX.md（INDEX 可从状态表全量重建）
        ↓  fold 按日期升序；乱序修正走 rebase；大输入走分批归约 + 持久化 checkpoint
     ~/.claude-mnemo/persona/generations/<n>/（user-profile.md + self.md）
     ~/.claude-mnemo/persona/CURRENT（唯一提交点）
        ↓  SessionStart hook 注入（校准 token 预算 + 漂移监控，§6）
     每个 session 的开场上下文
```

四条贯穿原则：

1. **每层可从下层重建**：日记 = map(当天 turns)；persona 三算子中全量 rebuild 只依赖日记流。**每类 LLM 调用都有各自的 token gate 与超限切分语义**——日记 gate 500K（§4.6），persona 算子 gate 150K（§5.2）——不存在输入随历史无界增长的调用。
2. **固定注入为主，工具为逃生舱**：工具由专用 MCP 工具做代码级白名单（§4.4）。
3. **agent 不碰文件系统、不写结构字段**：agent 只产出哨兵 envelope；front-matter 与全部文件 I/O 由 worker 执行。
4. **素材是数据不是指令（prompt contract）**：所有 transcript-derived 素材先做 JSON string 编码，再将 `<` / `>` / `&` 强制转成 `\u003c` / `\u003e` / `\u0026`，以不可闭合的 JSON 数据对象注入（§4.1）——这是降低指令注入风险的合同约定，不是绝对安全保证；配 closing-tag breakout 测试。

## 3. 数据流与触发

### 3.0 规范日记日（固定 UTC+8）

「一天」= 固定 UTC+8 日历日。单一纯函数 `diaryDayOf(epochSeconds)` 是全链路唯一日界来源（SQL epoch 范围代码算好下推、文件名、「今天」排除、INDEX 键）。测试 UTC 15:59:59 / 16:00:00 边界。turn 归属日 = `created_at_epoch` 所在日。

### 3.1 状态存储

**`diary_state`（KV）**：

| 键 | 含义 |
|---|---|
| `cutover_date` | 最早可结算日；首启 =「今天 − 14 天」 |
| `last_folded_date` / `folds_since_rebase` | 缓存；真相是 `persona/CURRENT`，启动时按 manifest 绝对值校正 |
| `last_applied_operation_id` | 最后已入账 persona 操作 id |
| `rebuild_requested` | 全量 rebuild 标志；**首启置 1**（bootstrap 靠它触发）；CURRENT 损坏时由调度器置 1 |
| `integrity_cursor` | 轮转完整性检查游标（§3.2a） |

**`diary_day_state`（逐日状态）**：

```sql
CREATE TABLE diary_day_state (
  date TEXT PRIMARY KEY,
  watermark TEXT,                   -- 内容摘要 hash；"empty" = tombstone
  file_sha256 TEXT,                 -- canonical diary bytes；tombstone = NULL
  index_hook TEXT,                  -- INDEX.md 的行素材（INDEX 可全量重建）
  settled_at_epoch INTEGER,
  needs_regen INTEGER NOT NULL DEFAULT 0,
  pending_rebase INTEGER NOT NULL DEFAULT 0,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_epoch INTEGER,
  last_error TEXT,
  terminal INTEGER NOT NULL DEFAULT 0
);
```

**`persona_operation_state`（多批算子进度，§5.2a）**：`operation_id PRIMARY KEY, op, base_current_operation_id, input_dates_snapshot, batch_plan, input_artifact_dir, next_batch_index, accumulator_generation, accumulator_hash, checkpoint_path, checkpoint_sha256, attempt_count, next_attempt_epoch, last_error, terminal`。表允许保留 terminal 行供人工诊断；部分唯一索引保证 `terminal=0` 最多一行。存在任一 terminal 行时 persona 调度整体暂停，人工动作须明确选择「清 terminal 后从已验证 checkpoint 续跑」或「删除该操作并重新规划」，不得悄悄启动后续操作。

### 3.2 触发与缺口判定

- **watermark = 内容摘要**：当日素材行按 id 排序，逐 turn `sha256(user_prompt ‖ truncated_response ‖ title ‖ content ‖ insight ‖ status)`，对摘要序列再 SHA-256（截 16 hex）；空素材集 = `"empty"`。
- **候选日期集**（精确定义）：`C = DISTINCT diaryDayOf(turn.created_at_epoch)（status != 'undone' 且日期位于 [max(cutover_date, today-14), today)） ∪ 该窗口内全部 diary_day_state.date ∪ 全部 needs_regen=1 的 diary_day_state.date`，最后统一过滤 `cutover_date ≤ d < today`。这样既能发现「原来非空、后来全 undone」的日期，又不会为从未有素材的日历日建行。
- **日常扫描窗口 = 最近 14 天**。缺口条件（任一）：无 day-state 行或 watermark 不符；应有日记文件缺失，或未通过 canonical validator（严格 front-matter 的 date/watermark/index_hook、正文结构、`file_sha256`）。
- **空日语义**：已结算日素材集变空时，在**一个 SQLite transaction** 内写 `watermark='empty', file_sha256=NULL, index_hook=NULL, needs_regen=0`；若 `d ≤ CURRENT.last_folded_date_after` 且 `d` 不在 `CURRENT.partial_missing_dates_after`，同时置 `rebuild_requested=1`。DB tombstone 是提交真相；commit 后才幂等删除日记文件并按 day-state 重建 INDEX。rebuild 必须排除 tombstone。persona 中已吸收的该日断言只能靠全量 rebuild 撤销，不走普通 rebase。
- **窗口外晚到变化**：写原语集中标脏（§3.3a）置 `needs_regen=1`；扫描附带 `WHERE needs_regen=1`。
- **跨午夜/陈旧 active session**：不等待 session 关闭；只按 turn 自身 `created_at_epoch` 归日，昨日仍为 `active` 或缺 response 的 turn 以 §4.1 raw 孤儿格式结算。后续 Stop/backfill/status 写入必须走 §3.3a 标脏并重生成，因此「次日首次快照」不是不可变终稿。
- 入队：`kind='diary'`，`target_id=YYYYMMDD`，`session_db_id=0`；去重 `UNIQUE(kind, target_id) WHERE kind='diary'`。
- 成本上界：`idx_turns_created_at`；短事务入队后用 `kickWorkerFast` 做总预算约 500ms 的 health + `/wake` 或 detached spawn，失败不影响上下文返回；DB busy 静默跳过。**不得返回 `HookResult.asyncWork`**：现有 hook runner 在该字段存在时只输出 `{"async":true}`，会丢掉 SessionStart 的 `hookSpecificOutput`。

### 3.2a 轮转完整性检查（窗口外损坏的主动发现）

每次 SessionStart 额外按日期升序从 `integrity_cursor` 起检查 **10 个历史日期**（有 day-state 且非 tombstone 者），到末尾环回；全历史每 ~N/10 次启动覆盖一轮。canonical validator 同时校验文件存在、严格 front-matter 的 date/watermark/index_hook、正文结构与 `file_sha256`；失败 → `needs_regen=1`。另提供显式 `verify` CLI 全量检查；`read_diary` 与 rebuild 读取时必须复用同一 validator，失败同样标脏且不得把坏文件交给 agent。

### 3.3 worker 消化与重试

- **`diary` 显式分支**：session buffer/lock 之前拦截，用户级串行锁；kind 扩为 `obs | turn-stop | diary`。
- **claim 隔离与公平性**：现有 generic claim/buffer prune 必须显式排除 `diary`；SessionStart 使用 `INSERT ... ON CONFLICT DO NOTHING` 的专用幂等入队。每轮先清可执行的 non-diary 工作，再最多处理一个 diary，之后重新检查 non-diary，避免 14 日 backfill 连续占住 worker。
- **专用 claim**：`claimNextDiaryItem(now)` join `diary_day_state`，过滤 `terminal=1` 与 `next_attempt_epoch > now`（现有 claim 不读状态表，复用会热循环）。
- **执行参数**：总超时 10 分钟（AbortController）；无消息 watchdog 120 秒。
- **attempt 生命周期**：失败 → `attempt_count+1`、`last_error`、指数退避；3 次 → `terminal=1`、删队列行。**归零时机**：成功、新 regeneration epoch（`needs_regen` 置位）、人工清 terminal。
- **退避再唤醒**：worker 必须持有下一到期时间的短 timer；到期后经全局串行门重新 scan 持久队列。现有 watchdog 只重试内存 batch，不能作为 diary 的持久化退避唤醒器。

### 3.3a 标脏埋点（写原语集中）

`A_d` 相关字段（status/user_prompt/assistant_response/title/content/insight）的一切变更经统一 db 写原语，标脏内置原语层：变更 turn 时若其归属日已结算且 ≥ cutover → `needs_regen=1`。实现时调用点全量审计（已知：Stop 回填、orphan recovery、remember correction、subagent 置 undone、derailment、streaming 置 provisional、recovery 清字段）+ 逐路径回归测试。

### 3.4 fold 顺序门与乱序修正

- 增量 fold 仅当 `日记日期 == last_folded_date 的次一个已结算日期`；更晚 diary 可先写文件，fold 挂起。
- **结果导向判据（r4 修订）**：任何成功结算且 `date ≤ CURRENT.last_folded_date_after` 的日记——无论首次生成（如 terminal 恢复日）还是重生成——**一律不增量 fold，置 `pending_rebase=1`**，由 §5.3 吸收。
- skippedSeqs 语义对 turn/obs 不变。

### 3.5 单个 diary job 的固定管线与提交协议

```text
拼装素材（§4.1，超 gate 走 §4.6 分段）→ diary agent 产出 envelope
→ 代码逐 bullet 引用校验（§4.3）
→ 代码序列化 front-matter，临时文件 + 原子 rename 落 diary 文件
→ 更新 diary_day_state（settled + watermark + file_sha256 + index_hook）；这是 INDEX 视图的 source commit
→ 从 day-state 生成 canonical INDEX.md，临时文件 + 原子 rename；重新读取并验证与 canonical bytes 完全一致
→ ack diary queue item
→ 独立的 persona wake-tail 按顺序门创建/续跑 persona operation
→ 代次目录（fsync）→ 原子 rename CURRENT → 依 manifest 绝对值更新 SQLite 缓存
```

**INDEX 恢复语义**：`index_hook` 持久化在 day-state，INDEX.md 可随时从状态表全量重建。启动时、SessionStart 注入前以及「watermark 未变、跳过日记生成」的重试路径都先执行 `ensureIndex()`：缺失、不可解析或 bytes 与当前 day-state 的 canonical render 不同就原子重建。INDEX 尚未验证成功时不得 ack，persona 调度也不得吸收该日。

**阶段失败隔离**：diary 文件 + day-state + INDEX 验证成功后，diary queue 即可 ack；persona fold/rebase/rebuild 由独立 `persona_operation_state` 重试。persona 失败不得回滚或重跑已成功的 diary LLM，也不得阻止之后的日记文件结算；但 terminal persona operation 会按 §5.3 暂停后续 persona 发布。

**CURRENT manifest**（提交真相）：

```json
{
  "operation_id": "<uuid>", "op": "fold | rebase | rebuild",
  "generation": 124, "source_diary_date": "2026-07-10",
  "last_folded_date_after": "2026-07-10", "folds_since_rebase_after": 7,
  "consumed_pending_dates": ["2026-05-02"], "partial_missing_dates_after": []
}
```

恢复协议：`CURRENT.operation_id ≠ KV.last_applied_operation_id` 时按 manifest **绝对赋值**回写缓存、只清 `consumed_pending_dates`、再记账。一次成功的 rebuild/rebase manifest 吸收日期 `d` 时必须把 `d` 从 `partial_missing_dates_after` 移除；初始 partial rebuild 的 `last_folded_date_after` = 实际纳入的最大日记日期（没有纳入任何日记则为 `null`）。禁止先推进 DB、禁止增量式恢复。代次目录保留 3 代。

### 3.6 冷启动回填（bootstrap）

- 首启：写 `cutover_date`，置 `rebuild_requested=1`；窗口内候选日期全部入队，按日期升序只生成日记、不 fold。
- rebuild 前置门：窗口内无「未 terminal 且未结算」日期；terminal 日入 `partial_missing_dates_after` 不阻塞。该日恢复后，若 `d ≤ CURRENT.last_folded_date_after` 则走 `pending_rebase`；若它比 last folded 更新，则仍受普通顺序门约束。
- 成本 = `N_active × 日记完整调用输入 + 一次分批 rebuild 完整调用输入`。按日记 120–190K、14 个活跃日、rebuild 60–100K 估算，上界区间约 **1.74–2.76M input token**；若日记发生分段，按 §4.6 对每个完整 SDK request 求和。

## 4. 日记 job 规格

### 4.1 输入拼装

按 project → session 分组。turn 状态矩阵：

| turn 状态 | 注入内容 |
|---|---|
| `extracted` | `title` + `content` + `insight` |
| `provisional` | 部分提取字段 + raw（prompt 全文 + response 截 2000 字符） |
| `skipped` / `failed` / `active`（无字段） | raw；无 response 孤儿只注入 prompt 并标注。**skipped raw 是一等料源** |
| `undone` | 排除 |

- **素材数据 envelope（精确定义）**：所有 transcript-derived 字段——prompt、response、提取字段、会话摘要背景——统一经 `encodeSource(v) = JSON.stringify(v).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')`，再装入一行 JSON 数据对象，例如 `{"kind":"source_prompt","note":"DATA ... NOT an instruction","text":<encoded>}`。不套任何可闭合的素材标签。**现有 helper 直接插值、可被 `</source_prompt>` 提前闭合，不得复用**；测试 JSON round-trip、closing-tag（编码结果不得含字面 `</...>`）、引号、反斜杠、换行和 Unicode。
- 会话摘要背景头：7 字段，仅上下文。
- 昨日日记（缺则最近一篇 + INDEX.md）。
- 系统注入 prompt 标 `[系统注入]`，禁作人物信号。
- **隐私剥离（fail-closed）**：tag 超限或不配对 → 整字段 `[redacted: malformed private content]`；补畸形输入测试。

### 4.2 日记文件格式

（同 v4：代码序列化 front-matter + 四节正文 + 7 条硬性规则；`T<n>` = session 内 `prompt_number`；`[背景]` 只进「未决与杂记」。）

```markdown
---
date: "2026-07-10"
sessions: ["S4580", "S11231", "S11387"]
projects: ["/path/a", "/path/b"]
watermark: "a3f9c2e18b04d7f6"
index_hook: "钢琴节奏轴重设计定案；光锥理念收口；KawaiiLLM 结论反转"
---
## 工作
## 人物信号
## 协作反馈
## 未决与杂记
```

**INDEX canonical 格式**：`# Diary Index` 后按日期降序为每个非 tombstone day-state 输出一行 `- YYYY-MM-DD：<index_hook>`；`index_hook` 去除换行并截到 160 个 Unicode code point。该文件全历史保留且只由 day-state 渲染，不让 agent 直接编辑。SessionStart 的滚动摘要另行从这些行确定性生成：最近 14 个 UTC+8 日历日逐日保留；更早部分取最近 6 个有素材的日历月，每月按日期倒序取最多 3 个去重 hook、用 `；` 连接并截到 240 code point，格式 `- YYYY-MM：...`。

### 4.3 引用校验（代码，落盘前，逐 bullet）

`A_d = {(session_id, prompt_number) | diaryDayOf(created_at_epoch) = d AND status != 'undone'}`。前三节逐 bullet：

1. **格式门**：`\[S\d+/T\d+(?:，\s*(?:S\d+/)?T\d+)*\]`，分隔符强制；测试无分隔/半角逗号/多方括号。
2. **存在门**：≥1 引用且全部落在 `A_d`。
3. **降级**：违规移「未决与杂记」标 `[引用待核]`。
4. `[背景]` / `[引用待核]` 禁入 persona。

会话摘要背景头即使文本中提到 `S/T`，也**不扩张 `A_d`**。摘要可能概括更早日期的 turn：只有该复合引用对应的原 turn 本身属于 `A_d` 时才可通过存在门；仅由背景头支持的陈述必须标字面 `[背景]`，只能进入「未决与杂记」，不得借摘要中的旧引用进入前三节或 persona。

### 4.4 逃生舱（白名单 MCP 工具）

- `read_diary(date)`：canonical path 校验、锁死 diary 根目录；读到缺失/损坏时标脏（§3.2a）。
- `read_turn(session_id, prompt_number)`：handler 强制按**本次 SDK request 实际输入**构造 allow-set：diary map = 当日段对应的 `A_d`；diary merge = 输入 partial 的引用并集；fold = 旧 persona ∪ 新日记；rebase 批 1 = baseline persona ∪ 本批日记，后续批 = accumulator ∪ 本批日记；rebuild 批 1 = 本批日记，后续批 = accumulator ∪ 本批日记，**永不包含现有 persona**。仍不开放搜索型 recall。

### 4.5 envelope 哨兵格式（版本化）

（同 v4：`===DIARY_V1_BEGIN/END===`、`===INDEX_HOOK_V1===`、`===USER_PROFILE_V1_*===`、`===SELF_V1_*===`；块缺失/重复/超限（diary 64K、persona 各 16K 字符）= job 失败；persona 双块必须同现。）

### 4.6 日记输入 gate 与分段合成（r4 blocker 的解）

日记每个**完整 SDK request** 的 gate = **500K token**：system prompt、tool schema、envelope、背景头与素材/partial 全部计入；chunker 只能使用扣除固定开销后的剩余 material budget。超限时分段 map-reduce：

1. **切段**：按 session 块边界切进 material budget（单 session 块超限时按 turn 区间再切）；每段独立调用，产出**带完整 `[S/T]` 引用的四节局部草稿**（哨兵 `===DIARY_PARTIAL_V1_*===`）。每个 partial 硬上限 **16K 字符**，超限视为该次调用失败，不得把超长输出带入 merge。
2. **分层合成**：把局部草稿按日期内原顺序组成批；任一 merge 的完整 request 仍须 ≤500K。若一次放不下，先逐批合成新的 `DIARY_PARTIAL_V1`（保留完整 `[S/T]` 引用并同受 16K 字符上限），递归归约，直到最终 request 可在 gate 内产出日记 envelope。不存在“partial 数过多导致 final merge 无界”的例外路径。
3. **校验**：§4.3 引用校验只对合成产物跑一次（局部草稿的引用随正文进入合成，仍受同一 `A_d` 约束）。

分段路径极少触发（500K ≈ 单日 350+ turn），但语义必须有定义——「所有调用有界」不再与实测数据冲突。

## 5. persona 折叠规格

### 5.1 文件与准入边界

（同 v4：user-profile.md / self.md 准入表；`## 主题` + `- 正文 [出处]`；单条 ≤50 字、每文件软目标 ≤20 条；淘汰 = 支撑最弱→最陈旧；矛盾降级标 `（已变化）`；`[引用待核]`/`[背景]` 禁入。）

### 5.2 三算子与分批归约

| 算子 | 输入 | 用途 |
|---|---|---|
| **增量 fold** | 旧 persona + 新日记一篇 | 稳态更新，受顺序门 |
| **rebase** | 近 30 篇 + 全部 `pending_rebase` 日记 + 现有 persona（对照） | 纠漂移、吸收乱序修正 |
| **全量 rebuild** | 全部现存日记按日期升序（不参考现有 persona） | 污染恢复最终手段 |

**分批归约**：每个完整 SDK request 的输入 gate 为 **150K token**，system prompt、tool schema、envelope、persona/accumulator 与日记批全部计入。rebuild：`acc₀=空`，`accᵢ=reduce(accᵢ₋₁, 日记批ᵢ)`，acc 只由日记推导；rebase：批 1 = 现有 persona + 最老批，后续 = acc + 下一批。仅最终批走 CURRENT 提交。增量 fold 输入天然有界。

### 5.2a 多批操作的持久化进度（r4）

多批算子启动时先把 baseline persona（若算子需要）与输入日记的已验证 canonical bytes 复制到不可变 `input_artifact_dir`，记录各文件 hash，并冻结确定性的 `batch_plan`；后续源日记变化不能改变这次操作的输入。状态同时记录 `base_current_operation_id`，防止错误基线续跑。

每批先把 accumulator 写成不可变 artifact，再写 checkpoint manifest `{operation_id, next_batch_index, accumulator_hash}`；两者均 temp→fsync file→rename→fsync parent，并计算 checkpoint hash。随后才用一个 SQLite transaction 同时更新 `accumulator_generation/hash, checkpoint_path/sha256, next_batch_index`。DB commit 前崩溃只留下可 GC 的 orphan；commit 后 DB 指针必指向完整 checkpoint。续跑须校验 operation/base、artifact 与 checkpoint hash；不匹配则 terminal，不得带坏 accumulator 继续。每个成功 batch 把**批级** attempt 归零；最终 CURRENT 提交并完成 manifest→KV 对账后才清操作状态。输入快照中途被标脏不打断本次操作，新变化留给下一轮调度。

### 5.3 persona 调度（wake 尾检查）

0. CURRENT 缺失/不可解析 → `rebuild_requested=1`。
0a. **存在 non-terminal `persona_operation_state` → 优先续跑；存在 terminal 行 → 阻止任何后续 persona 操作并等待人工处置**。
1. `rebuild_requested=1` 且前置门通过（窗口内无未 terminal 且未结算日期；rebuild 前对全部应存在日记做完整性检查，缺失日期先回队列）→ 全量 rebuild；成功清标志、清全部 pending、`folds_since_rebase=0`。
2. `pending_rebase` >30 或最老早于 90 天 → 自动升级全量 rebuild。
3. `folds_since_rebase ≥ 30` 或 `pending_rebase` 非空 → rebase；成功按 manifest 清 `consumed_pending_dates`。

## 6. 注入规格

**校准预算（非数学硬界）**：估算器 CJK 1.1 / ASCII 0.6 token/字符 + 20% 余量；worker 以 SDK usage 实报做**漂移监控**（持续低估 >10% 告警收紧系数）；测试断言语料上估算 ≥ 实报。

bullet 数不是预算替代品：若每文件 25 条、每条正文 50 CJK 字，再按每条约 8 字的 Markdown/出处开销计，`2 × 25 × 58 × 1.1 × 1.2 ≈ 3,828 token`，明显装不进 2K；即使软目标每文件 20 条，最坏也约 3,062 token。因此「每文件 ≤20 条」只作内容密度软目标，**两文件合并后的估算值 ≤2K 才是硬门**；超限按 §5.1 的支撑强度/陈旧度规则继续淘汰，不能只截字符串造成半条 bullet。

| 块 | 内容 | 校准预算 |
|---|---|---|
| persona | 经 CURRENT 解析的两文件全文 | ≤2K token，超限按 §5.1 淘汰截断 |
| 日记索引 | 近 14 天逐日一行 + 月行 ≤6（代码生成），再早截断 | ≤1K token |

persona 缺失/损坏：跳过注入 + §5.3 条件 0 自愈。INDEX.md 全量保留；代次目录保留 3 代。

## 7. 实现清单

- **schema**：`diary_state` KV（含 `integrity_cursor`）；`diary_day_state`（含 `index_hook/file_sha256`）；`persona_operation_state`（active 部分唯一索引）；`idx_turns_created_at`；diary 唯一部分索引；`resetSchema()` 同步删除三张新表。
- **shared**：`diaryDayOf()`；fail-closed 剥离；校准估算器 + 漂移监控；内容摘要 watermark；**raw 转义 envelope（breakout 测试）**。
- **db 写原语**：标脏内置 + 调用点审计 + 逐路径回归测试。
- **hook**：候选集缺口扫描 + 轮转完整性游标 + `ensureIndex()` + 短事务入队 + `kickWorkerFast`；不得用会吞掉注入输出的 `asyncWork`。`plugin/hooks/hooks.json` 的 SessionStart matcher 加入 `resume`，并同步 release artifact。
- **worker**：session lock 前 diary dispatch；generic claim/buffer prune 排除 diary；`claimNextDiaryItem`；公平轮询 + 退避到期 timer；独立 one-shot Sonnet runner（不创建 session 0 query）；10min/120s + Abort；§3.5 提交/失败隔离 + manifest 恢复；§5.3 调度；`verify` CLI。
- **文件层**：所有 public store API 接受 `dataRoot`；diary commit/validate、INDEX repair、persona generation/CURRENT/recovery 统一 temp→fsync→rename→fsync parent，用真实 tmpdir 集成测试。
- **agent 侧**：专用 per-call MCP server，仅 `read_diary` / `read_turn`，不得扩宽现有长期 worker 与 public MCP 的工具合同；日记 prompt + 分层分段合成路径；三套 persona prompt + 分批驱动 + 不可变输入快照/checkpoint；哨兵解析器（含 PARTIAL 块）。
- **校验模块**：§4.3 三门（与 0.2.40 citation guard 共享基础）。
- **模型**：`claude-sonnet-5` 固定。

**稳态成本**（r4 口径修订）：

| 调用 | 频率 | 输入 | 说明 |
|---|---|---|---|
| diary 生成 | 每活跃日 1 operation；通常 1 request | 120–190K；分段时为 N 个 map + 分层 merge 的每个完整 request 输入之和 | 输出 ~2K；partial 输出另计 |
| 增量 fold | 每活跃日 1 | ~8–15K | 输出 ~4K |
| rebase | 每 ~30 活跃日 1 | **常规单批 80–150K**；多批总输入 = 每个完整 SDK request 输入之和（已包含此前 accumulator） | 中间/最终输出单列，不把 acc 再加一次 |
| rebuild | 触发式 | 每个完整 SDK request 输入之和，每批 ≤150K（已包含此前 accumulator） | 中间/最终输出单列；bootstrap 通常 1 批 |

正常、未分段的 diary + fold ≈ **128–205K input token/活跃日**，不含 retry；rebase 另按约每 30 活跃日一次摊销，不能隐含进该区间。每 session 常驻注入 ≤3K。

## 附录 A：模拟证据（2026-07-10 实盘，3 session / 132 turn，跨 3 项目）

### A.1 混合输入模拟

输入 143K 字符，Sonnet 123K token / 198s / 5 次工具调用，29 bullet。人物信号 7 条全部是 session summary 不会保留的内容；引用抽查 3/3 准确。独立里程碑视图移除。

### A.2 未提取成因分析

29/132（22%）无提取字段：28 条规则性 skip（query-session.ts:288，全部零工具纯对话 turn）+ 1 条 A1 尾部孤儿。skipped raw 是主料源；drain sweep 软依赖。

### A.3 纯 raw 对照（消融）

输入 165K 字符（仅 4/132 超 2K），Sonnet 189K token（+54%）/ 17 次工具调用；人物信号 8 条、质量相当，但 1 次幻觉引用 + 2 处格式违规。提取字段 = 成本与引用纪律优化，非信息必需。

## 附录 B：Codex 审查落点映射

### Round 1（15 条）

| Finding | 严重度 | 落点 |
|---|---|---|
| 冷启动与缺口扫描冲突 | Blocker | §3.1 `cutover_date` |
| fold 顺序被失败跳过打乱 | Blocker | §3.4 |
| 伪 session 0 误入 session 路径 | Important | §3.3 |
| 无 lease/超时/重试 | Important | §3.3 |
| 跨午夜素材残缺快照 | Important | §3.2 watermark |
| 多文件产出无事务边界 | Important | §3.5 |
| 引用 ID 语义歧义 | Important | §4.3 |
| bullet⇒token 算术 | Important | §6；§5.1 |
| INDEX 无格式/上界 | Important | §4.2；§6 |
| rebuild 语义混乱 | Important | §5.2 |
| gap scan 无上界 | Important | §3.2 |
| Read 无载体 | Important | §4.4 |
| tag 剥离 fail-open | Important | §4.1 |
| 时区术语 | Important | §3.0 |
| 状态矩阵不完备 | Minor | §4.1 |

### Round 2（11 条）

| Finding | 严重度 | 落点 |
|---|---|---|
| 超窗修正进不了 persona | Blocker | §3.4 `pending_rebase` |
| 双文件+游标非原子 | Blocker | §3.5 CURRENT |
| cutover 破坏扫描上界 | Important | §3.2 + 写路径标脏 |
| 重试无持久化 | Important | §3.1/§3.3 |
| 无调度状态机 | Important | §5.3 |
| 校验漏无引用/非法格式 | Important | §4.3 |
| envelope 未定义 | Important | §4.5 |
| 估算器非上界 | Important | §6 |
| watermark 低分辨率 | Important | §3.2 |
| 成本漏 fold | Minor | §7 |
| YAML path | Minor | §4.2 |

### Round 3（11 条）

| Finding | 严重度 | 落点 |
|---|---|---|
| rebase/rebuild 输入无界 | Blocker | §5.2 分批归约 |
| 标脏覆盖不全 | Important | §3.3a 写原语 |
| bootstrap/损坏无触发 | Important | §3.6；§5.3 条件 0 |
| 退避无法实现/attempt 无生命周期 | Important | §3.3 |
| manifest 不足以恢复 | Important | §3.5 operation_id |
| day state 掩盖文件缺失；空日未定义 | Important | §3.2 tombstone |
| watermark 未哈希内容 | Important | §3.2 内容摘要 |
| fallback 非上界 | Important | §6 校准预算 |
| raw 无隔离、recall 过宽 | Important | §4.1；§4.4 |
| 正则分隔符可选 | Minor | §4.3 |
| 冷启动成本口径 | Minor | §3.6 |

### Round 4（10 条）

| Finding | 严重度 | 落点 |
|---|---|---|
| 150K gate 与 diary 实测冲突 | Blocker | §4.6 日记独立 500K gate + 分段合成；§2 原则 1 改「每类调用各自 gate」 |
| 多批算子无持久化进度/重试 | Important | §5.2a `persona_operation_state` + 批级 checkpoint 续跑；§5.3 条件 0a |
| tombstone 日无文件却作 rebase 输入 | Important | §3.2 已 fold 空日直接触发全量 rebuild，不走 rebase |
| terminal 恢复日首次结算乱序语义 | Important | §3.4 结果导向判据（date ≤ last_folded_date_after 一律 pending_rebase） |
| read_turn allow-set 排除 persona/acc 旧引用 | Important | §4.4 并集 allow-set |
| `<source_prompt>` 可被闭合逃逸 | Important | §4.1 JSON/转义编码 + breakout 测试；§2 原则 4 改 prompt contract |
| 窗口外文件损坏无主动发现 | Important | §3.2a 轮转完整性游标 + verify CLI + read_diary 标脏 |
| INDEX 与 day-state 恢复顺序未定义 | Important | §3.5 `index_hook` 入状态表、INDEX 变可重建视图 |
| 扫描候选集未限定有素材日期 | Minor | §3.2 候选集定义 |
| rebase 成本混淆单批/总量 | Minor | §7 成本表 |

### Round 5（10 条）

| Finding | 严重度 | 落点 |
|---|---|---|
| 完整 SDK request 与 partial 输出仍可能越过 diary gate | Important | §4.6 固定开销入账 + 16K partial 硬界 + 分层 merge |
| persona checkpoint 没有不可变输入与可验证 manifest | Blocker | §3.1 operation 字段；§5.2a 输入快照、batch plan 与双层 hash |
| tombstone 的「已 fold」判定不可恢复 | Important | §3.2 改由 CURRENT 绝对状态判定；移除 day-state `folded` 真相 |
| partial rebuild 与晚恢复日期的 manifest 语义不闭合 | Important | §3.4；§3.5 `partial_missing_dates_after` 与初始 last folded 规则 |
| rebuild allow-set 错含旧 persona | Important | §4.4 按每个 request 的实际 artifact 精确定义 |
| 素材编码未覆盖提取字段/摘要 | Important | §2 原则 4；§4.1 统一 `encodeSource` 与 round-trip/breakout 测试 |
| 历史检查 stat+parse 发现不了正文篡改 | Important | §3.1 `file_sha256`；§3.2a canonical validator |
| INDEX 的 source commit、修复时机与 canonical bytes 未定义 | Important | §3.5 day-state 先提交 + `ensureIndex()`；§4.2 canonical renderer |
| 候选日期集对全 undone 与窗口外 needs_regen 含糊 | Important | §3.2 精确集合公式 |
| 冷启动及多批成本重复/漏算 accumulator | Minor | §3.6 与 §7 按完整 SDK request 求和 |
