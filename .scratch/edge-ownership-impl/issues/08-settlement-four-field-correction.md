# 08 — 结算的四字段检查纠错

**What to build:** 结算窗按 rubric 复核 type/tags/归属/边,经 staged-commit 纠正。

规范:`.scratch/ownership-and-note-cadence/spec.md` 所有权节([S15069/T912]/[T926]);`.scratch/turn-edge-mechanism/spec.md` 校验表=边 rubric。

- staged-commit 通道扩展四种修正:**type**(词表+减法槽位契约)、**tags**(命名空间规则)、**边**(关系×阶段合法性;可补漏边、纠错关系)、**归属**(复用 02 的搬家原语;值域=该会话已挂靠段 ∪ 无归属,越界拒绝并报出该段不在挂靠集合,[S15069/T913])。
- rubric 文本进结算提示,各自引用其源;纠错是**复核不是首写**——无可纠时窗口空手完成(05 已立)。

**Blocked by:** 01(边词表)、02(搬家原语)、05(腾空的通道)、11(rubric 文件是其判断规则之源,[S15069/T941])。

**Status:** done

- [x] 四字段各一条「错 → 纠 → 落库」端到端测试 — `tests/worker/note-settlement-staging.test.ts` ticket 08 四个 describe 块
- [x] 归属越界(未挂靠段)拒绝并报出 — staging + membership-facade 两处断言,报文点名该段未挂靠
- [x] 错挂 turn 纠成 homeless 后原段 facets 不计入(与 02 的 fixture 同源断言) — 直接断言 `getSegment().type/.tags`
- [x] 空手窗口正常完成 — 票 05 既有测试未回退
- [x] 边纠错走票 01 的同一共享校验器(同模块同常量);合法/非法阶段对在结算路径各测一例,与 note 路径镜像([S15069/T939]) — facade 消费 `validateRelationTarget`/`phasesForTypes`/`RELATION_FIELD_NAME`,合法 refines 落库、delivery-only 引用方 refines 被拒并点名缺哪半

## Implementation record

- `settlementNoteInputShape` 升七词(弃 `supersedes` 写面,复用 `noteInputShape` 的字段对象);duty 2 重写为 CORRECTION(type/tags/归属/边),判断只指 rubric,不复述。
- 归属纠错动词 `reassign`(≠已退役的 `assign`:值域受限 = 已挂靠段 ∪ 无归属,越界拒绝点名;底层复用 `reassignSegmentMembers`);staged-commit 通道新增 `membersReassigned` 计数。
- 同 call 的 type 纠正对本 call 的边合法性可见(`normalizedType`),镜像 note 路径;**跨 call 的 staged 兄弟纠正不可见**——阶段合法性读库上现值,dry-run 与 commit replay 同判(设计取舍,见下)。
- 验收变异(worker):tags 整写改并集 → 2 红;独立变异(主线):跳过 `validateRelationTarget` 非法判决 → 非法阶段对测试精确 1 红,复原全绿。

**Judgment calls:** grade 不在四字段内未触碰(05/06 已单独处置);`reassign` 不支持区间语法(YAGNI);阶段合法性读活库而非 staged 状态——需要「先纠 type 再挂边」时必须并入同一 call,fixture 需先播种 type。
