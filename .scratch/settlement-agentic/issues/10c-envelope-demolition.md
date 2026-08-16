# 10c — The envelope, its parser and its write-back are deleted

**What to build:** The structured envelope and everything that existed to interpret it are gone, and the settlement job log reports the work that actually happened.

**Blocked by:** 10b

**Status:** ready-for-agent

Expand–contract. 10b made `commit` the only live writer, which leaves the envelope path present but unreached. This ticket deletes it, in its own change, so that a bug in the new path is never confused with a bug in the deletion.

- [ ] The structured envelope, its response parser, and the write-back layer that interpreted it are deleted
- [ ] The settlement prompt's session-summary step goes with them — spec A3/D1 says settlement has no summary tool, and the step outlived the surface it wrote to
- [ ] The prompt's envelope-shaped instructions are replaced by the tool protocol the agent actually uses
- [ ] The three-strike cursor advance is documented in the job log as abandoning a remainder, not converging
- [ ] Full suite green

## Inherited from 10a: the metrics sink reads zero

`note-settlement-dispatch.ts`'s `metrics()` sources `turnsReviewed`, `notesReconstructed` and their siblings entirely from the write-back's result. Since 10a moved turn writes onto a tool, the model no longer emits those envelope sections, so the counters report zero while the work happens through calls nothing counts. It is a log sink, not a health surface, so nothing broke — but it is telemetry that has stopped reflecting reality, and this is the ticket that owns the code.

- [ ] The job log counts what the tools actually did, sourced from `commit`'s own result rather than from a payload nobody sends
- [ ] The per-grade histogram still reaches the operator's log and still reaches no agent-visible surface (spec G9)

## Dead storage to retire while the area is open

`turns.cites_recorded` is written by `hooks/capture-repair.ts` and projected by `db/turns.ts`, and nothing has consumed it since the citation read path became a union. It is the fifth instance in this effort of storage still written after its only reader went away. It is a `NOT NULL` column threaded through two migration paths and the table-rebuild SQL, so retiring it properly is a table rebuild — removing only the write and the projection would leave the column as dead storage, which is the same smell inverted.

- [ ] `cites_recorded` is retired whole — column, writer and projection — or the reason not to is stated
