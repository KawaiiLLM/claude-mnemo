# 10c — The envelope, its parser and its write-back are deleted

**What to build:** The structured envelope and everything that existed to interpret it are gone, and the settlement job log reports the work that actually happened.

**Blocked by:** 10d

**Status:** done

Expand–contract. 10b made `commit` the only live writer, which leaves the envelope path present but unreached. This ticket deletes it, in its own change, so that a bug in the new path is never confused with a bug in the deletion.

- [x] The structured envelope, its response parser, and the write-back layer that interpreted it are deleted
- [x] The settlement prompt's session-summary step goes with them — spec A3/D1 says settlement has no summary tool, and the step outlived the surface it wrote to
- [x] The prompt's envelope-shaped instructions are replaced by the tool protocol the agent actually uses
- [x] The three-strike cursor advance is documented in the job log as abandoning a remainder, not converging
- [x] Full suite green

## Withdrawn: the segment relation fields

This ticket briefly carried a criterion restoring the four relation fields to
the segment call, on the grounds that A3's "no edge tool" rule presumes an edge
lives as a field on whatever asserts it. **Withdrawn by user ruling
(S15069/T746, spec K7a):** the MVP supports no segment-asserted relation. A
segment still gains bare pairs from its own body citations, and the link
between two arcs is carried by the turn edges crossing their boundary —
derived from members rather than restated a level up.

## Inherited from 10a: the metrics sink reads zero

`note-settlement-dispatch.ts`'s `metrics()` sources `turnsReviewed`, `notesReconstructed` and their siblings entirely from the write-back's result. Since 10a moved turn writes onto a tool, the model no longer emits those envelope sections, so the counters report zero while the work happens through calls nothing counts. It is a log sink, not a health surface, so nothing broke — but it is telemetry that has stopped reflecting reality, and this is the ticket that owns the code.

- [x] The job log counts what the tools actually did, sourced from `commit`'s own result rather than from a payload nobody sends
- [x] The per-grade histogram still reaches the operator's log and still reaches no agent-visible surface (spec G9)

## Dead storage to retire while the area is open

`turns.cites_recorded` is written by `hooks/capture-repair.ts` and projected by `db/turns.ts`, and nothing has consumed it since the citation read path became a union. It is the fifth instance in this effort of storage still written after its only reader went away. It is a `NOT NULL` column threaded through two migration paths and the table-rebuild SQL, so retiring it properly is a table rebuild — removing only the write and the projection would leave the column as dead storage, which is the same smell inverted.

- [x] `cites_recorded` is retired whole — column, writer and projection — or the reason not to is stated

**Retired.** No live reader existed — confirmed independently by grepping
`src/` and `tests/` before touching anything, matching `db/citations.ts`'s own
comment that the column survives only as inert history. The column is gone
from `SCHEMA_SQL`, both migration paths (`ensureTurnCitationsSchema`'s ALTER,
now deleted outright) and the table-rebuild SQL; the write in
`hooks/capture-repair.ts` and the projection in `db/turns.ts` are removed. A
new table-rebuild migration (`retireTurnCitesRecordedColumn`, same
rename-build-swap idiom as `ensureTurnTypeMultiValueColumn`) drops it from an
existing database; it runs AFTER the type-multivalue rebuild so it never has
to decide `type`'s shape itself. Every fixture that hardcoded the column
(`tests/mcp/timeline.test.ts`, `tests/mcp/timeline.era-milestones.test.ts`,
`tests/hooks/*`, `tests/db/schema.test.ts`, `tests/db/citations.test.ts`) is
updated; several tests whose entire premise was the retired flag's behaviour
are removed rather than left asserting nothing.

Verified against a full-fidelity copy of the real production database
(`~/.claude-mnemo/claude-mnemo.db`, ~11.7k turns): row count, foreign keys and
every other column's values survive intact, and a second `initializeDatabase`
call is a no-op. That same verification surfaced an adjacent, PRE-EXISTING bug
in the already-shipped `ensureTurnTypeMultiValueColumn` (ticket 02): production
is also still behind on that migration (`type` has never been widened there),
and its column list — written before four now-fully-retired
`extraction_stall_*` columns existed — would have silently dropped them the
next time it fired for real, unrelated to `cites_recorded` entirely. Fixed in
the same change (both rebuilds now carry `extraction_stall_*` through
untouched, since retiring THAT family is a decision for
`.scratch/extraction-redesign/`'s own ticket, not a side effect of this one),
plus a new `assertNoUnexpectedTurnsColumns` guard in both rebuilds that fails
loudly instead of silently dropping the next column neither one is told
about. Also discovered, not touched (same "found here, out of fence" pattern
as the sixth instance below): production is additionally behind on the
ticket-05 `memory_edges` pair-identity rebuild and the `turn_citations`
retirement — both already-shipped, already-tested migrations that will also
fire on the next reload.

## A sixth instance of the pattern, found here and left alone

`db/sessions.ts`'s `updateSessionSummaryRewrite` had exactly one caller: the
write-back this ticket deleted. It is still directly unit-tested, so it is not
untested — it is unreachable from any production write path, which is the same
defect class one step further along. Not touched: out of this ticket's fence
and not named by it.
