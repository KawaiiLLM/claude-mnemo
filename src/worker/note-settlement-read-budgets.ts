import type { RecallTurnField } from "../mcp/memory-filter";

/**
 * SETTLEMENT-READ-ONCE TICKET 01, spec D1 — the budget contract the stage-1
 * read is taught to send, in one place so the prompt RENDERS the numbers
 * rather than restating them where a later measurement could silently
 * contradict them.
 *
 * MEASURED 2026-09-02 on a read-only clone of production
 * (`scratchpad/repro/copy.db`, 14,132 turns; window = the last 30 days,
 * 2026-08-02..2026-09-01, 4,532 turns). Each number below is the p95 of the
 * ESTIMATED TOKEN COST of the field's own stored text — the same quantity
 * `cutFieldText`/`cutFieldLines` compare a budget against — rounded up to the
 * next ten.
 *
 * | field    |     n | p50 | p90 | p95 | p99 |  max | budget |
 * |----------|-------|-----|-----|-----|-----|------|--------|
 * | content  | 3,746 | 185 | 299 | 354 | 475 |  790 |    360 |
 * | insight  | 1,029 |  56 |  89 |  98 | 118 |  155 |    100 |
 * | metadata | 4,532 |  18 |  26 |  29 |  35 |   47 |     30 |
 *
 * CONTENT'S TAIL IS ONE ARTIFACT CLASS, and this is the table's single
 * judgment call, stated rather than buried. Over ALL 3,951 turns with content
 * the p95 is 3,395 — but the 205 compact-synthetic rows (5.2%; a `/compact`
 * boundary turn whose `content` is Claude Code's own compact summary) run p50
 * 5,540 / max 10,760 and are ONE HUNDRED PERCENT of everything above 790.
 * Sizing every turn for them would push `turn` to about 4,900 on its own and
 * cost the page two thirds of its turns, to carry whole a class the settlement
 * writer reads as a boundary marker. So the budget is the p95 of the 3,746
 * NON-compact turns, and a compact row reports `content cut` — which is what
 * D2's footer exists for, and what spec D1 means by "the ~5% longer ones are
 * the `cut` re-reads D2 pays for, by design".
 *
 * `prompt` is 50 by standing rule (spec D1: the user's opening words as topic
 * ground truth, never authority text) and is the ONE field settlement declares
 * in `boundedFields` — reaching 50 is the contract, not a loss. Production
 * `user_prompt` is p50 36 / p95 2,217 tokens, so this cap fires constantly and
 * on purpose.
 *
 * `relations` is sized from the CAP, not from a percentile: spec D0 bounds a
 * node at 20 outgoing + 20 incoming, and ticket 06 measured today's widest
 * rendered atom at 76 characters (~19 tokens). Forty such atoms join to 770
 * tokens (measured), so 800 renders every one of today's nodes whole with room
 * over. A wider legal atom in future may `cut`, which D2 reports and which —
 * `relations` being delivery-gated — does not touch the edge-write grant.
 */
export const SETTLEMENT_READ_FIELD_BUDGETS: Readonly<
  Partial<Record<RecallTurnField, number>>
> = {
  metadata: 30,
  content: 360,
  prompt: 50,
  insight: 100,
  relations: 800,
};

/**
 * The field union BOTH settlement stages read, in the order the renderer emits
 * them. Stage 1 asks for all six once; stage 2's delta sweep asks for the same
 * six, so nothing either stage needs costs its own round trip.
 */
export const SETTLEMENT_READ_FIELDS: readonly RecallTurnField[] = [
  "title",
  "metadata",
  "content",
  "prompt",
  "insight",
  "relations",
];

/** The one field settlement reads INTENTIONALLY short (spec D1). */
export const SETTLEMENT_BOUNDED_FIELDS: readonly RecallTurnField[] = ["prompt"];

/**
 * `turn` = Σ field budgets + structural overhead + 10% (spec D1).
 *
 * MEASURED through the real renderer, not estimated. A turn carrying every
 * field at exactly its budget above, its title at the 180-character render
 * cap, and forty relation atoms wide enough to spend the whole 800-token
 * relations budget, rendered at the plain range's own indentation:
 *
 *   Σ field budgets                                  1,340
 *   structural overhead (capped label, field labels,
 *     per-line indentation, 40 atom-row indents)       115
 *   RESERVED worst-case `truncated:` footer             20
 *                                                    ------
 *   worst-case rendered turn                          1,475
 *   + 10%                                             1,623  -> 1,625
 *
 * The reserve is part of the ceiling because it is subtracted from the budget
 * BEFORE the body ladder runs (spec D2): a turn given 1,475 would render 1,455
 * of body and lose the last twenty tokens to a footer it might not even need.
 *
 * 1,625 is well under `MAX_TURN_BUDGET` (5,000), so `content` keeps its
 * measured p95 target and the spec's "content takes the remainder" clause
 * never fires.
 */
export const SETTLEMENT_READ_TURN_BUDGET = 1_625;

/**
 * `pageBudget`, explicit (spec D1) — and derived from the CHARACTER envelope
 * rather than from `MAX_PAGE_BUDGET`, because at this render's measured
 * density (4.26 characters per estimated token: indentation prices as space
 * runs, so a token estimate under-reports characters) the two ceilings do not
 * agree. `MAX_PAGE_BUDGET` 25,000 would translate to ~106,500 characters —
 * past the 100,000-character worker envelope. 23,000 translates to ~97,990,
 * and still holds fifteen worst-case turns (21,844 tokens measured).
 */
export const SETTLEMENT_READ_PAGE_BUDGET = 23_000;

/**
 * GO/NO-GO (spec D1), reported rather than squeezed.
 *
 * The spec's conservative test — `15 × turn + headers + footer ≤ 25,000` —
 * gives 15 × 1,625 + 19 = 24,394. **GO.** Sixteen gives 26,019: no. The 19 is
 * the measured framing of a one-session page (the `page x / y (total z)` line
 * plus one session summary line).
 *
 * The same page measured as REAL RENDERED TEXT, fifteen blocks each at every
 * field's cap: 21,844 tokens and 93,074 characters — inside `MAX_PAGE_BUDGET`
 * and inside the 100,000-character envelope, with about 7% of the envelope to
 * spare. Nothing was squeezed to reach fifteen; that is simply where the
 * measured numbers land, and the packer measures actual cost, so an ordinary
 * page (p50 content is 185 against a 360 cap) carries considerably more.
 */
export const SETTLEMENT_READ_TURNS_PER_PAGE = 15;
