# 笔记台账重设计:prompt hook 唯一时钟

Status: Rev 3(Codex 第 1/2 轮评审已折入,待第 3 轮确认后转 ready-for-agent)
Date: 2026-08-12,定案于 S15069 T557–T572
Supersedes: 裁决 13(全部两半)、0.9.11 批次结果启发式、干燥计数泄压门

## Problem Statement

三处结构性故障,全部实测于生产库:

1. **欠账的主流结局是老死**:全库 891 aged vs 242 noted(79% 静默注销)。泄压闸门要求「连续 5 个无笔记 turn」,而任何合规写入都把干燥计数清零 —— 越守纪律,旧账越出不来(S15069 T523–T544 的 15 条欠账在 15 个带工具 turn 里原地不动)。
2. **纯讨论 turn 被判不可写**:`mayWriteNote` 复用债务台账做地址归属证据,工具调用计数闸门于是从「不催」(裁决 13)静默升级为「拒收」。T553(用户更正规则的裁决 turn)、T562(用户裁定「笔记与工具调用无关」的 turn 本身)都被拒。此耦合未经任何讨论(教训入全局记忆 feedback_embedded_design_decisions)。
3. **0.9.11 承诺了没有供给的路径**:「从后续任意批次补写」需要地址,而地址的唯一推送通道(泄压)被第 1 条锁死。实测 lag≥3 的补写只出现在 11 次泄压爆发里,从未自发发生。

根因共通:台账把「什么时候算结束」「值不值得记」「有没有资格写」三个问题都答错了对象 —— 完成判定依赖 Stop 时序与完成证据,价值判断依赖工具计数,资格判断依赖台账收录。

## Solution

**prompt hook 是唯一时钟**:turn 在它的 prompt hook 出生,在下一个 prompt hook 被宣告结束 —— 「结束」的定义就是新 prompt 到达,不需要任何其他证据。收集与注入在同一钩子、同一事务完成。资格塌缩为「本会话存在即可写」。价值分流只发生一次、只在主 agent 手上(skip 是答案,不是系统预判;兜底子代理无评审权)。泄压只看数量。settlement 补 sessionend 兜底。「工具调用」概念只存在于给主 agent 的纪律提示文本里(批次=载具),不出现在任何系统判定中。

## User Stories

1. 作为主 agent,我在每个 prompt hook 收到当前 turn 地址与欠账地址,无需记忆或翻找旧地址
2. 作为主 agent,我可以为本会话任何存在的 turn 写笔记,包括纯讨论、被打断、预 compact 的 turn
3. 作为用户,我的纯决策 turn(零工具调用)不再从索引里消失
4. 作为主 agent,欠账 ≥5 时我收到批量清单与单开授权,不依赖「连续几轮没写」
5. 作为主 agent,我对不值得记的 turn 用 skip 作答,它从欠账里消失,且与遗忘可区分
6. 作为主 agent,我不为机械斜杠命令写笔记,也不被它们提醒
7. 作为主 agent,子代理的结果记在派发 turn 的笔记里,不需要为暂态 sidechain 行记账
8. 作为主 agent,写错的笔记我可以立即单开一批更正,不因本轮无批次而永久丢失
9. 作为主 agent,当前 turn 的笔记留到下一轮写,「最后批次不可判定」问题不复存在
10. 作为用户,会话尾部没等到下一轮的 turn 由 settlement 兜底补记,无论尾窗多小
11. 作为 settlement 载荷,我运行时现查哪些 turn 仍缺笔记,机械回填,不覆盖主 agent 排队期间的补写
12. 作为主 agent,compact 之后我仍能从注入行拿到欠账地址 —— 上下文丢失不等于账目丢失
13. 作为维护者,资格判定有自己的事实依据(turn 存在性),不再借用提醒台账当代理

## Implementation Decisions

### D1 收集与时钟

- 欠账集合 = **派生查询**,不再是分类写入:`prompt_number < 当前 AND 无笔记 AND 无 skip 记录 AND status != 'undone' AND was_rolled_back = 0 AND 非 compact 标记行 AND 在 50-turn 提醒界内`
- 在 UserPromptSubmit 的建 turn 事务内计算并注入;**笔记路径上的** Stop 时序依赖、完成证据、`countSubstantiveToolCalls`、分类游标推进全部删除。完成证据谓词随 turn 结算迁去它的本职(D10)—— 它当 turn 终态门是对的,当笔记资格门才是错的
- 50-turn 界只约束提醒(owed 计数与清单),**不约束资格** —— 超界 turn 依然可写

### D2 排除项(穷举,不再增补)

- **机械斜杠命令:检测问题不存在**(Codex 第 1 轮 P1-6 + T560 实证)。/model、/plugin 这类本地命令不触发 UserPromptSubmit、不建行(T560 实为被模型切换吃掉的用户首次发送,是被打断的真 turn);唯一入库的机械行是 PreCompact 修复路径所造的 compact 标记行 —— 按其标记过滤,不入册、不可写。触发 skill 的斜杠命令走真 prompt,照常入册可写。Rev 1 的「建行时解析 prompt 打 local-command 标」设计删除
- **sidechain 行**:出生即 `undone`+`subagent:pending`、由 liveness 清理的暂态行,经 status 过滤天然排除;子代理的持久信息在派发 turn 名下(brief=输入,报告=观测)
- **rolled-back turn**:不入欠账,无需「已告知」状态机

### D3 注入形态(UserPromptSubmit,追加于现有 current-turn 行)

```
0 条   mnemo current turn: S15069/T561
1 条   mnemo current turn: S15069/T561 · owed: S15069/T560
≥2 条  mnemo current turn: S15069/T561 · owed: S15069/T560 +13 older
```

- owed 显示**最新**欠账地址 + 更旧计数;0 条不占字节
- ≥5 条时追加泄压块(最旧 5 条,含 prompt 前缀,复用既有 `formatPromptPrefix` 转义),**逐 prompt 重渲染直至 <5**;「This once」一次性措辞与 CAS 认领机制废除 —— 自限性来自条件本身,欠账降到 5 以下它就停
- 成本与缓存:注入持久化进 user message,非浮动 attachment,无缓存断点(Codex 第 1 轮确认);泄压重复的成本自限 —— 一批即可泄空

### D4 泄压

- 唯一条件:可写欠账数 ≥ `NOTE_RELIEF_PENDING_THRESHOLD`(5)
- 删除:`NOTE_RELIEF_DRY_TURNS`、`getNoteReliefState` 的锚点/干燥计算、claim CAS;保留:`NOTE_REMINDER_DISPLAY_LIMIT`(5)
- 泄压正文重写:授权一批仅含 note/skip 调用,措辞不再含一次性承诺

### D5 资格

- `mayWriteNote` → 「地址是本会话已存在的 turn,且非 compact 标记行」;replace 守卫(spec D3)与 crossSession 守卫(spec D4)不动
- 会话归属锚 = `process_session_map` 多键映射(86b6df4,0.9.9 起在线,逐 prompt 全键刷新);身份未知时放行是既有 D2 兜底,多键化后属罕见场景 —— 资格塌缩不需要额外守卫(Codex 第 1 轮 P1-4 经活体验证撤回:本会话此刻由 session+socket 双键正确解析)。未知放行为**明示接受的残余风险**(Codex 第 2 轮复议,裁决=接受):拒绝未知会让不产身份键的环境整体失写,伤害远大于被猜中地址
- `debtOwesNoNoteMessage` 删除;拒绝消息只剩可陈述的事实:turn 不存在 / 属于别的会话 / 是 compact 标记行
- skip 同资格;对已有笔记的 turn,skip 仍为 no-op(既有语义)

### D6 纪律文本(context-note-taking.ts 与 definitions.ts 同步重写)

三条原则 + 3′(用户逐条定案于 T559–T567):

1. 每个 turn 的第一个工具批次,同时处理之前 turn 的待写笔记(写或 skip)
2. 当前 turn 的笔记留给下个 turn 写,不提前写
3. 出现泄压告警、或需要更正已写笔记,且本轮无需工具调用时,允许单开一批

- 0.9.11 的 result-independence 启发式全文删除;修订由 `replace:true` 承担(第一批写完、后续结果推翻 → 重发)
- 原样保留:不从清单行编造(内容出了上下文即 skip)、笔记调用批内靠后、英文书写、`<private>` 禁入、预算回执、字段契约(title/content/insight 的用途描述与 insight 独立可读要求)
- token cap 按新文本重新实测定基线
- **单一归属**(用户定案 T586,04 落地后追加):契约全量(字段/预算/skip 判据/replace)单一归属 note 工具描述,压 ≤500 token(实测 500);SessionStart 块只留地址规范与三条时机规则(~152 token),指向工具描述。注入格式(owed 后缀形态、泄压阈值)不写提示词 —— 出现时自解释,泄压块自带授权文本;要写的只有规范(注入是地址唯一来源,不回忆不编造)。两表面合计 1640 → 652。两侧 pin 测试集不相交,防再度分叉

### D7 settlement 兜底

- 分界线事件两种:**compact**(既有,立即触发)与 **sessionend**(新增:**只记边界 + 入队,不即时处理**。用户定案 T570)
- **泄流点显式化**(Codex 第 2 轮 P1-1:现调度在未满 50 turn 时纯读早退,不扫他会话作业,「下一次活动泄流」不能当作现成接缝):契约改为 worker 的**每次 settlement 入口**(任何会话的 turn-stop / compact / flush)在自身逻辑之后都扫描并派发全库到期 sessionend 作业;`finishSession` 也补一次泄流尝试。泄流由此是被定义的行为,不是被假设的副作用
- **边界由 hook 同步落库**(Codex 第 2 轮 P2):SessionEnd hook 在自己的写事务里记边界 + 入队(与 compact anchor 同型),只有泄流是异步的;end 后再 resume 属正常形态 —— 边界只是边界,其后新 turn 归下一窗口,已入队作业不失效
- 窗口 = 上一分界线至最新分界线;常规 20–50 turn 一批;**sessionend 尾窗豁免下限**(1–19 turn 也开窗,否则会话尾部永无兜底。用户定案 T570)
- **载荷职权是机械回填,不是价值评审**(用户定案 T571):窗口内运行时仍缺笔记的 turn,逐个补写。现载荷的两条自由裁量 —— 「无债务记录=琐碎不补」与「尾部连续缺口拒收」 —— **删除而非改造**;价值分流只属于主 agent 的实时 skip
- 时效以运行时为准:载荷运行那一刻现查缺口(非触发时快照);**回写只填空缺**,`writer_origin='agent'` 的行永不触碰 —— 主 agent 排队期间的补写自动获胜(Codex 第 1 轮 P1-5)
- 分界线之后的 turn 不触碰
- sessionend 事件幂等:同一会话重复收到 end 事件只产生一条边界/一单作业
- 兜底产出可观测:真实空缺场景 `notesReconstructed > 0` 可由日志验证(现状三次全 0)

### D8 note_debt 表的去向

- owed 派生化后,表退化为「已记录的答案」:declined skip 与 settlement 的 closed 写入保留;`pending` 行不再产生;`aged` 状态废除(界外=不再提醒,由查询界承担,无需落库)
- **迁移一次性注销全部存量 pending 行**(审计时点 96 条/16 会话,以迁移当刻实数为准,不写死计数):注销 = `status='skipped', reason='closed'`,沿用残值结算的注销语义,不删行;aged/skipped 存量只读保留(历史)。D10 的边界推导本身不读 pending,注销是卫生而非解锁
- **全仓 note_debt 读者清点入票**:settlement decided-prefix(→D10)、residual claim、P1 合规指标等,逐一改派生口径或宣告随台账退役,防止畸形分母(Codex 第 1 轮 P2-7)
- `reminded_at_epoch` 等试验遗留列不动

### D9 迁移与兼容

- 切换瞬间的欠账集合以派生查询为准;50-turn 界天然防止历史 turn 复活
- 既有 skip(declined) 记录继续压制对应 turn 的 owed
- UserPromptSubmit 双进程(session-init / prompt-dispatch)的职责迁移与 N/N-1 竞态在 03 票验收中核对(Codex 第 1 轮 P2-9)
- 版本 bump、重建与 release-artifacts 校验独立成 06 票;`/plugin` 更新 + 冷重启才生效

### D10 settlement 机械存续(Codex 第 1/2 轮)

- `getDecidedPrefixEnd` 弃用分类游标上界与「首个 pending 截断」。**各触发类型的窗口上界显式定义**(Codex 第 2 轮 P1-3,三种语义不等价不能一句「边界推导」带过):compact → 既有持久化 compact anchor,行为不变;sessionend → hook 冻结的 end 边界;consecutive(50-turn)→ 作业创建时刻的最高已结束 turn(prompt 时钟口径:小于会话当前最大 prompt_number 即已结束)
- `settleCompletedTurn` 是 turn 终态、`files_read/files_modified/tool_call_count`、observation 退休的**唯一写者**,现嵌在笔记分类走查内 —— 先迁出为独立 turn 结算通道(02 票),再删笔记分类。expand-contract,防止顺手删掉终态写入路径
- **新通道无游标**(Codex 第 2 轮 P1-2:沿用 note_debt_cursor 会被 03 切断,从头扫描则非零成本):未结算集合**自识别** —— `status ∈ (active, provisional)` 且完成证据在(下一 prompt 已存在,或 turn-stop 在队),结算使集合单调收敛;完成证据谓词随迁移至此,不再出现在笔记路径。stranded turn 照旧留给 liveness 修复,三个调用点(Stop / PostToolUse / worker 队列)共用这一个候选谓词

## Testing Decisions

- 好测试 = 外部行为:给定 turns/notes/skips 状态,断言注入文本与资格判定;不测内部游标或中间态
- seams 沿用现有三处:hook handler(tests/hooks/)、MCP note tool、settlement scheduler;指令文本 pin 沿用 context-note-taking.test.ts 的 flat-substring 风格
- 关键用例:零工具 turn 可写(T553/T562 类);被打断 turn(无 Stop)可写;compact 标记行拒绝且不入册;owed 0/1/2/≥5 四形态注入;泄压逐 prompt 重现直至 <5;skip 清账;replace 修订;settlement 机械回填(窗口内缺口全补、`writer_origin='agent'` 不覆盖);sessionend 入队延迟泄流与幂等;decided-prefix 纯边界推导且越过存量历史

## Out of Scope

- note 预算数值调整(连续超标问题另查)
- shadow_notes 存储、预算回执机制、writer_origin 语义
- settlement 载荷的 prompt 细节与输出 schema —— 除 D7 明令删除的两条裁量判定外
- caller-identity 机制(已在线,见 D5)
- recall/timeline 渲染

## Further Notes

- 本 spec 显式推翻:裁决 13(琐碎分流,两半全废)、0.9.11 批次结果启发式、干燥计数泄压门
- Codex 第 1 轮评审(needs-revision,6 P1 + 5 P2)全部裁决并折入:P1-4 经活体验证撤回;P1-1/2 → D10,P1-3/5 → D7,P1-6 → D2,P2-7 → D8,P2-9 → D9,P2-11 → 发布票;缓存安全获全清
- Codex 第 2 轮(needs-revision,8/11 resolved):新 P1 三条 → D7 泄流点显式化与边界同步落库、D10 各触发上界与无游标结算;P1-4 复议裁决为明示接受的残余风险;SessionEnd hook 存在性获确认;票 03 拆出 06 迁移退役票,发布顺延为 07
- 过程教训:资格谓词是设计决策,不得随实现偷运(全局记忆 feedback_embedded_design_decisions;起因即 problem 2)
- 设计对话全程可回放:recall(id="S15069/T557..T571")
