# 05 — 结算逐笔直写

**What to build:** 结算的 remember/note 每笔即时过门+落库、回执即收;staging 留而不用;失租的旧认领者被新鲜性门自然拒绝。

规范:spec「结算(直写改造)」。

- handler 从 stage* 改直写:每笔在门的同一事务里判定+写+盖章;staging 引擎不再被接线(代码保留,物理删除 out-of-scope)。
- **结算写者身份=claim generation**(01 钉的 `claim:<jobId>:<generation>` 编码):新旧认领者互为「其他写者」——A 失租后 B 重跑,B 写过的字段对 A 失效,无独立 CAS。
- yield 包摄:agent 晚到笔记已为 turn 的 type/tags 盖章(01 的映射)→结算对这些字段的写触发「已失效」,报文即新的 yield 语义;专用 noteSupersedesReview 检查退役。
- 归属纠错**写事务内重验**该段仍挂靠本会话(roster 快照仅提示)。
- propose 幂等键(job+规范化 payload 唯一约束),重试回执「已存在」。
- pre-run 资格快照(eligibleRelationPairKeys)保留原样。
- 结算 context 构建接入 01 的记录接缝(渲染即授权)。

**Blocked by:** 01、02(门与印章)、04(新窗口/prompt 结构)。

**Status:** done (2026-08-19)

- [x] 每笔直写落库可查,无 commit 前置 — `note-settlement-direct-write.ts`'s `writeNote`/`writeMembership` call `evaluateSettlementTurnWrite`/`evaluateSettlementMembershipWrite` with `apply:true` directly, wired into the SDK's `note`/`remember` tools in `note-settlement-sdk-query.ts`. Re-check: `tests/worker/note-settlement-direct-write.test.ts` "note/remember land immediately" + `tests/worker/note-settlement-sdk-query.test.ts`.
- [x] 失租场景:B 写后 A 的同字段写被「已失效」拒(写者=claim generation) — `note-settlement-turn-facade.ts` gates grade/type/tags each independently via `checkFieldGate(db, claimWriterId(jobId, claimGeneration), "turn", turnId, field, ref)`. Re-check: `tests/worker/note-settlement-turn-facade.test.ts` "a lapsed claimant's write goes stale...".
- [x] 晚到笔记场景:type/tags 纠正被门拒,报文指向重读 — `noteSupersedesReview` deleted; type/tags checked via the same per-field gate, yielding on the gate's own stale message ("recall(id=..." teaching text). Grade is a third, independently-gated field — never note-derived, so it lands regardless of type/tags yielding on the same call. Re-check: `tests/worker/note-settlement-turn-facade.test.ts` "yields type/tags (but not grade)...".
- [x] 归属越权(渲染后 detach/close 的段)在写时被拒 — `evaluateReassign` re-reads `getAttachedSegmentIds` live (not the frozen `context.attachedSegmentIds`) plus a live `getSegment(...).status !== 'closed'` check — attachment rows never expire in this schema (see `segment_attachments`'s own doc comment), so CLOSE is the live half that actually fires. Re-check: `tests/worker/note-settlement-membership-facade.test.ts` "a segment closed AFTER the roster snapshot..." + "...attached AFTER the roster snapshot...".
- [x] propose 重复窗口重试不产生第二行 — `note_settlement_proposals` gains `addresses_key` (canonical sorted/deduped JSON) + `UNIQUE(session_id, addresses_key)`; `recordNoteSettlementProposal` does `INSERT ... ON CONFLICT DO NOTHING` then falls back to a `SELECT` on conflict, returning `{record, alreadyExisted}`. Re-check: `tests/db/note-settlement-proposals.test.ts` "a duplicate propose..." + `tests/worker/note-settlement-membership-facade.test.ts` "a duplicate propose from a DIFFERENT job id...".

**Implementation record.** New file `src/worker/note-settlement-direct-write.ts` replaces `note-settlement-staging.ts`'s WIRING role (staging.ts itself is untouched-but-unwired, per scope — still compiles, still has its own passing test suite). `ReviewOutcome` redesigned from a single `kind: "written"|"yielded"` tag to per-field `{grade?, type?, tags?}: {value, landed, yieldedReason?}` — this is the mechanical consequence of moving from one note-timestamp check to three independent gate checks. `note-settlement-context.ts` records read grants for every rendered turn (prior+window) under `claimWriterId(job.id, job.claimGeneration)`, once, right after context assembly — the seam ticket 01 built for this. `commit`'s tool description and the settlement system prompt were rewritten to drop "STAGE/validated now, written when you call commit" language (would have been actively misleading post-direct-write).

**Judgment calls (flagged for review):**
1. Relations (`evidenceFor`/etc.) are NOT gated through `checkFieldGate` — left exactly as the existing `eligibleRelationPairKeys` pre-run-snapshot ∩ current-pair-existence mechanism, per the pinned decision "keep exactly as is." Only grade/type/tags moved onto the write gate.
2. Membership `reassign` is NOT gated through `checkFieldGate` either — turn→segment membership isn't a scalar field on one entity in the gate's vocabulary; validated instead via the live-attachment/live-status read described above. This is a domain check, not a write-gate consumer.
3. Per-write lease fencing is deliberately ABSENT from `writeNote`/`writeMembership` (pinned decision: "claim 栅栏不再需要独立的逐写检查") — only `commit` checks job-claim validity. A residual, spec-accepted gap: if a reclaimed claimant A attempts a field neither A nor the new claimant B has touched yet, A's write can still land (no grant exists yet to go stale). This is inherent to the spec's design, not something I introduced or could unilaterally close without adding the per-write CAS the spec explicitly forbids.
