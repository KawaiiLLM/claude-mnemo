# 16 — 注入面收成五槽

**What to build:** 每个会话注入的块从八类降到五类,主 agent 只看到它真正要用的东西。

**Blocked by:** 12(rubric 的三份工件先定稿),15(`proposals` 随 `propose` 退役)。

**Status:** done — landed, not released

退役三类,留下 `sessions` / `segment<n>-milestones` / `segment<n>-fields` / `rubric` / `persona`。

- [ ] **`notes` 槽退役**:内容按本项目自己的三分规则散开 —— 「只给已完成的 turn 写笔记」「一批只放 note/skip」「地址不得回忆或编造」进**工具描述**;`mode` 语义、三字段预算、拒绝契约进**字段 describe**。一句不丢,一条测试按清单核对三处不重叠。
- [ ] **`proposals` 槽退役**(见票 15)。
- [ ] **`digest` 槽退役**:规则不该注入在这里,自我演化之后会重构、不会沿用这套台账。
- [ ] 每一处退役都有 grep 哨兵,防止它以另一个名字回来。
- [ ] 报告退役后每个会话的注入总字符数,与今天对比。

**留待裁决,不在本票**:`propose_rule` 的写入侧仍然活着(dream agent 每晚可写),而读侧刚被撤掉。台账最后一条写于 2026-08-08,59 条里 37 条停在 `digest_only`、8 条 confirmed。撤读不撤写 = 养一条只写不读的通道。

## 改名(裁决 [S15069/T1664])

- [ ] `sessions` section 改名 **`roster`**。它今天返回的只有 `renderSegmentRosterBlock`,一条 session 信息都没有 —— 名字是「最近的会话」时代的遗留,票 14 的 roster 重建换了内容没换名。名实不符会让下一个读代码的人去找不存在的会话列表。
- [ ] **不与 rubric 合槽**,即使 rubric 砍到 ~2000 token、花名册只有 ~289:代码注释记着实测的 25KB → 2KB 坍塌,花名册会随段增长,而 rubric 是这个项目里最容易长回去的东西。省一个槽换不到任何可测量的东西,输的是一次静默失效。

