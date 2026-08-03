Verdict: fix first

## Findings

### Major

1. **The legacy adapter returns dangling ids and the advertised session in-degree omits legacy citations entirely.** `getEffectiveCitations` forwards parser output without resolving ids (`src/db/citations.ts:338-364`), and the test explicitly treats nonexistent `T4242` as effective (`tests/db/citations.test.ts:383-390`). Meanwhile `getSessionCitationInDegree` reads only `turn_citations` (`src/db/citations.ts:294-311`). This violates the governing “dangling ignored” and “era 前经行内适配器” rules (`spec.md:73-74`) and makes ticket 06's mechanical in-degree signal wrong for every `cites_recorded=0` turn.

2. **A non-spec global cap silently drops valid citations.** `INLINE_CITATION_PARSE_CAP` limits an entire content body to eight ids (`src/db/citations.ts:47-52,141-162`), and `getEffectiveCitations` uses that default (`src/db/citations.ts:357-362`). Section B limits only expansion of a *single range* to eight; it does not cap lists or multiple brackets (`spec.md:73`). The tests hide this from the literal fixtures by passing `64` (`tests/db/citations.test.ts:47-50`) and then positively assert the invented truncation (`tests/db/citations.test.ts:90-94`). A ninth legitimate legacy edge therefore disappears from pull-through and in-degree.

3. **Malformed bracket forms are partially salvaged instead of ignored whole.** `BRACKET_PATTERN` can match the inner bracket in `[[T12]]` (`src/db/citations.ts:54,151-154`), while `ANNOTATED_PATTERN` accepts any whitespace plus any nonspace token after the id (`src/db/citations.ts:59,122-125`). Consequently `[[T12]]`, `[foo [T12]]`, `[T12 , foo]`, `[T12 - 13]`, and multiline `[T12\nannotation]` produce `12`, contrary to the whole-form rejection rule (`spec.md:73`). The negative fixture table lacks nested, malformed-prefix, and multiline cases (`tests/db/citations.test.ts:53-76`). ASCII digits, safe-integer rejection, and `[T08] -> 8` are internally consistent; they are simply not pinned by fixtures.

4. **Semantically invalid integer ids can reject the entire tool call rather than be dropped and logged.** The public schema requires `.positive()` (`src/mcp/definitions.ts:45-53`), and the test requires `id: 0` to throw (`tests/mcp/remember.test.ts:954-973`). Section B says the element shape is `{id: integer, relation}` and then requires invalid/unresolvable ids to be dropped with logging while valid edges are retained (`spec.md:69`; ticket line 13). Zero/negative integer ids therefore never reach the per-edge drop path (`src/db/citations.ts:205-215`), so one bad id rejects the whole resend.

5. **The exported replace-set operation is not atomic unless every caller supplies an outer transaction.** `replaceTurnCitations` is public but explicitly delegates transaction ownership (`src/db/citations.ts:189-196`) while performing DELETE, N inserts, then flag update as separate statements (`src/db/citations.ts:237-257`). The production remember route wraps it correctly (`src/mcp/remember.ts:331-368`), but direct callers—including the new database tests—can publish a cleared/partial set on an insert failure. The public boundary should be atomic, or the transaction-required primitive should not be the exported consumer API.

6. **The remember route has a concurrent-delete partial-success path for nested regrade.** It resolves and validates `regradeTarget` before opening the write transaction (`src/mcp/remember.ts:297-317`), then ignores the return value of the transactional `updateTurnById` (`src/mcp/remember.ts:361-365`) and unconditionally reports success (`src/mcp/remember.ts:374-377`). If another connection deletes that target between validation and `BEGIN IMMEDIATE`, the main turn and citations commit while the regrade does not. Revalidate inside the transaction and require the regrade update to affect the intended row.

### Minor

1. **There is no batched session-wide edge-list API for ticket 02.** The only edge-list reader is per citing turn (`src/db/citations.ts:262-279`); `getEffectiveCitations` adds another per-turn query (`src/db/citations.ts:338-364`). A session consumer must use N+1 queries or duplicate SQL. Ticket 06 at least has a batched map, but that map has the legacy correctness defect in Major 1.

2. **The transaction-abort test proves only the first leg of the claim.** Its trigger fails during citation insertion before regrade executes, and it starts with no prior edges (`tests/mcp/remember.test.ts:910-934`). It proves rollback of the turn update, but not restoration of a deleted prior edge set or rollback after an already-executed nested regrade.

3. **Schema/migration coverage does not verify the declared integrity contract.** The schema test checks table/index/column names but not the composite PK or either FK action (`tests/db/schema.test.ts:1134-1157`). The “either endpoint” cascade test deletes only the cited endpoint's session (`tests/db/citations.test.ts:306-333`), so a missing citing-side cascade could pass. The migration test uses an in-memory toy schema and calls `initializeSchema` directly (`tests/db/schema.test.ts:1160-1209`), rather than reopening a realistic pre-ticket database through `initializeDatabase`; it therefore does not prove the ticket's old-database-open path.

## Summary

- Fix first: six major contract/correctness issues and three minor API/test gaps.
- Production MCP writes do use `createDatabase`, which enables `PRAGMA foreign_keys = ON` (`src/db/database.ts:65-86`, `src/mcp/server.ts:129-135`).
- Remember's normal turn update, edge replacement/flag, and nested regrade are otherwise enclosed in one transaction; no created-at predicate was found.
- Replace-set omitted/explicit-empty behavior, exact-edge dedupe, cross-session persistence, and `COUNT(DISTINCT citing_turn_id)` are implemented on the structured path.
- `bun run typecheck`, the full 1,248-test suite, targeted citation tests, and `git diff --check` pass.
- Rebuild was not rerun because it would modify the explicitly excluded generated bundles under the review's no-write constraint.
