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

**Reason stated, retirement not done — and the reason has since expired.**
The column is confirmed dead (nothing has read it since ticket 06's citation
union; `db/citations.ts`'s own comment says so), and the write/read/projection
removal is small. What made it a table rebuild in practice is that dozens of
fixtures in `tests/mcp/timeline.test.ts` and `tests/mcp/timeline.era-milestones.test.ts`
hardcode `cites_recorded` in raw SQL inserts — files ticket 14's concurrent
worker owned at the time. **14 has since landed, so `tests/mcp/` is free** and
this is ready to close as its own change. The write and projection sites carry
the note in the meantime.

## A sixth instance of the pattern, found here and left alone

`db/sessions.ts`'s `updateSessionSummaryRewrite` had exactly one caller: the
write-back this ticket deleted. It is still directly unit-tested, so it is not
untested — it is unreachable from any production write path, which is the same
defect class one step further along. Not touched: out of this ticket's fence
and not named by it.
