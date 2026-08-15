# 03 — One write tool, with per-field writes that say what they mean

**What to build:** `note` and `remember` become one tool. A caller corrects one field without restating the others, and a write that would silently destroy something is refused instead.

**Blocked by:** 02

**Status:** ready-for-agent

Merging is not tidiness: it removes an unfenced third writer of a turn's grade, type and tags, so the note-timestamp fence covers every write path without a new provenance column.

- [x] One tool writes turns and sessions; the old second entry point is gone
- [x] Session fields take the omit-versus-clear distinction turns already have: absent leaves alone, explicit null clears
- [x] A write to **any** non-empty field — turn or session — must declare `append` or `overwrite`; omitting the mode is an error, and an empty field needs no mode
- [x] `replace`, `replaceTags` and the bespoke tag merge are gone, not kept alongside the modes. Ticket 02 left every turn field on the strict subset of this rule (absent leaves alone, present overwrites), so this ticket adds the mode requirement on top rather than changing any field's meaning
- [x] No field carries a merge behaviour of its own. The count to drive to zero is five: that is how many disagreeing answers to "what does omission mean" the turn write path had before D5a
- [x] The receipt reports an accumulating field's total AFTER the write, not the delta
- [x] Content carrying tool-call syntax is rejected with a readable error rather than silently swallowing a field — 97 rows in production carry it today
- [x] Full suite green

## Closed

Merged into one tool named `note`; `remember.ts` deleted. `mergeTags` untouched, as pinned — the merged tool resolves append/overwrite at the MCP layer and always calls `updateTurnById` with `replaceTags`, so settlement's own direct caller is unaffected and ticket 10 still owns its retirement.

### Capabilities dropped, each with its evidence

- **Observation writes (`O<n>`).** Zero production callers; the writer was the retired extraction agent. Observations are captured mechanically by hooks, so no model-facing write path is needed.
- **Nested `regrade: {id, grade}`.** Retired by spec section I. A caller regrades with a second ordinary addressed call.
- **The `status` enum and the "grade is required when extracting" check.** No production callers; the latter contradicted `note`'s long-tested behaviour of writing prose on an ungraded live turn.

### The behaviour change worth knowing about

Pre-merge, `remember` wrote `turns.title/content/insight` directly for **every** turn, pre-cutoff ones included, bypassing the era gate. There is one path now, so a pre-cutoff turn's prose is shadow-only under every address form. That closes the isolation hole E1 names — but it also means prose written for a legacy turn lands where **nothing reads it**: no read path renders `shadow_notes` (only the metrics tooling, the note tool itself, backfill and the debt ledger touch that table). The call still answers "Noted".

Measured: **1988 of 8164 pre-cutoff turns carry no title, and none of them has a shadow note.** They were unfillable in practice before and are unfillable by construction now. The open question this leaves — whether a prose write on a legacy turn should be REFUSED rather than silently succeed into an unread table — is pre-existing `note` behaviour that this ticket merely made universal, and it is recorded here rather than decided.
