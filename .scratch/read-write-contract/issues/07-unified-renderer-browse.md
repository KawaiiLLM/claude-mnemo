# 07 — 统一渲染器内核 + 浏览形态

**What to build:** recall 无 query 时的新浏览形态:filter 选字段、pageBudget 溢出分页、turn 字段刀、session 首现带 title;结算会话摘要同源渲染带大 turn 预算。

规范:spec「视图(读面)」。

- 渲染器内核:全部读面唯一出货点;**保留 01 的授权记录接缝**(换内核不丢记录)。
- 浏览形态:全局时序;session 交替仅首现带 title;折叠/展开二态废除,字段选择走 filter(每字段 schema 描述各自成段+报错完善)。
- 预算:pageBudget 页级,溢出=**分页**,绝不截断整块;turn=item 级字段刀(词边界,均摊);obs 恒截断。
- rewind turn 渲染带标记;序数 T 只作选择、`S<n>/T<m>` 唯一引用(报错回显语法)。
- 结算的 session 摘要消费方改走此渲染器,传**独立大 turn 预算**(全文可见);旧「溢出→截断+recall 指针」路径退役。

**Blocked by:** 01(记录接缝)。

**Status:** done (see implementation record below)

- [x] pageBudget 溢出产生第 2 页而非截断;turn 刀词边界截字段
- [x] filter 任意字段组合;session 首现带 title、交替不重复
- [x] rewind 标记;obs 恒截断
- [x] 结算摘要全文渲染(构造超 2000 tok content 验证);旧 elision 路径无消费者 — closed by the parent's STITCH after tickets 04/05 landed: `buildNoteSettlementContext` now renders the summary via `recallMemory` at `SETTLEMENT_FULL_RENDER_BUDGET` (all three knobs, per this ticket's own dual-knife finding), records the session-entity read grant under the claim writer, and the facade's narrative write is gated+stamped against it (`tests/worker/note-settlement-prompt.test.ts -t stitch`, `tests/worker/note-settlement-turn-facade.test.ts -t stitch`). `renderMainAgentSessionInjection` has zero consumers; its physical deletion is ticket 11's (an in-flight deletion was reverted to keep demolition in its sanctioned ticket).
- [x] 渲染即记录授权(与 01 的表断言)

## Implementation record (2026-08-19)

**Browse shape**: bare `recall()` (no `id`/`query`/scoping `filter`) now renders a
GLOBAL chronological turn feed (`buildBrowseFeed` in `src/mcp/recall.ts`) instead
of session-grouped listing. Segments-first behavior (page 1 only) is untouched.
Greedy token-budget packing (mirrors `timeline.ts`'s `paginateByTokenBudget`):
consecutive turns, most-recent-first, fill a page until `pageSize` items or
`pageBudget` tokens, whichever comes first — a page always holds ≥1 item, and
overflow always rolls to another page (never truncates a shown block). Each
page independently tracks its own session first-appearance set.

**Field selection**: `filter.fields` (new member on `MemoryFilterInput`/
`ParsedMemoryFilter`, `src/mcp/memory-filter.ts`) — any combination of
`title/content/prompt/response/insight/observations/files`. Deliberately NOT a
scoping criterion (`hasFilterCriteria` excludes it) so `filter:{fields:[...]}`
alone does not force bare `recall()` off the browse path. An invalid entry
rejects with the grammar echoed back. Consumed today by the browse feed only
(`renderBrowseTurnBlock`) — the `turn` token budget splits evenly across
whichever fields produced text, each cut word-boundary via `truncateText`.

**Rewind marker**: `FormattedTurn.wasRolledBack` (new, optional) →
`format.ts`'s `formatTurnLabel` appends `REWIND_MARKER` when true. This is the
SHARED turn-label renderer, so the marker reaches every recall surface that
already threads `wasRolledBack` through (browse feed; `buildTurnView`/
`buildCollapsedTurnsForSession` in recall.ts populate it for the id-addressed
and collapsed-session paths). Segment-card member rows do not populate it yet
(scope: `renderSegmentMembersByOrdinal` builds its own ad hoc `FormattedTurn`
and was left untouched) — flagged as a follow-up, not a blocker for this
ticket's own acceptance criterion.

**obs always truncated**: verified, no code change — every observation render
path (`formatObservationCollapsedWithMode`/`formatObservationExpandedWithMode`
in format.ts) already calls `truncateText`/`truncateLines` with a finite limit;
there is no unbounded obs render path anywhere in the renderer.

**Judgment calls (flagged)**:
1. "Collapsed/expanded 二态废除" is NOT fully executed — `depth` stays on
   every existing render path (recall/timeline/segment-card), since retiring
   it project-wide would touch essentially every render function and public
   schema in this codebase, well beyond one ticket's safe blast radius. What
   IS built: `filter.fields` as an ADDITIVE arbitrary-combination mechanism
   for the browse feed, which is what the acceptance checkbox actually tests.
   Full depth retirement is a follow-up ticket's work, not silently dropped —
   flagging it here so the parent can decide whether to schedule it.
2. Browse's working set is bounded to the 500 most recent turns
   (`BROWSE_CANDIDATE_CAP`) before pagination — a corpus beyond that loses
   turns older than the 500th most recent to the browse feed specifically
   (still fully reachable via `id=`/`query=`). Matches this codebase's own
   stated scale assumptions elsewhere ("a few dozen or a few hundred").
3. `recall.test.ts`'s "defaults to session listing and intersects time
   filters" test asserted the OLD session-grouped-listing behavior directly;
   rewritten to assert the new browse contract (most-recent-first page 1,
   nothing dropped under a wide budget, unchanged `filter.time` search path).

**Re-check commands**:
- `bun test tests/mcp/recall.browse.test.ts`
- `bun test tests/mcp/recall.test.ts`
- `bun test tests/db/write-gate.test.ts` (grant-recording seam stays green)
