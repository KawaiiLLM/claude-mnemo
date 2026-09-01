import { createLogger } from "../shared/logger";
import { countTokens } from "../shared/token-count";
import type { SettlementScopeProvenance } from "./note-settlement-context";

/**
 * THE THIRD CHANNEL — SYSTEM / PROJECTION FAILURE
 * (settlement-gate-taxonomy spec, "The third channel: SYSTEM / PROJECTION
 * FAILURE"; ticket 05).
 *
 * A settlement surface can return three kinds of thing, and only two of them
 * are FINDINGS:
 *
 *   - a BLOCKING ERROR — "you have work to do", judged by the one rule in
 *     `note-settlement-finding-class.ts`;
 *   - a WARNING — "here is something to know", which blocks nothing;
 *   - and this: the check itself could not be performed, or its answer could
 *     not be delivered.
 *
 * The third one is NOT a finding, may never be demoted to a warning, and must
 * never be dressed up as a repairable list. The spec's own words: it "must fail
 * closed and operator-visible … the agent must never be handed a list that
 * pretends to be repairable". So a failure on this channel carries no findings,
 * no counts of findings, and no repair sentence — nothing the run can write
 * changes it, and telling it to try buys exactly the round trip this batch
 * exists to remove.
 *
 * THE FOUR CASES, and what is known about each:
 *
 *   1. `missing-production-provenance` — ticket 03 shipped this one's BEHAVIOUR
 *      as a plain string and recorded that ticket 05 owns the type. Reachable:
 *      a dispatch that carried no `SettlementScopeProvenance` cannot say which
 *      of its writable ids are its own window.
 *   2. `unconstructible-projection` — the scope descriptor disagrees with
 *      itself, so there is no set of turns the projection could be built over.
 *   3. `self-contradicting-evaluator` — the ONE evaluator both surfaces read
 *      returned a value that violates the filters it advertises. Its report and
 *      its verdict could not both be true.
 *   4. `over-protocol-result` — THE ONE WITH A MEASURED PRODUCTION FREQUENCY.
 *      35 occurrences in 7 days of real settlement runs (spec); re-measured on
 *      the settlement worker's own transcripts at 55 in the seven days to
 *      2026-08-31, split `lane_check` 24 / `commit` 18 / `recall` 10 (64 over
 *      the whole retained history). `lane_check` spills ran 59,077-138,759
 *      characters, `commit` 90,287-99,571. Today the harness silently saves the
 *      result to a file and instructs the agent to read all of it back — the
 *      paid round trip a truncated report always buys. It is a SYSTEM FAILURE:
 *      the part of a judgment that fits is not the part a verdict is reached
 *      on, and there is no honest way to page one.
 *
 * Cases 1-4 are checks on states this codebase does not know how to reach on
 * purpose EXCEPT case 4 — that is the point of a fail-closed channel, and it is
 * stated here rather than implied so a later reader does not read the other
 * three as measured hazards.
 */
export type SettlementSystemFailureCase =
  | "missing-production-provenance"
  | "unconstructible-projection"
  | "self-contradicting-evaluator"
  | "over-protocol-result";

/**
 * The TYPED result. `channel` is the discriminant a caller tests instead of
 * matching on prose — the whole reason ticket 03 left this to ticket 05 rather
 * than shipping the sentence alone.
 */
export interface SettlementSystemFailure {
  readonly channel: "system-failure";
  readonly case: SettlementSystemFailureCase;
  /**
   * ONE LINE, FOR THE OPERATOR. It rides the worker log and is never rendered
   * into the agent's result: the agent has nothing to do with it, and a
   * diagnostic in a fail-closed result reads as a repair hint.
   */
  readonly operatorDetail: string;
}

export function isSettlementSystemFailure(
  value: unknown,
): value is SettlementSystemFailure {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { channel?: unknown }).channel === "system-failure"
  );
}

function systemFailure(
  failureCase: SettlementSystemFailureCase,
  operatorDetail: string,
): SettlementSystemFailure {
  return { channel: "system-failure", case: failureCase, operatorDetail };
}

// ---------------------------------------------------------------------------
// The four predicates. ONE per case, each answering exactly one question.
// ---------------------------------------------------------------------------

/**
 * CASE 1 — THE ONE PREDICATE for "is this dispatch's scope descriptor complete
 * enough to judge anybody" (ticket 03's `settlementScopeProvenanceFailure`,
 * now typed). Asked at the tool path, by every surface that would otherwise
 * produce a report or a verdict, and asked nowhere else.
 *
 * It is asked THERE rather than inside the evaluator on purpose, and that
 * decision is ticket 03's: the evaluator's own callers include direct-call test
 * seams that legitimately model no provenance
 * (`evaluateSettlementCommitGate(db, { writableTurnIds })`), and the rule is not
 * "the fallback disappears" but "the fallback must not reach the production tool
 * path".
 */
export function missingProductionProvenanceFailure(
  scopeProvenance: SettlementScopeProvenance | undefined,
): SettlementSystemFailure | null {
  return scopeProvenance === undefined
    ? systemFailure(
        "missing-production-provenance",
        "dispatch carried no SettlementScopeProvenance",
      )
    : null;
}

/**
 * CASE 2 — THE SCOPE DESCRIPTOR'S OWN POSTCONDITION, asked back.
 *
 * `resolveSettlementScopeProvenance` states it in its own doc comment: "every id
 * in `writableTurnIds` lands in EXACTLY one of the three sets, so their union is
 * `writableTurnIds` itself and no two of them overlap". When that is false there
 * is no set of turns the projection could be built over — the descriptor claims
 * the run is judged on turns it may not write, or leaves writable turns filed
 * under no provenance at all — so the projection is UNCONSTRUCTIBLE and the
 * surface must say so instead of projecting over one of the two disagreeing
 * answers.
 *
 * WHY THE CHECK IS WORTH ITS BYTES even though production builds both halves
 * from one source today: `installSettlementEdgesScope` selects
 * `writableTurnIds` and `scopeProvenance` with two INDEPENDENT `??` fallbacks
 * (frozen snapshot, else the dispatch's live computation). They agree only
 * because `readSettlementFrozenScope` happens to return both halves or neither.
 * That is a property of one function, not of the type, and this batch exists
 * because one question got two answers.
 */
export function unconstructibleProjectionFailure(
  writableTurnIds: ReadonlySet<number>,
  scopeProvenance: SettlementScopeProvenance,
): SettlementSystemFailure | null {
  let claimed = 0;
  let duplicated = 0;
  let outsideAuthority = 0;
  const seen = new Set<number>();
  for (const bucket of [
    scopeProvenance.window,
    scopeProvenance.baseLookback,
    scopeProvenance.closureOnly,
  ]) {
    for (const id of bucket) {
      claimed += 1;
      if (seen.has(id)) {
        duplicated += 1;
      }
      seen.add(id);
      if (!writableTurnIds.has(id)) {
        outsideAuthority += 1;
      }
    }
  }
  const unclaimed = [...writableTurnIds].filter((id) => !seen.has(id)).length;
  if (duplicated === 0 && outsideAuthority === 0 && unclaimed === 0) {
    return null;
  }
  return systemFailure(
    "unconstructible-projection",
    `scope descriptor disagrees with its writable set: ${writableTurnIds.size} writable id(s), ` +
      `${claimed} provenance entr(ies), ${duplicated} in more than one bucket, ` +
      `${outsideAuthority} outside the writable set, ${unclaimed} writable with no provenance`,
  );
}

/**
 * CASE 3 — THE SHARED EVALUATOR, ASKED TO AGREE WITH ITSELF.
 *
 * `evaluateWindowLanes` advertises exactly two filters over the errors it hands
 * to BOTH surfaces (ticket 03): the judgment predicate, and the actionable
 * projection against the writable set. Every error it returns must therefore
 * satisfy both. When one does not, the same value is simultaneously "a finding
 * this run is judged on" and "a finding this run is not judged on" — the
 * preview would print it and the verdict would not refuse over it, or the
 * reverse. That is not a finding of any class; it is the evaluator contradicting
 * itself, and neither surface may render anything computed from it.
 *
 * Structural inputs rather than the evaluator's own types, so this module stays
 * free of the SDK-query module (which imports the model client).
 */
export interface SettlementEvaluationSelfCheck {
  /** `evaluation.result.errors`' anchors, in order. */
  errorAnchorIds: readonly number[];
  /** The scope this evaluation claims to have been projected against. */
  writableTurnIds: ReadonlySet<number>;
  /** The evaluation's own carried-out judgment predicate. */
  judged: (turnId: number) => boolean;
}

export function selfContradictingEvaluatorFailure(
  check: SettlementEvaluationSelfCheck,
): SettlementSystemFailure | null {
  let unwritable = 0;
  let unjudged = 0;
  for (const anchorId of check.errorAnchorIds) {
    if (!check.writableTurnIds.has(anchorId)) {
      unwritable += 1;
    }
    if (!check.judged(anchorId)) {
      unjudged += 1;
    }
  }
  if (unwritable === 0 && unjudged === 0) {
    return null;
  }
  return systemFailure(
    "self-contradicting-evaluator",
    `evaluation returned ${check.errorAnchorIds.length} error(s) its own filters exclude: ` +
      `${unwritable} anchored outside the writable set, ${unjudged} outside the judgment set`,
  );
}

/**
 * CASE 4's CEILING — the protocol's own, not a budget of ours.
 *
 * Claude Code caps an MCP tool result at `DEFAULT_MAX_MCP_OUTPUT_TOKENS = 25000`
 * (`src/utils/mcpValidation.ts` in the Claude Code source: a cheap
 * `length / 4` pre-gate at half the cap, then a real token count against the
 * cap). Over it, `getLargeOutputInstructions`
 * (`src/utils/mcpOutputStorage.ts`) replaces the result with
 * "result (N characters across M lines) exceeds maximum allowed tokens. Output
 * has been saved to …" plus an instruction to read the whole file back.
 *
 * THE CAP IS A CONSTANT HERE, AND PROVABLY SO. It is overridable by the
 * `MAX_MCP_OUTPUT_TOKENS` environment variable — but the settlement session's
 * environment is built by `buildIsolatedEnv` (`src/mnemosyne/env.ts`), whose
 * allowlist does not carry that key, so the CLI this worker spawns always runs
 * on the default. Reading `process.env` here would let this guard drift away
 * from the cap the child actually enforces.
 */
export const SETTLEMENT_RESULT_TOKEN_CEILING = 25_000;

/**
 * CASE 4 — CAN THIS RESULT BE EXPRESSED INSIDE THE PROTOCOL?
 *
 * Priced with the REAL tokenizer (`shared/token-count.ts`, o200k_base), not
 * with `estimateTokens`. That is not a preference. Settlement results are dense
 * address lists (`S12/T2207`, `island@…: S12/T1000,S12/T1001,…`) that price near
 * 2.2 characters per token, so the four-characters-per-token estimator reads a
 * genuinely over-protocol result as comfortably inside the cap. Measured on
 * text shaped like the smallest real spill — a `lane_check` result of 59,077
 * characters across 851 lines, 2026-08-24, which the harness itself measured
 * over the cap: `estimateTokens` 15,176, `countTokens` 26,557. The estimator
 * would have passed it by 40%.
 *
 * WHAT THIS IS AND IS NOT. The harness's own decision is a real token count
 * from the model provider, which is not computable here; o200k_base is the
 * closest thing this repo ships. Calibrated against the whole observed
 * population it lands within a few percent of the harness's own boundary, so
 * the guard fires at very nearly the point the harness would have spilled —
 * but it is a proxy, and a result close to the line may fall either side of it.
 *
 * The length pre-gate is exact rather than heuristic: o200k_base emits at most
 * one token per character, so a text shorter than the ceiling cannot exceed it
 * and the ~200K-entry encoder is never touched for the ordinary small result.
 */
export function overProtocolResultFailure(
  text: string,
  ceilingTokens: number = SETTLEMENT_RESULT_TOKEN_CEILING,
): SettlementSystemFailure | null {
  if (text.length <= ceilingTokens) {
    return null;
  }
  const tokens = countTokens(text);
  if (tokens <= ceilingTokens) {
    return null;
  }
  return systemFailure(
    "over-protocol-result",
    `result is ${tokens} token(s) over a ceiling of ${ceilingTokens} ` +
      `(${text.length} characters across ${text.split("\n").length} lines)`,
  );
}

// ---------------------------------------------------------------------------
// The two exits: what the AGENT reads, and what the OPERATOR reads.
// ---------------------------------------------------------------------------

/** The one sentence every case shares — including the words a fail-closed result must NOT carry. */
const SYSTEM_FAILURE_TAIL =
  "No report and no verdict is available, and NOTHING was committed. This is not a finding " +
  "and there is no repair you can attempt: the run cannot proceed on this check until an " +
  "operator fixes the dispatch that produced it. It has been recorded in the worker log.";

function systemFailureCauseSentence(failure: SettlementSystemFailure): string {
  switch (failure.case) {
    case "missing-production-provenance":
      return (
        "this dispatch carried no scope provenance, so the projection this window would be " +
        "judged on cannot be constructed."
      );
    case "unconstructible-projection":
      return (
        "this dispatch's scope descriptor and its writable set do not describe the same turns, " +
        "so the projection this window would be judged on cannot be constructed."
      );
    case "self-contradicting-evaluator":
      return (
        "the evaluator both surfaces read returned findings its own filters exclude, so its " +
        "report and its verdict cannot both be true."
      );
    case "over-protocol-result":
      return (
        "this check's answer does not fit inside the tool protocol, and the part of it that " +
        "would fit is not the part a verdict is reached on."
      );
  }
}

/**
 * THE AGENT-FACING RENDER. One paragraph, no list, no counts of findings, no
 * verb. `operatorDetail` is deliberately absent: it names sizes and set
 * arithmetic, which is what a run would try to act on.
 */
export function renderSettlementSystemFailure(
  failure: SettlementSystemFailure,
): string {
  return `SYSTEM / PROJECTION FAILURE — ${systemFailureCauseSentence(failure)} ${SYSTEM_FAILURE_TAIL}`;
}

/** Which surface refused, and which dispatch it belonged to. */
export interface SettlementSystemFailureSite {
  surface: "lane_check" | "commit";
  jobId: number;
  claimGeneration: number;
}

export type SettlementSystemFailureSink = (
  failure: SettlementSystemFailure,
  site: SettlementSystemFailureSite,
) => void;

const settlementLogger = createLogger("MNEMOSYNE");

/**
 * THE OPERATOR PATH, and the reason this channel is not just a nicer string.
 *
 * A settlement run's own transcript is not an operator surface: it lives under
 * the SDK child's session file, it is read by nobody unless someone already
 * suspects a problem, and the four cases here are exactly the ones nobody
 * suspects. `createLogger("MNEMOSYNE")` appends to `~/.claude-mnemo/
 * claude-mnemo.log` — the worker log — and the settlement child inherits the
 * same path, so a failure raised inside the child lands in the operator's one
 * file beside the worker's own lines.
 */
export const logSettlementSystemFailure: SettlementSystemFailureSink = (
  failure,
  site,
) => {
  settlementLogger.error("settlement system / projection failure", {
    case: failure.case,
    surface: site.surface,
    jobId: site.jobId,
    claimGeneration: site.claimGeneration,
    detail: failure.operatorDetail,
  });
};

/**
 * The two test seams this channel exposes, threaded through both query builders
 * as ONE optional field rather than two loose options. Production supplies
 * neither.
 */
export interface SettlementSystemFailureOptions {
  /** Defaults to `logSettlementSystemFailure` — the worker log. */
  sink?: SettlementSystemFailureSink;
  /** Defaults to `SETTLEMENT_RESULT_TOKEN_CEILING`; a fixture lowers it to reach case 4 without a 100KB render. */
  resultTokenCeiling?: number;
}
