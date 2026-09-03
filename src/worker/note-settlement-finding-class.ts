import { settlementTurnPermissions, type SettlementProvenanceIndex } from "../db/write-gate";
import type { LaneCheckerError } from "../shared/lane-checker";

/**
 * THE CLASSIFICATION RULE (settlement-gate-taxonomy spec, "The classification
 * rule"; ticket 04). The ONE place a settlement finding's class is decided.
 *
 * > BLOCKING ERROR = a hard post-state invariant of this stage is violated,
 * > AND the finding anchors inside this run's judgment set,
 * > AND the run has a bounded, legal, honest repair action.
 *
 * All three, or it is a WARNING. There is no third class — "repairable but not
 * compelled" simply IS a warning.
 *
 * ## Why this exists as a rule rather than as a list of gates
 *
 * On 2026-09-01 job 166 (S15069, window 2202-2251) burned 81 minutes and 21
 * refused commits across two attempts and was ABANDONED, terminal, leaving 50
 * turns unsettled forever. What it was refused over was a lane disposition: it
 * had to dispose of fractures in a lane none of whose members it could write.
 * Runs that call `commit` three or more times are 17% of runs and 48% of
 * settlement's cache-read spend.
 *
 * Two written contradictions produced that, and BOTH are gone because this
 * rule now covers what a hand-written carve-out used to:
 *
 *   1. the report's own section header called warnings "aspirations, never
 *      enforced" while `commit` refused over one of them (a severed-lane
 *      fracture);
 *   2. `E3` printed under `## ERRORS` and was then hand-carved out of the
 *      commit gate as "beyond authority" — a rule stated in one place and
 *      contradicted in another.
 *
 * ## The three conditions, each answered in exactly one function
 *
 * Below, `violatesStagePostStateInvariant`, `anchorsInThisRunsJudgment` and
 * `hasBoundedLegalHonestRepair` each answer ONE of the rule's conditions for
 * EVERY finding kind. `classifySettlementFinding` is the only place they are
 * combined. So a new finding kind gains three arms and no new gate, and a
 * consumer that disagrees with a class has nowhere to express the
 * disagreement.
 *
 * None of the three is vacuous across the union: condition 1 separates the
 * forbidden states from the merely reported ones (the connectivity findings and
 * E6), condition 2 is live for a fracture (whose representatives may sit
 * anywhere in a lane that spans thousands of prompts), and condition 3 is what
 * demotes E3.
 *
 * ONE CONSEQUENCE, MEASURED AND STATED: a FRACTURE fails conditions 1 and 3
 * BOTH, because the spec's own table gives two independent reasons for it
 * ("Connectivity is a quality goal, not a legal post-state; a writable pair
 * does not imply a truthful relation"). Flipping either of those two arms
 * alone therefore changes no verdict anywhere — verified by running both
 * mutations against the whole suite. The fixtures pin the fracture's CLASS
 * rather than either arm, and condition 1's fracture arm is defence in depth:
 * it holds the line if a later reader decides a writable pair does after all
 * constitute a repair.
 *
 * ## What this rule is NOT
 *
 * It is not debt-id scoping. Nothing here asks whether a finding is one this
 * job CAUSED; it asks what this job can honestly repair. That distinction is
 * the same one the anchor filter has always drawn, evaluated one level finer.
 */

/** One thing a settlement surface can report. The class of each is decided by `classifySettlementFinding` and nowhere else. */
export type SettlementFinding =
  /** E3/E4/E6 — a grammar finding from `shared/lane-checker.ts`, carrying its own anchor turn. E3 and E4 name forbidden states; E6 is a warning class (`LaneWarningClass`). */
  | { kind: "grammar-error"; error: LaneCheckerError }
  /**
   * One severed-lane fracture: two islands of ONE lane with no edge between
   * them. `representativeA`/`representativeB` are the two islands' own
   * representatives — the pair a stitch would join, and the pair a reader is
   * pointed at.
   */
  | {
      kind: "lane-fracture";
      segmentId: number;
      tag: string;
      representativeA: number;
      representativeB: number;
    };

export type SettlementFindingClass = "blocking-error" | "warning";

/** The two facts about the RUN that conditions 2 and 3 are answered against. Nothing here is a fact about the finding. */
export interface SettlementFindingContext {
  /** This dispatch's IMMUTABLE WRITABLE SET — what it may address at all. */
  writableTurnIds: ReadonlySet<number>;
  /**
   * The same ids with the provenance that put each there. Absent means "every
   * writable id carries full authority", the correct reading for a job that
   * never transitioned.
   */
  writableProvenance?: SettlementProvenanceIndex;
  /**
   * THE JUDGMENT PREDICATE, handed in rather than recomputed: the SAME closure
   * the evaluator seam uses to decide what may be reported at all
   * (`note-settlement-sdk-query.ts`'s `evaluateWindowLanes`). One definition,
   * two askers — a second membership test here is exactly how a preview and a
   * verdict come apart.
   */
  anchorsInJudgment: (turnId: number) => boolean;
}

/**
 * CONDITION 1 — "a hard post-state invariant of THIS STAGE is violated".
 *
 * E3 and E4 name a state the model's own grammar forbids: a side tag absent
 * from that side's own endpoint (E4), a turn type outside the closed vocabulary
 * (E3). Those are legality, not quality.
 *
 * **E6 IS NOT, AND THIS IS WHERE IT IS DEMOTED** (user ruling S15069/T2465-
 * T2466, main-agent-edges ticket 14): "a side that resolves `ambiguous` is a
 * WARNING, nothing more." A blank side on a multi-lane endpoint is a LEGAL
 * post-state — the edge is a fact about two nodes and stays true whether or not
 * anyone ever picks which of the endpoint's lanes it was written from. It is
 * demoted on THIS arm rather than on condition 3 because the repair is perfectly
 * bounded, legal and honest (settlement may `declare` the side, and it should
 * when it sees one); what changed is that the state it repairs is no longer
 * forbidden, so the repair is offered and never compelled. The rule's own
 * header says it: "repairable but not compelled" simply IS a warning.
 *
 * A FRACTURE IS NOT an invariant violation either. Connectivity is a quality
 * goal — spec: "Connectivity is a quality goal, not a legal post-state" — and a
 * severed lane is a perfectly legal graph. The project already ruled that a
 * fabricated bridge is worse than an honest fracture, so treating a fracture as
 * an invariant violation would make the gate demand the very thing the ruling
 * forbids.
 */
function violatesStagePostStateInvariant(finding: SettlementFinding): boolean {
  switch (finding.kind) {
    case "grammar-error":
      return finding.error.class !== "E6";
    case "lane-fracture":
      return false;
  }
}

/**
 * CONDITION 2 — "the finding anchors inside this run's judgment set".
 *
 * A grammar error anchors at ONE turn the checker already chose for it (an edge
 * error at its CITING turn, a type error at the turn itself), so the question
 * is asked of that turn directly.
 *
 * A FRACTURE has two anchors and no third: it is a fact about the PAIR, so it
 * is judged here if EITHER representative is. Requiring both would silence a
 * fracture whose far side is, by construction, the out-of-window island the
 * boundary witness was loaded to name — i.e. it would silence every fracture
 * that reaches past the window, which is most of them.
 */
function anchorsInThisRunsJudgment(
  finding: SettlementFinding,
  context: SettlementFindingContext,
): boolean {
  switch (finding.kind) {
    case "grammar-error":
      return context.anchorsInJudgment(finding.error.anchorId);
    case "lane-fracture":
      return (
        context.anchorsInJudgment(finding.representativeA) ||
        context.anchorsInJudgment(finding.representativeB)
      );
  }
}

/**
 * CONDITION 3 — "the run has a bounded, legal, honest repair action". All three
 * words carry weight, and each of them disqualifies something below.
 *
 *   - BOUNDED: the anchor must be in this dispatch's writable set at all.
 *     Nothing outside it is a repair this run can attempt, at any price.
 *   - LEGAL: the authority this job holds over that anchor must reach the
 *     repair the class needs. E4 is discharged by declaring a valid lane or
 *     retracting the edge, which is RELATION authority — asked of
 *     `settlementTurnPermissions` rather than assumed, so a provenance added
 *     tomorrow without relation authority gets the right answer for free.
 *     **E3 IS DEMOTED HERE, and this is the spec's own reason**: its only
 *     repair is writing the turn's `type`, a NOTE FIELD, and the edge pass
 *     holds no such pen on ANY provenance (`STAGE_TWO_TURN_NOTE_FIELDS` refuses
 *     `type` on a window member as on every other class). Stage 1
 *     owns it as a blocker, through its own transition gate; a type emptied
 *     after the transition is the NEXT window's stage-1 debt, reached through
 *     its lookback. This replaces the hand-written "beyond authority" carve-out
 *     that used to sit inside the commit gate: the rule covers it now, so the
 *     carve-out is gone rather than restated.
 *   - HONEST: a repair that can only be performed by asserting something the
 *     run does not know to be true is not a repair. **THIS IS WHY A FRACTURE
 *     NEVER BLOCKS even when both its representatives are writable.** The only
 *     graph repair for a fracture is a stitching edge, and an edge is a CLAIM
 *     about a relation between two turns; two writable endpoints do not imply
 *     that any of the seven relation words truthfully holds between them.
 *     Forcing one manufactures a false edge, which this project already ruled
 *     worse than an honest fracture. (Condition 1 already answers `false` for a
 *     fracture, so this arm changes no verdict today — it is stated because the
 *     rule is a conjunction of three claims about the world and each of them
 *     must be true on its own terms, not merely arithmetically redundant.)
 */
function hasBoundedLegalHonestRepair(
  finding: SettlementFinding,
  context: SettlementFindingContext,
): boolean {
  switch (finding.kind) {
    case "grammar-error": {
      if (!context.writableTurnIds.has(finding.error.anchorId)) {
        return false;
      }
      if (finding.error.class === "E3") {
        return false;
      }
      return settlementTurnPermissions(context.writableProvenance, finding.error.anchorId).relations;
    }
    case "lane-fracture":
      return false;
  }
}

/**
 * THE RULE, applied. Every consumer asks this and obeys the answer; none of
 * them re-decides, and none of them carries a per-check exception.
 */
export function classifySettlementFinding(
  finding: SettlementFinding,
  context: SettlementFindingContext,
): SettlementFindingClass {
  return violatesStagePostStateInvariant(finding) &&
    anchorsInThisRunsJudgment(finding, context) &&
    hasBoundedLegalHonestRepair(finding, context)
    ? "blocking-error"
    : "warning";
}
