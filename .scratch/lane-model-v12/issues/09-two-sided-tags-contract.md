# 09 — 边带两侧 tag(contract):旧列与双写下线

**What to build:** 旧的 `tags` 列与维持它的双写代码消失,两侧列成为唯一事实来源。

**Blocked by:** 06, 07, 08。

**Status:** done — landed, not released

- [ ] 旧列删除;所有残留读者一个不剩,用 grep 哨兵钉住。
- [ ] 双写代码删除;写入路径只维护两侧列与侧索引。
- [ ] 迁移做一次 failpoint 重启测试;第二次运行是无操作。
- [ ] 全套测试绿;身份键的幂等性测试在没有旧列兜底的情况下仍然成立。

## 票 01 落地后加的一条约束

**不能用 `ALTER TABLE memory_edges DROP COLUMN tags`。** 那一列是 `UNIQUE (citing_kind, citing_id, cited_kind, cited_id, relation, tags)` 的一部分,SQLite 拒绝删除受约束/被索引的列。这一步需要**整表重建**,而且 `memory_edge_tags.edge_row_id REFERENCES memory_edges(id) ON DELETE CASCADE` 意味着 rename-copy-drop 的过程中 SQLite 会改写那个外键目标 —— 重建顺序必须把它算进去,并有测试断言重建后侧索引与级联仍然成立。

## 票 05 落地后加的一条

**侧列进入唯一键这件事,在 expand 阶段没有独立的行为钉桩** —— `tags` 还在键里,而两侧是它的函数,所以把侧列从键里拿掉只会弄红两条 DDL 文本断言。**本票把 `tags` 移出唯一键之后,这条性质才独立成立**,届时要补一条真正的行为测试(同一 pair/relation、不同两侧组合 = 两行)。


## 票 06 落地后加的两条

1. **生产库还没有两列。** 只读核对:`~/.claude-mnemo/claude-mnemo.db` 里 `memory_edges.tail_tag` 与 `memory_edge_side_tags` **都不存在**。票 07 已经让加载器 `select me.tail_tag`,所以 `scripts/lane-check.ts` 对未迁移的库**现在就会抛**;票 06 又加了侧索引这第二个依赖。**迁移 D4 必须先于这一族的任何一个读者碰生产数据**。

2. **M-A 必须先于 D4**:多 tag 行在拆开之前是「两侧不可见」的。存量已经从 spec 写下的 41 涨到 **45 / 507** —— 又一个带保质期的测量,实现时重测。

## 落地后加的三条(实现时发现)

1. **收缩把一条旧迁移的「已迁移」判据变成了谎话。** `memoryEdgesTagSetIdentityIsStale`(rubric-v10 票 01)判「这库迁过没有」的方式是查存储 DDL 里有没有 `tags TEXT NOT NULL` —— 这个标记在 M-E 之后消失,于是**收缩后的表每次重开都被当成 ticket-01 之前的原始表**,而那次重建的 copy 只点名前 tag 时代的列:两个 side 列连同全库 lane 归属被静默抹掉,M-A 再把幸存行「扩张」成未结算。判据已改为探测 `id` 列(这次迁移里没有任何后续票会拿走的那一半),并在重建前加一道点名拒绝。**教训对后面几票同样成立:DDL 文本标记只有在没有任何后续迁移会把它拿掉时才是单调的。**

2. **合并索引的生命周期必须与列绑定。** `ensureMemoryEdgesSchema` 无条件 `CREATE TABLE IF NOT EXISTS memory_edge_tags` 会在 M-E 之后每次重开都把它空手重建一遍,而 M-E 再也不会跑。现在创建被 `tags` 列的存在门住 —— 索引存在的时长正好等于它索引的那一列。

3. **票 08 那个洞还有第二个读者。** `findMembershipLaneStrandings`(`db/segments.ts`)按 `tags <> '[]'` 过滤边,而跨 lane 边的 merged 集合是空的 —— 一次把跨 lane 边某一侧的声明搬走的成员移动会被静默放行。已改为按侧读(tail↔引用方、head↔被引用方,D2 规则 2),并补了一条只有跨 lane 夹具能红的测试。M-C 的注释也声称「无论收缩的哪一侧都能解析」,但它无条件点名 `memory_edge_tags`;两处索引清理现在都按表存在与否 gate。
