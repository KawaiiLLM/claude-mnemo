import { MAX_TURN_RELATION_DEGREE } from "../db/citations";
import {
  SETTLEMENT_BOUNDED_FIELDS,
  SETTLEMENT_READ_FIELD_BUDGETS,
  SETTLEMENT_READ_FIELDS,
  SETTLEMENT_READ_PAGE_BUDGET,
  SETTLEMENT_READ_TURN_BUDGET,
} from "./note-settlement-read-budgets";

/**
 * THE EDGE PASS, TAUGHT ONCE (main-agent-edges ticket 06; spec D6, and the
 * read-once spec's D6 as rewritten by that batch's §Consequences).
 *
 * Two prompts host the edge pass — the unified run's
 * (`note-settlement-unified-prompt.ts`, PHASE 2) and the cold resume's
 * (`note-settlement-prompt.ts`, the whole prompt) — and until this ticket
 * each carried its own wording of the same procedure, drifting apart one
 * amendment at a time (the resume prompt still worked the writable set in
 * "batches of ten" and re-read every lane's members for `relations`; the
 * unified prompt had already stopped). The impression teaching set the
 * precedent (`note-settlement-impression-teaching.ts`): one block, rendered
 * verbatim into both hosts, pinned in one place. This is the edge pass's.
 *
 * WHAT IT TEACHES, and why each part is here:
 *
 *   READ ONCE. `finalize` prints two address lists beside the frozen writable
 *   set: the WRITABLE DELTA (the citers the two closures admitted — relations
 *   only) and the CONTEXT DELTA (frozen lane members and cited endpoints the
 *   first read never covered — read-only, one hop). Both are SET DIFFERENCES
 *   against what stage 1 read, computed inside the transition transaction
 *   after every stage-1 write (`db/note-settlement-snapshots.ts`,
 *   `computeSettlementReadDeltas`), so an address already read is in neither.
 *   Stage 2 reads the union ONCE, paginated, with the same field list and
 *   budgets as the first read, and then reads nothing until a write is
 *   refused naming a turn whose relations changed. The retired shapes — ten-
 *   turn batches, "recall that lane's members with relations", "before any
 *   edge write, recall the citing turn" — each bought a round trip the one
 *   read had already paid for.
 *
 *   DECLARE. A lane side is RESOLVED at read time (declared → derived from
 *   the endpoint's single lane → none) and STORED only where the endpoint sits
 *   in several lanes (spec D2). So E6 is exactly "a blank side on an endpoint
 *   with two or more lanes" and E4 "a stored side no longer among its
 *   endpoint's lanes"; a blank side on a unique or lane-less endpoint is never
 *   a finding, and a declaration on a unique endpoint is refused as derivable
 *   (`declareEdgeSides`, D4). The `declare` entry is the ONE way a stored side
 *   moves — an attach carrying side tags onto an existing pair changes no side
 *   (ticket 03's facade notice says so on the receipt).
 *
 *   FILL. The main agent already wrote the edges it knew about, as bare
 *   addresses without lane sides (spec D3, ticket 05). This pass adds what
 *   hindsight shows it missed, in the same form, one edge per pair under the
 *   20-out / 20-in caps, judged by the rubric's 三个关系类 entry — the two
 *   traps measurement found (adjacency is not use; a satisfied blocker is
 *   completion, not a correction) are the only judgment sentences kept here,
 *   because the rubric does not carry them.
 *
 *   REVIEW. Retraction addresses the PAIR with the mirror's own class as the
 *   precondition (T2432 P1); `lane_check`; the ONE handover debt (a homeless
 *   turn's edges — ticket 14 deleted the other, the side-citer debt, with the
 *   repair channel it belonged to); then the host's own impressions, narrative
 *   and commit teaching, which this block does not repeat.
 *
 *   ONE PLACEMENT PER PAIR. A citing turn in two worklist lanes is visited
 *   twice; the pair's sides are decided ONCE over the whole worklist before
 *   anything is written, so worklist order never picks the placement (read-
 *   once D6's multi-lane rule, carried verbatim in substance).
 */

/** How the read step names the recall call — the SAME numbers the topic pass's step 1 prints. */
function renderReadCall(): string {
  const fields = SETTLEMENT_READ_FIELDS.map((field) => `"${field}"`).join(",");
  const budgets = Object.entries(SETTLEMENT_READ_FIELD_BUDGETS)
    .map(([field, budget]) => `${field}:${budget}`)
    .join(",");
  return (
    `\`filter={fields:[${fields}],fieldBudgets:{${budgets}}}\`, ` +
    `\`boundedFields:${JSON.stringify(SETTLEMENT_BOUNDED_FIELDS)}\`, ` +
    `\`turn:${SETTLEMENT_READ_TURN_BUDGET}\`, \`pageBudget:${SETTLEMENT_READ_PAGE_BUDGET}\``
  );
}

export function renderEdgePassTeaching(): string {
  return [
    "THE EDGE PASS — DECLARE, FILL, REVIEW.",
    "",
    "READ ONCE. `finalize`'s result prints one address list beside the frozen",
    "writable set and the worklist. CONTEXT DELTA: every frozen lane member and",
    "every turn a writable citer's edge points at that the first read never",
    "covered; read-only judgment material, ONE HOP — a context turn's own edges",
    "are not followed further — and a relation write on one is refused. It is a",
    "set difference against what was already read, so an address from the first",
    "read never appears in it. Read it ONCE, in as few",
    "pages as the envelope allows, as a list of turn addresses with",
    `${renderReadCall()} — the same field list and budgets as the first read, so`,
    "`relations` arrives with everything else. After that sweep, READ NOTHING",
    "FURTHER: the only later read is the one a refused write names — a turn",
    "whose relations changed under you — and it is that turn's `relations`",
    "alone. A `relations` reported CUT already licenses an edge write on that",
    "turn; only a DROPPED one must be read again before writing there.",
    "",
    "DECLARE. A lane side is RESOLVED when read, not stored: declared where a",
    "declaration exists, else DERIVED from the endpoint's single lane, else",
    "none. A side is STORED only where its endpoint sits in SEVERAL lanes, and",
    "that is the whole of this act: an outgoing edge of a writable citer whose",
    "side is blank on such an endpoint reads AMBIGUOUS and is reported as E6, a",
    "WARNING that blocks nothing — declare it where the material you are",
    "already holding says which lane, leave it where it does not, and an edge",
    "left ambiguous is a legal row nobody will refuse you over. A stored side",
    "no longer among its endpoint's lanes is E4, and that one DOES block: it is",
    "a claim its own endpoint contradicts, so `declare` a lane the endpoint",
    "carries, or retract the edge. A blank side on an endpoint in ONE lane or",
    "in NO lane is never a finding at all, and declaring one is refused as",
    "derivable. Declare with `note`'s",
    "`declare` entry on the CITING turn: `{ \"turn\": \"S15069/T7\", \"tailTag\":",
    "\"a\" }` or `{ \"turn\": \"S15069/T7\", \"headTag\": \"b\" }` — `tailTag` the lane",
    "THIS turn's claim belongs to, `headTag` the lane in which the cited",
    "principal result is used; omit a side to leave it alone, send `null` to",
    "clear it, and send `class` when you want the call refused if the pair's",
    "class has moved since you read it. A declaration is the ONE way a stored",
    "side moves: an edge entry carrying side tags onto a pair that already has",
    "a row changes no side, and the receipt says so. A citing turn in two",
    "worklist lanes is visited twice; decide `(tailTag, headTag)` for each of",
    "its pairs ONCE, over the whole worklist, before you write — one pair, one",
    "row, each side named only where it needs naming — and a second visit",
    "never re-places what the first decided.",
    "",
    "FILL. Each turn's writer already recorded the edges it knew about, as",
    "bare addresses with no lane side. Add only what hindsight shows it",
    "missed, in the same form: a bare address under correct/verify/use",
    "(`\"S15069/T7\"`; `correct` carries its coverage bit — `{ \"turn\":",
    "\"S15069/T7\", \"coverage\": \"full\" }` or `\"partial\"`, refused without",
    "it, and refused on `verify`/`use`), judged by the Memory Rubric's",
    "**三个关系类** entry above: one edge per pair at the most specific class, at",
    `most ${MAX_TURN_RELATION_DEGREE} outgoing per citing turn and ${MAX_TURN_RELATION_DEGREE} incoming per cited turn,`,
    "a stronger class replacing a weaker one in place. Where the new edge's",
    "endpoint sits in several lanes, the same call carries its `declare` entry.",
    "Adjacency, a shared topic and preserving a lane's shape are never use",
    "evidence; a blocker satisfied by doing the work is completion (use), not",
    "a correction of the blocking judgment. Both endpoints must be in what you",
    "have read: a cited turn you never read stays uncited.",
    "",
    "REVIEW. Retract a wrong edge with `retractCorrect`/`retractVerify`/",
    "`retractUse` and the bare address: the PAIR is the address, and the",
    "mirror's own class is the precondition — a pair that now carries a",
    "different class refuses, naming the class it carries, so a stale read",
    "never deletes a claim it did not see. Then `lane_check`: an E4 anchored on",
    "a citer in your writable set is yours and blocks `commit` — repair it with",
    "a `declare` entry naming a lane the endpoint carries, or with a",
    "retraction, never with a tags write. An E6 on the same list is a warning:",
    "read it, declare what you can honestly declare, and commit either way.",
    "Then the one handover debt, over the list `finalize` printed and nothing",
    "wider:",
    "   HOMELESS RETRACTION, with cause. A turn in the homeless list has no",
    "   legal task container, so no lane can ever attribute a side of its",
    "   edges. Retract those rows. The retraction records itself — the deleted",
    "   row's full identity and the group that caused it are written with the",
    "   deletion. Never open a task or mint a lane to give such a turn a home;",
    "   that is the main agent's act, with the user in front of it.",
  ].join("\n");
}
