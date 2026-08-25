# 06 — 读者切换:校验器、加载器、lane 归约

**What to build:** 校验器一族改从两侧列读取 lane 关系,行为与切换前逐项一致。

**Blocked by:** 05。

**Status:** done — landed, not released

- [ ] lane 的内部边判定改为「两侧 tag 同为该 lane」;跨 lane 边(两侧 tag 不同)**不建立连通**。
- [ ] 加载器的发现/加宽两趟改读侧索引,并在两侧都套用存活过滤。
- [ ] 报表的数字在切换前后逐项一致,用现有的黄金夹具证明 —— 这一票不改变任何判定,只换数据来源。
- [ ] 突变验证:把某一侧的读取指向另一侧,必须有点名该路径的测试变红。

**Blocked by:** 07 —— 见下。第一次派发时我误判了地盘:`lane-checker-load.ts` 与 `lane-interpretation.ts` **被校验器族与渲染族共用**,票 07 的 worker 已经把这两个文件改了,并在注释里把剩下的部分明确留给了本票。**必须等 07 提交之后再跑,或者整块并进 07。**

## 第一次派发带回来的分析(未写一行代码,不要重新推导)

- **07 把 `LaneEdgeInput` 的 `tailTag`/`headTag` 设成了必填,并因此静默弄坏了选举** —— 13 条失败里的 9 条。`milestone-election.ts` 的 tier ① 现在比 `edge.tailTag === UNSETTLED_LANE_TAG`,而测试里的字面量没有这两个字段,运行时是 `undefined === ""` → false,于是**每一条无 tag 的 `indexes` 发布都不再入选**。`tsconfig.json` 排除了 `tests/`,所以 TS 抓不到。
- **`deriveSideTags` 把多 tag 的写入映射成「两侧都未结算」**(`memory-edges.ts:205`)。loader 一旦改读侧列,**每一条多 tag 边都会对 lane 不可见**。三个 loader 夹具依赖它(`lane-checker-load.test.ts:911/946/987`),`note.test.ts:2224` 也写了一条。**修法是把夹具迁到 M-A 之后的形状**——同一 pair+relation 上两条单 tag 行,在身份键下是不同的行,每条 lane 的成员/边计数完全一致。这是本票唯一一处「数字真的会动」,而且它是夹具写成了迁移前的形状,不是语义回归。
- **跨段的双重登记会消失,这是有意的但标注不足。** lane 身份是 `(段, tag)`,所以一条跨**段**、字面同名的边是**跨 lane** 边,两边都不认领 —— v11 会把它登记进两条。生产实测:**507 条带 tag 边里只有 1 条跨段**(另有 17 条端点无段)。黄金夹具没有段、也没有多 tag 边,所以它能证明切换是惰性的,也**正因如此证明不了这一条**;`lane-interpretation.test.ts:319-363` 钉着旧的双重登记,要**改瞄准而不是删掉**。
- **一个谓词收口**:`laneMembershipClaims(edge, citingSegment, citedSegment)` —— 两侧齐全且相等且两端同段 → 一条认领,否则空(跨 lane,不建立连通);legacy(两侧都缺)→ 照 v11 的逐 tag × 双段扇出。归组与 `indexes`/`override` 的事件归约都消费它。配套 `laneEdgeTags(edge)`(两侧已结算值的并集)是 `lane-checker.ts` 里六处 `edge.tags` 读的替换点:**977 / 1007-1008 / 1050 / 1102 / 1299+1318 / 1408**。`tail === head` 的数据上每一处都返回同一个单元素集合,所以计数不动。
- **E4 是最锋利的突变靶,要重构不是替换。** `computeSubsetInvariantErrors`(`lane-checker.ts:1222-1254`)今天把每个 tag 对两端都查;两侧化之后变成**逐侧**:`tailTag` 对引用方自己的 tags、`headTag` 对被引方的 —— 正是 D2 规则 3。写成 obligations 列表 `{tag, endpoint}[]`,把 tail↔head 对调就是那次「把一侧的读指向另一侧」的字面突变。**它无法经 `writeMemoryEdges` 测试**(`deriveSideTags` 只能产出 `tail === head` 或两侧空),不对称的边要用裸 `INSERT`(先例:`lane-checker-load.test.ts:130`)。
- **loader 细节**:发现趟的过滤 `me.tags != '[]'` → `(tail_tag <> '' OR head_tag <> '')`,lane 键变成 `(seg(citing), tail_tag)` + `(seg(cited), head_tag)`,与今天「两端各出一个键」的行为完全一致。加宽趟把 `memory_edge_tags` 换成 `memory_edge_side_tags` 并按侧过滤。`loadSegmentFacts` 的 `emptyLaneTags` 子查询(约 569 行)是**第三个** `memory_edge_tags` 读者,必须一起搬。`edgeKey` 用 `JSON.stringify([...])` 比连接分隔符好——自带定界,而且绕开裸控制字节那条规则。

