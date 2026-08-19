# 01 — 读集与印章存储层 + 记录接缝

**What to build:** recall/timeline/SessionStart 注入渲染过的实体,立即可在读授权表查到;每笔字段写留下单调序印章;agent 笔记写入同时为其 turn 的 note 派生字段盖章。

规范:`.scratch/read-write-contract/spec.md`「门(写面)」节。

- 读授权表(写者、实体类、实体 id、read_at)+ 字段印章表(实体类、实体 id、字段、写者、**单调序列号**——不用整数秒比较,同秒歧义见 spec)。
- 记录接缝:一个共享 API,挂进**主 agent 读径**(recall/timeline 工具渲染、SessionStart 注入渲染);**不碰结算侧**(worker/note-settlement-* 是票 04/05 领地,结算 context 的记录随 05 接线)。
- 印章映射:agent 笔记写入(note 工具)为该 turn 的 type/tags 盖印章(写者=agent 会话)——票 05 的 yield 包摄依赖此条。
- 写者身份编码(跨票契约,勿改):`session:<dbId>`(主 agent)/`claim:<jobId>:<generation>`(结算,05 使用)。
- 回收:session 终结清其读集;janitor 兜底。
- 显式 null 清空=一次写(盖章);清空后字段是「被写过」。

**Blocked by:** None — can start immediately.

**Status:** done

**Implementation record:**

- New shared module `src/db/write-gate.ts` (the one both 02/03 and future 05
  import): `write_gate_reads` (writer, entity_type, entity_id, read_at_epoch,
  read_sequence — PK on writer+entity) and `write_gate_stamps` (entity_type,
  entity_id, field, writer, write_sequence, written_at_epoch — PK on
  entity+field), plus a single-row `write_gate_sequence` counter, all added to
  `SCHEMA_SQL` in `src/db/schema.ts` (new tables, no migration needed).
  `entity_type` CHECK already includes `session` (judgment call below).
- **Non-destructive design**: a write never deletes another writer's grant
  row. `recordReadGrant`/`recordReadGrants` snapshot the CURRENT sequence
  counter value into the grant; `checkFieldGate` compares that snapshot
  against a field's stamp sequence to decide staleness. This is what makes
  "never-read" and "stale" distinguishable in a later gate check (a plain
  delete-on-write scheme collapses both to the same "no grant" state — see
  ticket 02's dual-session test, which depends on this).
- Recording seam wired into: `recall.ts`'s `renderRoutedId` (segments,
  segment-members, turns, turn-by-id kinds — sessions/observations
  deliberately out of scope, no main-agent writer there), `timeline.ts`'s
  `timelineQuery` (segment route + session route, reading grants off the
  ALREADY-COMPUTED view's `pageMembers`/`keptMilestones`/`pageTurns`/
  `pagedMilestones` — no duplicate resolution logic), `mcp/handlers.ts`
  (production wiring: `readerId` derived from the same `resolveCallerSessionId`
  note/remember already use), and SessionStart injection
  (`session-composition.ts`'s `renderAttachedSegmentBlock` →
  `context-segments.ts` passes `sessionWriterId(session.id)`).
- `note.ts`: every turn write that touches title/content/insight/type/tags
  stamps whichever fields it resolved, writer = caller session (skipped when
  caller identity unknown). Subsumption: ANY successful turn write ALSO
  stamps `type`/`tags` even when this call didn't touch them — settlement's
  own yield check (05) reads this as "the agent has fresher knowledge of this
  turn than my snapshot."
- Cleanup: `session-end.ts` now calls `clearReadGrantsForWriter` for the
  ending session plus `sweepReadGrantsForCompletedSessions` (bounded at 20)
  as the janitor backstop for a missed cleanup (e.g. a crash between an
  earlier session's completion and its own SessionEnd call).

**Judgment calls:**

1. `entity_type` CHECK widened to `('segment','turn','session')` up front,
   even though nothing in tickets 01–03 writes a `session` grant/stamp — a
   CHECK constraint cannot be ALTERed (schema.ts's own established reason for
   several other tables), so pre-widening now avoids a rebuild-table
   migration when ticket 05 needs it.
2. Read-grant recording covers `id`-addressed renders (recall/timeline's
   `id=` routes) and SessionStart's per-attached-segment blocks, NOT
   `recall(query=...)` search results or the bare-overview/roster listing.
   Spec's "统一渲染器渲染即记录" reads as exhaustive; I scoped to what
   tickets 01–03's own acceptance criteria and consumers (02/03) actually
   need, to keep the diff bounded — flagging this as a real gap for whoever
   picks up search-path recording next, not a silent omission.
3. Stamping is skipped entirely when the caller's session identity is
   unknown (`options.callerSessionId` not a number) — same "unknown always
   admits" latitude `note`'s existing `isCrossSessionWrite` already gives an
   unidentified caller. This is what keeps every pre-existing test that omits
   `callerSessionId` passing unmodified.

- [x] recall/timeline/注入渲染后,对应授权行可查(实体级) — `bun test tests/db/write-gate.test.ts` ("read grants" describe)
- [x] 字段写落印章,序列号单调且同秒无歧义 — `bun test tests/db/write-gate.test.ts` ("monotonic sequence" describe)
- [x] note 写 turn 时 type/tags 印章同事务落下(写者=会话) — `bun test tests/mcp/note.test.ts -t subsumption`
- [x] session 终结回收读集;janitor 幂等 — `bun test tests/hooks/session-end.test.ts -t "write gate cleanup"`
- [x] null 清空盖章;「从未写过」与「被清空」可区分 — `bun test tests/db/write-gate.test.ts -t "null-clear"` + `bun test tests/mcp/note.test.ts -t "null-clear"`
