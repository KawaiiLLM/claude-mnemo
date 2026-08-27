# 01 — `commit` carries a friction report into the settlement metrics line

**What to build:** an operator reading the settlement log stream can see, per window,
what the settlement contract made hard — the judgments the agent could not express,
the refusals it routed around, the turns it could not read. Today the stream carries
only counts, which say what happened and never why it was awkward.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

## Why

The settlement metrics line already reports `turnsReviewed`, `relationsWritten`,
`relationsRetracted`, `lanesDeclared` and the rest with precision. What it cannot
report is the part that would actually improve the settlement flow: where the seven
relation words had no word for what the agent meant, which commit-gate refusal
(E3/E4/E6) sent it down a detour, which turns it could not make sense of.

Two rulings shape this, both made deliberately:

- **The field is REQUIRED, not optional.** An optional field here would be empty
  forever — an agent asked to volunteer a record writes nothing, which is a measured
  result, not a worry.
- **The field is FRICTION ONLY.** It must not restate the counts. A report that says
  "reviewed 52 turns and wrote 34 edges" spends the most expensive tokens in the run
  to duplicate a number the receipt already carries exactly.

## Decisions (settled — implement as given)

1. **`commit` gains exactly one required parameter, `report: string`.** Its input
   shape is currently `{}` (`src/worker/note-settlement-sdk-query.ts`, the `leasedTool("commit", …)`
   registration). Empty or whitespace-only rejects.
2. **No schema change.** No column, no table. The report reaches the operator through
   the existing `[claude-mnemo] note-settlement` metrics line as its own field, riding
   the same path the commit counts already ride: captured by the writes/staging layer
   at commit time, read back through `getLastCommitMetrics()`, emitted by
   `metrics({…})` in `src/worker/note-settlement-dispatch.ts`.
3. **Cap: 1000 characters, REFUSED above it, never truncated.** This matches the
   convention the public read knobs settled on in 0.21.1 — a bound the caller must
   respect, not a silent clamp. The refusal states the cap and the actual length.
4. **The contract lives in the tool DESCRIPTION**, not only in the prompt. The module's
   own comment already gives the reason: the description is the surface carried into
   every retry, so it is where a caller learns what it is being judged by.
5. **First successful commit wins.** `commit` is idempotent within a run and returns
   "Already committed" on a second call; a later call must not overwrite the report
   the successful one carried.
6. **A gate refusal must not lose the report.** The commit gate runs BEFORE
   `writes.commit()` and, on refusal, instead of it. The agent resends `report` on the
   retry, so nothing needs to be stashed — but confirm that is actually true rather
   than assuming it, and say so in the report.

## What the description must ask for

Name the categories rather than inviting free prose. The four that motivated this:

- where this window forced a guess;
- a relation the agent wanted and the seven words could not express;
- a commit-gate refusal (E3/E4/E6) it had to route around;
- turns it could not read, and why.

And say plainly what does not belong: any restatement of the counts.

## Acceptance criteria

- [x] `commit` refuses when `report` is absent, empty, or whitespace-only, naming the
      parameter.
- [x] `commit` refuses when `report` exceeds 1000 characters, stating the cap and the
      actual length; it never truncates.
- [x] A successful commit's `report` appears in the metrics payload emitted by
      `note-settlement-dispatch.ts`, verbatim.
- [x] A run whose commit was refused by the gate and then succeeded emits the report
      from the successful call.
- [x] A second `commit` in the same run does not replace the first report.
- [x] The tool description names the four friction categories and the exclusion.
- [x] Every new test is mutation-verified: name the observable, assert the mutation's
      needle matched and print that it applied, confirm red, restore from a backup
      taken AFTER the implementation landed, confirm green. Report the mutation and
      the catching test for each.
- [x] `npx tsc --noEmit` clean, `node scripts/build.js` succeeds, `bun test` green
      against the then-current baseline; report the number and account for the change.

## Out of scope

Persisting the report to the database, any read surface beyond the log line, and any
automatic analysis of the reports. The ruling was explicitly "the log line is enough";
if the log turns out to be too lossy, that is a later ticket with its own evidence.
