# Peer 交叉审查(2026-08-26,批次落地后)

对 `6c3a6a6..bad2da5`(18 票、34 commit)的独立审查。Peer 未跑测试、未改任何状态,全部是读码结论。**我已独立复核第 1、2 两条,其余按其给出的 file:line 记录。**

分类原则:**规范文本或已定不变量能唯一决定的 = bug,我修;需要改动模型语义或补写 normative 文本的 = 裁决,等用户。**

---

## A. 必须修(规范已定,不是裁决)—— **全部已修,2026-08-26**

| 项 | commit | 备注 |
|---|---|---|
| A1 override reopen 残留 | `262e037` | 连同 `reopened`/`everDeclared`/`latestEventTurn`/两阶段批处理一起删,−161 行;10 处 v11 金标断言反转 |
| A2 lane/段 tag 撞名 | `30cac74` | 按 peer 第二轮的窄 seam:权威在 `insertLane` + `setSegmentTag` 两个 primitive;merge 未改 |
| A3 三个迁移 guard | `5743fc5` | 顺带发现**去掉 CHECK 里的 `relation IS NOT NULL` 会把票 09 的事故原样重演一遍**(见下) |
| A4 挂靠拿不到词表 | `5058326` | 两条 attach 回执都带词表,与 roster 共用一个 formatter |
| A5 结算拿不到 registry | `5058326` | prompt 直接带 declared lane registry |
| A6 教学面漂移 | `5058326` | 扫出比 peer 列的多 4 条;新增覆盖 10 个公共面的哨兵 |

套件 **3608 通过 / 1 失败**(只剩 stale-bundle 守卫),tsc 干净。每一项我都独立突变验证过。

**A3 修复过程中挖出的最重要的一条**:把 `relation IS NOT NULL` 从收缩后的 CHECK 里拿掉,会让那张表的 DDL 与**票 05 之前**的存量逐字节相同 —— 于是票 09 那场事故原样重演一遍,只是换了个标记:每次重开都会重跑一个只 copy 前代列的重建,丢掉 `id`、两个 side tag 和全部 lane 归属。用票 09 同一个 `id` 列判别器修掉并钉住。

**A2 修复中的一个判断**(brief 没预见):`insertLane` 抛异常,而 M2 seed 跑在 schema init 里 —— 一个拼成某段自己 tag 的遗留边 tag 就会让**每个进程都打不开数据库**。M2 改为自己问 helper 并具名跳过。迁移既不能造出模型禁止的状态,也不能把库锁死。

---

### (以下为原始审查记录)


### A1. override 仍然会 reopen lane —— 我已独立复核,确认

`lane-interpretation.ts:652-670`:in-lane `override` 指向 terminus 时 `terminus=null`;`deriveLaneStates` 据此报 **open**。直接违背 concepts 两句:「只有 index 参与 open/closed 的判定」「其余六词不改变 lane 状态」。

v11 残留清单:

- `LaneDeclarationState` 仍带 `reopened`(`:319`,产生于 `:724-735`)
- `latestEventTurn` 仍是 v11 reducer/display 事实
- checker renderer 仍输出 `[last event T<n>]`(`lane-checker-render.ts:178-210`)
- console payload 仍公开 raw `declarationState`(`console-api.ts:278-326,1252`)
- `lane-interpretation`/checker/console 多组测试把 reopen 当**金标**(`lane-interpretation.test.ts:213,232,242,583`)

**Peer 裁决建议**:override **完全停止产生 state reduction event**。它若属于 L,其 node tag 已使它成为 L 的更新 member,于是旧 terminus ≠ latestMember,lane 自然 open —— 不需要显式清 terminus。**删除 `reopened` union 而非留成不可达**,否则类型继续允许模型里不存在的状态。`latestEventTurn` 与 `[last event]` 一并删。Election/timeline/card 会随 shared state 自动纠正。未发现 settlement prompt 仍教 reopen。

### A2. lane tag 与另一个段的段 tag 可以撞名(我的 open ruling #5,peer 判为 bug)

D3e 的不变量已经唯一决定答案:段 tag `alpha` 全局表示 E1 归属,就不可能同时表示 E2 下的 lane `alpha`。

- 两条 declare facade 只查本段(`remember.ts:1146-1169`、`note-settlement-membership-facade.ts:283-303`)
- `insertLane` 不查全局(`lanes.ts:202-217`)
- merge 可写出 `[alpha,beta]`,而 `deriveTurnSegmentMembership` 取**遇到的第一个**段 tag → 双归属非法态或静默迁段(`segments.ts:791-831`)
- **`lanes.merge.test.ts:382-415` 把错误迁段当正例**,需要反转

修法:全局**双向** namespace invariant —— declare lane 拒绝任一段 tag;set/create 段 tag 也拒绝任一已存在 lane tag;main/settlement/merge 共用一个事务内 guard。

### A3. 三个迁移 / guard 阻塞

**M-C 只清一次,schema 仍允许未来 self-edge。** `lanes.ts:1824-1831` receipt 存在即返回;contracted schema 与 primitive 仍允许带 relation 的 self-edge(`schema.ts:1483-1490`、`memory-edges.ts:578-589`)。Receipt 之后 restore 或内部 writer 再写 self-edge,重开永远不清。**正确修法不是让迁移每次全扫**,而是 M-E 的最终 CHECK **永久禁止 self-edge**、primitive 同步拒绝,M-C 只负责先清遗留让 contraction 成功。补 fixture:保留 receipt → 插 self row → reopen 必须拒绝或 schema 容不下,不能静默存活(现测试只测删 receipt 后重跑)。

**M-B expanded-restore 用旧 tags 分组,会误删不同 side identity 的行。** M-B 自称支持 expanded restore(`lanes.ts:2147-2155`),却用 pair + post-merged `tags` 分组(`2178-2193`),side 清理发生在 `2216` 之后。已有 `override tail=a/head=b` 与 `refutes tail=c/head=d` 时两者 identity 不同,却因 `tags=[]` 被合并删除;supersedes 投影出的 `('','')` 也没在 group key 之前算。修法:side 列存在时,collision key 必须用 **relation 重写后、clearTags 投影后的 `(tailTag,headTag)`**;receipt 可留旧 tags 仅作审计。现测试强制降成 pre-v12 shape,必须新增 expanded fixture。

**段 tag 唯一索引的 guard 非单调。** `segment-one-tag-migration.ts:112-119,185-190` 见 receipt 直接返回,unique index 只在首次分支创建。后续 segments 重建若丢了 `idx_segments_tag_unique`,重开不补,两个 writer 的 precheck 可并发穿透。修法:receipt 之后仍无条件 `CREATE UNIQUE INDEX IF NOT EXISTS`(或显式探测索引);测试:receipt 存在 → drop index → reopen 后 guard 恢复。

### A4. 挂靠后拿不到立即可写的 lane 词表

票 18 把 lanes 从段卡片删掉了,但 note auto-attach 与 `remember(attach)` **只返回卡片**(`note.ts:1184-1199`、`remember.ts:576-585`);lane 词表只在 SessionStart 的 attached roster 上(`recall.ts:3227-3235,3318-3332`)。**于是中途挂靠到下一次 SessionStart 之间,主 agent 看不到闸允许的 lane。** 而且 `plugin/commands/attach.md` 还明确承诺卡片含 lanes —— 是假的。

修法:不必把 lanes 塞回卡片,attach 回执追加一行 vocabulary-only 的 attached roster / `- lanes:` 即可,并在 session-attach-flow 测试里断言具体 lane 名。

### A5. 结算被教「卡片列出 lanes」,而 prompt 也不给 registry

`SETTLEMENT_REMEMBER_TOOL_DESCRIPTION` 承诺段卡片列 lanes(`note-settlement-sdk-query.ts:195-220`),但结算 roster 只有 id/title/段 tag(`note-settlement-prompt.ts:353-377`),卡片又没有 lanes。结果:**结算无法遵守「先续用已有 lane 再 declare」**,尤其看不见 0/1 成员的 provisional lane。最窄修法:结算 prompt 直接带 declared lane registry(词表很小)。

### A6. 公共教学面漂移

- `mcp/definitions.ts:554-558` 仍教自由 topic tag —— 闸会拒
- timeline describe 仍说 closed-valid / open-last-declarer
- `plugin/CLAUDE.md` 仍宣传已退役的 phases 与「唯一 write path」
- 建议加一条跨 public surface 的 v12 stale-term sentinel

---

## B. 等用户裁决(改模型语义 / 要补 normative 文本)

### B1. open ruling #1:peer 裁 **tail-only convergence**,但 normative 文本必须补写

Peer 的划分(我认为是对的,三个谓词被合并成了一个):

| 谓词 | 定义 | 只决定 |
|---|---|---|
| `internal(e,L)` | 两侧 LaneKey 都 = L | 内部连通、chain、target 是否 L 的 internal core |
| `closes(e,L)` | `relation=index && tail LaneKey = L` | **引用方宣告自己哪条 lane 收敛,head 不参与** |
| `coreTarget(e,L)` | = `internal(e,L)` | |

现在 `laneMembershipClaims` 正确实现了 1,却被 event reducer 复用来实现 2(`:486-499,612-629`),所以同段 `A→B` 的 index 和跨段同名 tag 的 index **都不关闭 tail lane**。例:E1 内 T3 属 A、T2 属 B,`T3 index{tail=A,head=B} T2` —— 写闸放行,代码却让 A 永久 open,tier②/checker/card 一起漏掉 T3。

**为什么这仍是裁决而不是 bug:** 我原先援引的 tail-only 那句在 `rubric-v12-shared.md` 里,而**现行 normative 的 `rubric-v12-concepts.md:14` 已经把它删掉了**,只写「通过 index 宣告收敛」。所以现行权威文本对 tail-vs-both **没有答案**。无论裁哪边,都必须把结论写回 concepts,否则「一个多 lane 节点的一条 index 到底关闭哪条 lane」永远没有权威答案。

最小修复(若裁 tail-only):internal grouping 不动;index event 直接从 settled tail 的 `(citing segment, tailTag)` 入队。跨段同理 —— 不建立连通、不把 target 算 core,但关闭 citing 侧自己的 lane。要替换 `lane-interpretation.test.ts:519-530` 的「两边都不关」断言,并补 same-segment A→B 用例,以及 election/checker/card 各一条消费同一 projection 的 pin。

### B2. 自动挂靠(原 ruling #2):保留,但边界要裁准

Peer 指出**当前实现不是「第一次写段 tag」**,而是任何写完后属于某段、且尚未挂靠的 tags write 都会挂靠;detach 后重写会重挂(`note.ts:972-1001`)。用户只需裁两点:

1. detach 是不是 sticky veto,还是后续归属写可以重新挂靠?
2. 跨会话 `note` 能不能把 **caller session** 挂到 target turn 的段上?

Peer 建议:只对 caller 当前 session 的 turn 自动挂靠;显式 detach 在该 session 内保持 sticky。

### B3. `propose_rule`(原 ruling #3):不是整体只写不读,裁决对象要缩小

prompt trigger 规则**仍经 trigger index / UserPromptSubmit 投递**(`rules/trigger-index.ts:78-109`、`hooks/handlers/prompt-dispatch.ts:42-60`)。真正失去 reader 的只是:未入选的 `digest_only`、`none`、以及 tool/result trigger(tool-adjacent 投递已删)。**不要恢复 SessionStart digest**;先盘点可投递的 kind/status,禁止 dream 再 author 没有任何投递路径的规则,并迁移/冻结现存孤儿子集。有 prompt 投递的 `propose_rule` 保留。

`note(session=…)` 则是**真悬空**:main 已拒绝,settlement branch 与 description 仍活,而 prompt 明删了 SESSION NARRATIVE duty。既然「exactly two duties」已裁,最小方案是退役 settlement 的 session branch 与其测试。**两条通道不能打包成同一个裁决。**

### B4. rubric 瘦身(原 ruling #4):建段指引要回 main,读取策略不要照抄给结算

main 仍能 create segment,而 `remember` 描述还引用已不存在的 rubric 判据 → 恢复 **main-only** 的建段指引(先看 roster、能复用则复用、无匹配才按真实 task shape create)。结算已经不能 create。

**不要**把「只在可能改变判断时读」复制给结算 —— 它必须审完整 writable set,与该泛化启发式冲突;「材料化回原文」已在共享的 recall 工具描述里。此项只需恢复 main 的建段指引。

### B5. C3 命名(原 ruling #6)

C3 的目标是 attachment completeness,所以正式数应继续是「有 incident edge 且自身无 declared lane 的节点」。但 context 里的 `bothEndsLaneless` **实际算的是「所有邻居也 laneless」**,名字与两种自然读法都不符 → 改名 `allNeighboursLanelessNodes`,或改报 literal both-end-laneless edges。54-turn 大簇是诚实 backlog,不应偷偷恢复旧 node filter。

---

## C. spec 内部矛盾(顺手清)

`spec.md` D3c:100 仍说 main 写 side tags,而 D3d:111 与 D7:215 说 main 不写,正文状态还写着「未实现」。Rubric 优先,但留着会误导后续维护,应同步删旧段。

---

Peer 明确未重报:生产库尚未迁移、发版配对约束、票 09 已修复的 contraction guard。

---

## 附:peer 第二轮 —— A2 有比「改 merge 全链」窄得多的 seam

`merge` **不创造新名字**,它只把 from 改写成一个**已存在的** target lane(`note-settlement-membership-facade.ts:397-412`)。所以只要命名空间不变量在两个「名字创建者」处结构成立,merge 本身不需要再做一套碰撞判断:

1. **`insertLane`** —— 声明 lane 前全局查所有段 tag,撞任一个就拒绝(现在**完全不查**段命名空间,`lanes.ts:202-216`)
2. **`setSegmentTag`** —— 命名段前全局查所有 lane tag,撞任一个就拒绝(现在**只查其他 segment**,`segments.ts:735-760`)

两者复用**一个 cross-table namespace helper**,在各自现有的 IMMEDIATE 写事务内调用。Facade 可以预查只为友好报错,但**权威必须在这两个 DB primitive**,否则迁移或 direct caller 仍能绕过。`remember(retag)` 的 `findRetagLaneCollisions` 也要从「本段 lane」扩到全局 lane holder。

**测试的修法也不同于我原先的想法**:`lanes.merge.test.ts:382-415` 不该改成「merge 再拒绝坏 target」,而应把 fixture 里 **E2 declare lane alpha** 那一步改成**预期拒绝**;若要覆盖历史坏数据,另开 repair fixture,不要把它当正常 merge contract。

(最强防绕过是双向 SQLite trigger;但按本项目风格,两个 primitive + 事务内共享 helper 已是最窄且足够的 seam。)

## 附:B5 精确行号 —— `src/cli/lane-controls-cli.ts:558-560`

```ts
bothEndsLaneless: incidentEdges.every((edge) =>
  laneless(edge.citingId === id ? edge.citedId : edge.citingId),
),
```

`every` 算的是「这个 laneless 节点的**每一条** incident edge 的远端都 laneless」= `allNeighboursLaneless`。注释自己也这么写(`:506-507`「Every incident edge's OTHER endpoint」),输出上下文 `:601-605` 却写成「both ends of every incident edge are laneless」。

- 不改计算 → 直接重命名 `allNeighboursLaneless`
- 想要自然语言里那个「存在一条两端都 laneless 的边」→ `every` 改 `some`,并直接报 **edge count** 而不是 node boolean

主 C3 broad count(`:525-579`)两种情况都不动。
