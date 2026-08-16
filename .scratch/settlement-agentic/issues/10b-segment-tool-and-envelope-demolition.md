# 10b — The segment tool lands and the envelope is demolished

**What to build:** Settlement assigns segment membership through a tool as it decides it, and the structured envelope — with the parser and write-back layer that interpreted it — is gone.

**Blocked by:** 10a

**Status:** ready-for-agent

Three data-destructive defects came from re-implementing in a payload parser the authorization the tool layer already performs. Window-level atomicity is surrendered deliberately; per-call transactions are not.

10a built the fences and moved the turn half across. This ticket moves the segment half and deletes what is left.

- [ ] Settlement creates and extends segments, and records the no-segment verdict, through a tool under 10a's job-identity fence
- [ ] The structured envelope, its parser, and the write-back layer that interpreted it are deleted
- [ ] The settlement prompt's session-summary step goes with them — spec A3/D1 says settlement has no summary tool, and the step outlives the surface it wrote to
- [ ] A crashed window leaves a partial result and is not marked complete
- [ ] The three-strike cursor advance is documented in the job log as abandoning a remainder, not converging
- [ ] **A whole-rewrite field is rejected when omitted**, on the segment schema as on 10a's turn schema
- [ ] Full suite green

## The replay contracts spec G5 leaves undecided

G5 names three writes with no replay contract, and says so explicitly: *"The three unsafe rows need decisions before implementation."* They are this ticket's, and each needs its decision stated before code:

- **segment create is not idempotent** — a plain insert with no natural key, so a lost receipt yields two segments. Needs a stable job-scoped operation key, plus "the target state already exists, so succeed" semantics.
- **segment extend is not a union** — a revision compare-and-set overwriting title, content, type, tags and status. A replay with a stale revision must be distinguishable from a genuine conflict, and a segment the first write closed is frozen.
- **session `append` fields are not idempotent** — `A`, then a committed `append(B)` whose receipt is lost, replays to `A+B+B`. Settlement should not be exposed to session append at all, which resolves this one by removing it rather than by making it safe.

D5's `append`/`overwrite` mode expresses intent and drives the receipt. It does **not** confer idempotency, and an earlier draft leaned on it for a job it cannot do.
