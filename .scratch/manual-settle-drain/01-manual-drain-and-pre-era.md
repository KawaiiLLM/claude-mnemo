# 01 — Manual settle dispatches itself, and the era floor takes an explicit override

**What to build:** an operator running `POST /settle` gets a job that RUNS, not a
row that strands: the endpoint kicks a background drain of the target session's
due settlement jobs in the same request. A second payload field,
`allow_pre_era: true` (the exact literal, nothing weaker), lets a manual
backfill window cross the era floor deliberately.

**Why (the finding that forced it, [S15069/T1014]):** the original design
assumed "the row is picked up by the existing leak/claim path at the next
content event". Falsified in production for ACTIVE sessions: their own
turn-stops are threshold-gated (`plans.length === 0` returns before the drain
call) and the leak excludes the triggering session by contract — a manually
enqueued backfill for the live session had NO drain path until 25 consecutive
turns accumulated or the session ended.

**Decisions pinned:**

- The user's ruling ([S15069/T1015]): no automatic sweeping, ever. The global
  `eraCutoffEpoch` config is NOT moved (moving it would make ~70 cursor-less
  historical sessions residual-eligible — an uncontrollable auto-grind); the
  ONLY way pre-era turns get re-settled is one explicit manual window at a
  time.
- `allow_pre_era` is honored at the single guard site (`insertJob`), threaded
  as an options param — no second copy of the era check anywhere.
- Dispatch is kicked by the FETCH layer (`drainSettleSessionImpl`, defaulting
  to `core.noteSettlement.drainSession`), mirroring how turn-stop async work is
  tracked; the response gains `dispatch: "started" | "unavailable"` and the
  operator polls the job row for the verdict.
- `drainSession` joins the scheduler's public surface; claim serialization (one
  in-flight settle per session, ascending by window) is untouched, so
  concurrent calls self-serialize.
- Cursor safety re-verified, no change needed: cursor derivation already
  excludes `trigger_type = 'backfill'` and advances via `MAX` — a re-settled
  old window can never drag the cursor back or re-arm automatic planning.
- `duplicate_window` is the ONE refusal that still dispatches: the job it
  names exists and is due, and "run this window" is exactly what the operator
  asked — re-POSTing a stranded window is the re-kick lever, no sibling
  window needed.

**Status:** done — implemented 2026-08-20, typecheck + targeted tests green.

- [x] `/settle` success → drain starts in-request; refusal → no drain
- [x] `allow_pre_era: true` crosses the floor; `{}` and truthy-but-not-true do not
- [x] override lifts ONLY the era floor (range guards still refuse)
- [x] scheduler test reproduces the blind spot (own turn-stop inert) and
      proves `drainSession` reaches the job
