# 05 — 结算拆除

**What to build:** 结算收缩为「检查纠错」的空壳:选举与笔记重建整体移除,窗口 20–50;纠错职责由票 08 接上,本票后结算窗可「无事可纠」地正常完成。

规范:`.scratch/ownership-and-note-cadence/spec.md`「所有权」节;`.scratch/turn-edge-mechanism/spec.md` Legacy 政策。

- **duty 1(选举/评级)与 duty 2(笔记重建)移除**:提示、上下文、完成门、席位/分布校验(`computeElectionCeilingViolations`)一并。
- **归属门与活动记录表移除**;`assign` action 死;`propose` 保留:纯文本、最小簇 **1**(修订现行 ≥2)、不落库、不自动采纳、不进完成门。
- **段字段读面移除**([S15069/T906]):summary-flags 模块及其测试删除、结算提示的手搓段渲染删除、上下文的 attachedSegments 字段删除;换上**段名册**(id/title/topic,不含字段)供归属纠错([S15069/T912])。
- **窗口 20–50**:最小 20,短尾不结算,sessionend 豁免死;不足者留待累积。
- 完成门重写为纠错语义的空位(08 填充)。

**Blocked by:** None — can start immediately.

**Status:** done

**Implementation record:** 完成门缩为 fence+CAS 空壳(`db/note-settlement-completion.ts` 512 行→约 190 行),移除 segmentation/note/coverage/election-ceiling 四类拒绝原因。duty1(ELECTION_RANKING_RUBRIC)、duty2(reconstruction,title/content/insight 现被显式拒绝而非静默忽略)整体移出 prompt 与 context(`interiorHoles`/`rawMaterial`/`NoteSettlementTurnKind` 删除)。`assign` 从 membership facade 退役,`propose` 门槛 2→1、不再记录 completion 活动。段字段读面(`note-settlement-summary-flags.ts`+测试)删除,`attachedSegments` 换成 `segmentRoster`(id/title/topic,经 `getTopic` 解析,不含 content/insight)。`sessionend` 窗口豁免死(`db/note-settlement.ts` `remainderFloor` 恒为 `minWindowTurns`)。`note_settlement_membership_activity` 表 DDL 因越界(schema.ts 仅授权 election_tier 区)保留为孤儿表,代码侧读写面已清空。

- [x] 一个只含检查语义的窗口能正常完成;<20 turn 不唤起 — `bun test tests/db/note-settlement-completion.test.ts -t "NOTHING to correct"`; sessionend 见 `bun test tests/hooks/session-end.test.ts -t "opens NO window"`
- [x] propose 单 turn 可提;渲染为文本,无库对象(段) — `bun test tests/worker/note-settlement-membership-facade.test.ts -t "floor drops from 2 to 1"`
- [x] 段字段三件套删除后全套件绿(既有 bundle 守卫除外) — `bun test tests/worker/ tests/db/note-settlement-*.test.ts`(484 pass/0 fail)
- [x] 结算上下文含名册、不含任何段字段 — `bun test tests/worker/note-settlement-prompt.test.ts -t "id/title/topic only"`
