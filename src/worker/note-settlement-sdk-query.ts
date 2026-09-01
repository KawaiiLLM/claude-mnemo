import {
  createSdkMcpServer,
  query,
  tool,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { Database } from "bun:sqlite";
import { z } from "zod";

import {
  MAX_PAGE_BUDGET,
  MNEMO_TOOL_DESCRIPTIONS,
  timelineInputShape,
  workerRecallInputShape,
} from "../mcp/definitions";
import { createDatabaseBackedHandlers } from "../mcp/handlers";
import { claimWriterId, type SettlementProvenanceIndex } from "../db/write-gate";
import type { runWriteTransaction } from "../db/database";
import {
  getNoteSettlementJob,
  touchNoteSettlementJobLease,
  transitionNoteSettlementJobToEdges,
  type NoteSettlementStage,
  type NoteSettlementSupersessionIntent,
} from "../db/note-settlement";
import {
  buildSettlementWorklistRendering,
  collectSettlementHomelessRetractions,
  computeSettlementShapeNumbers,
  readSettlementFrozenScope,
  renderSettlementHomelessRetractions,
  renderSettlementShapeNumbers,
  type SettlementFrozenScope,
  type SettlementHomelessRetraction,
  type SettlementShapeNumbers,
} from "./note-settlement-shape-numbers";
import {
  installSettlementEdgesScope,
  type SettlementEdgesScope,
  type SettlementEdgesScopeHolder,
} from "./note-settlement-edges-scope";
import { buildIsolatedEnv } from "../mnemosyne/env";
import {
  anchorsInJudgment,
  loadLaneCheckScope,
  type LaneJudgmentWindow,
} from "../db/lane-checker-load";
import { loadBasisReachabilityClosure, closureAsPhaseConnectivityInput, selectLandingTurnIds } from "../db/basis-reachability-load";
import {
  computeLaneFractures,
  laneTouchSegmentTagKey,
  laneTouchTurnTagKey,
  type RunLaneTouches,
} from "../db/lane-disposition";
import { getTurnById } from "../db/turns";
import { RELATION_FIELD_ENTRIES, RETRACTION_FIELD_ENTRIES } from "../db/citations";
import { TASKLESS_TASK_SCOPE_ID } from "../db/homeless-record";
import {
  checkLanes,
  type LaneCheckerError,
  type LaneCheckerResult,
  type LaneCheckerTurnInput,
} from "../shared/lane-checker";
import {
  buildLaneAnchorAddresses,
  LANE_CHECK_WARNING_NOTICE,
  projectLaneCheckerResultByScope,
  renderLaneCheckerReportsPaged,
} from "../shared/lane-checker-render";
import {
  classifySettlementFinding,
  type SettlementFindingContext,
} from "./note-settlement-finding-class";
import { evaluatePhaseConnectivity, type PhaseConnectivityFinding } from "../shared/phase-connectivity";
import { parseTurnAddress } from "../mcp/note";
import { resolveClaudeCodeExecutablePath } from "./claude-executable";
import type { SettlementScopeProvenance } from "./note-settlement-context";
import type {
  NoteSettlementQuery,
  NoteSettlementQueryRequest,
  NoteSettlementQueryResult,
} from "./note-settlement-dispatch";
import {
  settlementMembershipWriteInputShape,
  settlementRememberInputShape,
  SETTLEMENT_IMPRESSION_ACTION,
  type SettlementMembershipWriteInput,
  type SettlementRememberInput,
} from "./note-settlement-membership-facade";
import {
  createSettlementDirectWriteEngine,
  type NoteSettlementCommitRecord,
  type SettlementImpressionVerdict,
  type SettlementTerminalGateVerdict,
} from "./note-settlement-direct-write";
import {
  createAttachedImpressionDebtClaimer,
  createSettlementImpressionMaintainer,
  ImpressionSettlementRefused,
  type SettlementImpressionMaintainerOptions,
} from "./note-settlement-impressions";
import {
  createResponseOriginRegistry,
  observeSdkAssistantMessage,
  resolveResponseOrigin,
  type ResponseOrigin,
  type ResponseOriginRegistry,
} from "./note-settlement-response-origin";
import { createSettlementStopHook } from "./note-settlement-stop-hook";
import {
  logSettlementSystemFailure,
  missingProductionProvenanceFailure,
  overProtocolResultFailure,
  renderSettlementSystemFailure,
  selfContradictingEvaluatorFailure,
  SETTLEMENT_RESULT_TOKEN_CEILING,
  unconstructibleProjectionFailure,
  type SettlementSystemFailure,
  type SettlementSystemFailureOptions,
} from "./note-settlement-system-failure";
import {
  settlementTurnWriteInputShape,
  type SettlementTurnFacadeContext,
  type SettlementTurnWriteInput,
} from "./note-settlement-turn-facade";
import {
  checkStageOneLaneTag,
  collectStageOneProjection,
  evaluateStageOneTransitionGate,
  homelessMemberFingerprint,
  resolveWritableTurn,
  STAGE_ONE_FINALIZE_INPUT_SHAPE,
  STAGE_ONE_SUMMARY_MAX_CHARS,
} from "./note-settlement-stage1";

/**
 * STAGE 2 — THE EDGE PASS (staged-settlement spec Rev 5, §Solution stage 2;
 * ticket 07). This module is the settlement subprocess as it now exists: the
 * run that follows the stage-1 transition, works the snapshots that transition
 * froze, and alone reaches the terminal commit.
 *
 * Four properties are this stage's whole identity, and each has its own
 * enforcement below rather than a sentence of teaching:
 *
 *   1. IT READS, IT DOES NOT DERIVE. `readSettlementFrozenScope` supplies the
 *      writable set, its provenance classes, the `(task, lane)` worklist, the
 *      removed-side debts and each lane's frozen members. When that snapshot
 *      exists it WINS over whatever the dispatch computed live, so no caller
 *      can widen this run past what stage 1 froze.
 *   2. ITS AUTHORITY IS PER PROVENANCE. A `removed-side-citer` holds relation
 *      writes only, and the terminal gate blocks it on E4/E6 but never on E3 —
 *      see `classifySettlementFinding`, the one rule.
 *   3. ITS COMMIT IS THE ONLY PUBLICATION. `done`, the cursor advance, the era
 *      grant and the final metrics are all here, in one CAS transaction, and
 *      the stage-1 transition deliberately writes none of them.
 *   4. ITS REPORT AUDITS ITS OWN PARTITION. The shape numbers are an
 *      independent snapshot-induced projection (`note-settlement-shape-
 *      numbers.ts`), never the live-widening checker membership.
 *
 * The historical spec references below (D9/D10, ticket 07 of the ORIGINAL
 * settlement batch) describe the same subprocess before it was split in two.
 *
 * The settlement subprocess (spec D9/D10, ticket 07).
 *
 * The worker hosts no model of its own, so every settlement is a spawned child
 * that exits when the window is decided — no resident session, no resume
 * pointer, no stall watchdog, which is the whole reason the previous extraction
 * architecture was retired.
 *
 * TAG-MANDATE TICKET 06 (spec "Settlement surface", ruling [S15069/T1452]):
 * the window's material no longer arrives in the prompt. `recall` is now the
 * agent's ONLY view of turn content and of existing edges, so the two read
 * tools stopped being a drill-down convenience and became the channel. That
 * promotion is why `recall` is registered below with an explicit reader
 * identity while `timeline` is not — see `SETTLEMENT_ALLOWED_TOOLS` and the
 * recall registration itself.
 */

/**
 * The child's whole tool surface. `recall` and `timeline` are LOAD-BEARING
 * members under pull, not conveniences: with the window rendering retired,
 * an allowlist that dropped `recall` would leave the agent unable to see a
 * single turn it is asked to settle (spec: "the settlement SDK agent's tool
 * allowlist verifiably includes recall"). Pinned by test at the real
 * `queryImpl` seam.
 */
export const SETTLEMENT_ALLOWED_TOOLS = [
  "mcp__mnemo__recall",
  "mcp__mnemo__timeline",
  "mcp__mnemo__note",
  // `mcp__mnemo__remember` LEFT THIS PASS WITH `justify` (settlement-gate-
  // taxonomy ticket 06) AND CAME BACK WITH ONE ACTION (lane-impressions ticket
  // 10). Ticket 06's reasoning was that a tool whose every input is a refusal
  // is a token cost and an invitation to spend a round trip discovering it —
  // stage 2 could reach nothing on the lane registry, which is stage 1's and
  // frozen by the transition. That is still true of the registry. What is new
  // is that the edge pass now has container state of its own to write: the
  // IMPRESSION, which used to ride the terminal gate as an array argument and
  // whose one malformed entry refused the whole commit. `remember` is here for
  // that one action and refuses the registry verbs by name.
  "mcp__mnemo__remember",
  "mcp__mnemo__commit",
  "mcp__mnemo__lane_check",
] as const;

/**
 * WHAT STAGE 2'S `note` MAY CARRY, BY ALLOWLIST (re-review round, finding 1).
 *
 * The prompt has told this pass since ticket 07 that notes, types and tags are
 * stage 1's settled judgment; the tool did not enforce it. The shape is shared
 * with stage 1's registration, so a stage-2 call could still land `title`,
 * `content`, `type` and — the one that actually breaks something — `tags`.
 *
 * A `tags` write IS a membership write: `note-settlement-turn-facade.ts`'s
 * landed-update block hands it to `updateTurnById`, which re-derives
 * `segment_members` (`db/turns.ts` `deriveTurnSegmentMembership`). Stage 2's
 * whole authority is a SNAPSHOT — the frozen worklist, the frozen member
 * lists, the shape receipt counted at the transition. A stage-2 write of a
 * perfectly legal other-lane tag moves live membership underneath all three,
 * leaving them describing a partition that no longer exists, and the terminal
 * gates read the moved rows and can still pass. Nothing downstream notices.
 *
 * ALLOWLIST, not a denylist like stage 1's mirror-image guard: stage 1 refuses
 * a closed, derived set (the edges) out of an open one, while stage 2's legal
 * set is the closed one, so default-deny is what keeps a field added to
 * `settlementTurnWriteInputShape` tomorrow from silently reaching this pass.
 * The relation/retraction halves are derived from `db/citations.ts`'s two
 * entry lists — the same single source stage 1's guard reads — so the two
 * surfaces cannot disagree about which fields are "the edges".
 */
const STAGE_TWO_TURN_NOTE_FIELDS: ReadonlySet<string> = new Set([
  "turn",
  ...RELATION_FIELD_ENTRIES.map(([key]) => key),
  ...RETRACTION_FIELD_ENTRIES.map(([key]) => key),
]);

/**
 * The SESSION-addressed branch of the same tool, which is not a turn write at
 * all: `evaluateSettlementTurnWrite` splits on the address and this branch
 * writes the session's own narrative — explicitly stage 2's, per the prompt's
 * authority paragraph ("plus this session's own narrative") and the commit
 * receipt's `sessionNarrativeWritten` counter. Prose here touches no turn
 * field, no tag and no membership, so none of the reasoning above reaches it.
 */
const STAGE_TWO_SESSION_NOTE_FIELDS: ReadonlySet<string> = new Set([
  "session",
  "mode",
  "title",
  "content",
]);

/**
 * The settlement write facade's own description, separate from
 * `MNEMO_TOOL_DESCRIPTIONS.note` (mcp/definitions.ts) because the CALL
 * CONTRACT differs in three narrow ways: no `skip`, no `crossSession`, the
 * session address the main tool no longer has (ticket 09), and a write scope
 * this dispatch alone defines (the rendered window). Ticket 04
 * (edge-mechanism-revision D6) removed the two differences that used to
 * dominate this text — turn prose is settlement's again, and an edge no longer
 * needs a pre-existing pair. The MODE vocabulary is NOT part of that
 * difference any more (ticket 07, spec D12): `write`/`edit` mean here exactly
 * what they mean on the main agent's own `note`, out of the same engine
 * (`mcp/field-mode.ts`), so this text describes them in the same words rather
 * than describing settlement as the surface that lacks them.
 * The duty-level instructions (which turns are reviewable) live in the
 * settlement prompt, not here — this text states the CALL contract only.
 *
 * LANE-DECLARATION TICKET 02: the edge paragraph teaches the CURRENT gate.
 * All seven words take either entry form and NONE requires a tag ([T1548]/
 * [T1562]) — the mandate that made `extends`/`narrows` tagged-only is
 * withdrawn, and lane tags are settlement's own instrument rather than a
 * shape the main agent owes. What the paragraph must still teach is what the
 * gate still refuses, which is now DECLARATION rather than word choice: a
 * tagged edge names a lane declared in the segment of BOTH endpoints, a self
 * edge never carries a tag, and two rows for one (pair, relation) may not
 * share a tag. LANE-MODEL V12 TICKET 02 removed the last word-level refusal
 * this paragraph could still have taught: phase pairing and the evidence-type
 * condition on `verifies` are gone, and `refutes` merged into `override`.
 * TICKET 03 then removed the two frozen-legacy retraction mirrors with the
 * rows they addressed. The three-way split survives — ASSERTION, the
 * RELATIONS READ an edge write consumes (finding P1-8's gate), and
 * RETRACTION, which keeps the bare form because a legacy untagged row must
 * stay deletable. A stale teacher produces a call the gate
 * then rejects, and the rejection reads as a bug rather than a rule; this
 * file is in the enumerated surface set that pins against exactly that.
 *
 * Ticket 05 (read-write-contract spec "结算(直写改造)"): DIRECT WRITE, not
 * staged — this call validates fully right now AND lands, in this same
 * transaction, before the tool result returns. There is no `commit` left to
 * wait for a write's own durability; `commit` is repurposed by ticket 06 to
 * claim validity + a run summary + the job's terminal mark (see its own
 * description below).
 *
 * STAGED-SETTLEMENT TICKET 17 (round-3 peer finding P1-3): the text now teaches
 * the ALLOWLIST the registration below actually enforces. It had gone stale in
 * the one direction that costs a run its call: it still promised
 * `title`/`content`/`insight`, `type`/`tags` and a `mode` vocabulary on a turn
 * address, all of which `STAGE_TWO_TURN_NOTE_FIELDS` has refused since the
 * re-review round. A description that offers a parameter the handler rejects
 * spends a model turn on a rejection that reads as a bug, and the enumerated
 * teaching-surface set exists to stop exactly that. Turn-addressed is the
 * fourteen edge fields; session-addressed is the narrative, where `mode` and
 * `title`/`content` are real.
 */
export const SETTLEMENT_NOTE_TOOL_DESCRIPTION =
  "WRITE a turn's EDGES, OR this " +
  "session's narrative — lands immediately, in this same call. Hindsight " +
  "work: supply what is missing, correct what is wrong, retract what is " +
  "false, judged by the Memory Rubric in the prompt. " +
  "Exactly one of `turn` (\"S<session>/T<prompt>\", from the writable set " +
  "this prompt declares) or `session` (\"S<session>\", this session). " +
  "On `turn` the only parameters this pass may carry are THE FOURTEEN EDGE " +
  "FIELDS — the seven relations and their seven retract… mirrors, enumerated " +
  "below — for a turn in that writable set; omit to leave alone. " +
  "`title`, `content`, `insight`, `type`, `tags` and `mode` are REFUSED on a " +
  "turn address and the whole call writes nothing when one appears. A turn's " +
  "prose and type are the first pass's judgment and it is settled; `tags` is " +
  "worse than settled — it is a MEMBERSHIP write, and it would move turns " +
  "between lanes underneath the frozen worklist, member lists and shape " +
  "receipt this pass is reading. So there is no first-note rule here, and no " +
  "`mode` vocabulary on a turn: an edge is DECLARED or RETRACTED, never " +
  "replaced in place. " +
  // TICKET 19, finding 2: this used to promise a PER-FIELD yield ("that ONE
  // field yields while the others still land"), which the facade does not
  // have and never had. The edge fields share ONE write gate
  // (`EDGE_WRITE_GATE_FIELD`) plus one relation-SET gate, and either verdict
  // fails the WHOLE evaluation — the direct-write engine then rolls its
  // transaction back, so the call writes nothing at all. An agent taught the
  // old promise would read a rejection as "six of my seven fields landed" and
  // never resend them.
  "The edge fields are ONE SET and the call is ALL-OR-NOTHING: if another " +
  "writer (the main agent's own later note, or a prior settlement attempt) " +
  "moved this turn's relations since you read them, or you never read them, " +
  "the WHOLE call is refused and NOTHING is written — re-read the turn's " +
  "`relations` and send it again. No field yields on its own. " +
  "override/narrows/extends/indexes/consume/grounds/verifies: " +
  "address lists, and normally yours — the main agent's `note` carries the " +
  "same seven fields but is taught not to reach for them, so all but a few " +
  "edges are ones you wrote. ASSERTION takes " +
  "two entry forms and ALL SEVEN words accept either: a bare address leaves " +
  "both sides UNSETTLED (the draft an edge starts as), a " +
  "`{turn, tailTag, headTag}` entry places each END in a lane — `tailTag` the " +
  "lane this turn writes FROM, `headTag` the lane the cited turn sits in. " +
  "A DRAFT — either side left empty, or both — is ACCEPTED here, but it does " +
  "not survive `commit`: every edge inside your writable set with an empty " +
  "side is error E6, and commit refuses while one remains. Place both sides " +
  "before you finish, or retract the row. Each PLACED side is checked against " +
  "ITS " +
  "OWN endpoint, in this order: the tag must be canonical (lowercase letters, " +
  "digits and \"-\" only, never leading or trailing); the lane must already be DECLARED " +
  "(remember create) in the task THAT endpoint belongs to — an endpoint " +
  "carrying no task tag is refused naming the turn; and the tag must " +
  "already be on that endpoint turn's own tags. A lane's identity is (task, " +
  "tag), so the same word on both sides means ONE lane spanning the edge, two " +
  "different words is a legal CROSSING, and the same word in two different " +
  "tasks is a crossing too — two lanes that merely share a name. " +
  "An edge stands on its own: no prose citation, no " +
  "pre-existing link between the two turns, and one pair may carry several " +
  "relations at once; a structurally illegal call (an undeclared lane, a " +
  "self-citation) is rejected, naming what is missing — the WORD " +
  "itself is never refused, no relation requires a particular `type` on " +
  "either end, and a SELF edge is refused outright whatever its lanes. " +
  "Writing an edge also needs THIS run's own current read of the citing " +
  "turn's relations — a relation write states how that turn's edges stand, " +
  "so recall the turn with `filter={fields:[\"relations\"]}` first (Step 0's " +
  "own field list already delivers it) or the call is refused naming that " +
  "read; your own edge writes keep the set current afterwards. " +
  "RETRACTION is the other half: each relation has a retract… mirror " +
  "(retractOverride …), same two entry forms. A bare entry deletes the " +
  "UNSETTLED row and a two-sided one deletes exactly that lane placement; an " +
  "address carrying no such edge rejects the call, naming it, and nothing is " +
  "deleted. " +
  "Which relation, if any, is the Memory Rubric's own " +
  "vocabulary above — this call only enforces lane legality and the " +
  "self-citation gate. " +
  "On `session`: `title`/`content` only — type/tags/edges are refused. " +
  "A field that already holds something needs `mode.<field>`: \"write\" " +
  "replaces it whole (supply the finished text), or the edit form " +
  "`{ mode: \"edit\", oldString, newString }` swaps one exactly-matched span " +
  "inside it (`oldString` must match exactly once; add to the end by " +
  "anchoring on the current last line and putting that line plus your new " +
  "text in `newString`). With the edit form the field's own value is not " +
  "also supplied — the new text belongs in `newString`. A whole-field " +
  "`write` over text your own `recall` delivered only truncated is refused, " +
  "and the edit form is the way through.";

/**
 * SETTLEMENT-GATE-TAXONOMY TICKET 06: `SETTLEMENT_REMEMBER_TOOL_DESCRIPTION`
 * STOOD HERE, and the tool it described is gone from this pass with it.
 *
 * The lane registry belongs to stage 1 — the pass whose whole job is judging
 * the window's topic lines — and the transition FROZE the partition stage 2
 * reads, so `create`/`delete`/`merge` were already refused here. That left
 * `justify` as the tool's one action, and `justify` retired under user ruling
 * S15069/T2278 once ticket 04 made a severed fracture a warning: there is no
 * gate left for a disposition to discharge. A tool registered with nothing it
 * will accept teaches a caller that something is available and charges a round
 * trip for the discovery that it is not.
 */

/**
 * rubric-v10 ticket 06 (spec "settlement agent (v2 duty)"): the four-report
 * lane checker, wired through the SAME `shared/lane-checker.ts` core the CLI
 * renders (`scripts/lane-check.ts`) — no digraph, and the scope is always
 * this dispatch's own IMMUTABLE WRITABLE SET (`request.writableTurnIds`,
 * peer round T1466 finding P1-1 — formerly the job's prompt-number range,
 * which is strictly narrower), never a scope the model could name itself, so
 * there is nothing for it to get wrong there. Advisory only (spec: "findings
 * enter the agent's EXISTING supply/correct/propose judgment... never an
 * automatic write obligation") — this tool computes and reports, it never
 * writes.
 *
 * SETTLEMENT-ERGONOMICS TICKET 05 (spec D3 items 1/2/4): the tool gains its
 * FIRST two parameters, `page`/`pageBudget` — the scope above (this dispatch's
 * IMMUTABLE WRITABLE SET) is still fixed, only how much of ITS OWN render
 * reaches the agent in one call is bounded. `renderLaneCheckerReportsPaged`
 * (`shared/lane-checker-render.ts`) is the render this tool returns; see its
 * own module doc for the scope-then-aggregate-then-page mechanism. Before
 * this ticket the render was a single uncapped string and a real run's
 * default call returned 128,100 characters — over the worker's own
 * tool-result cap — so the agent got an error instead of a report and that
 * run had no checker at all despite calling this tool.
 *
 * SETTLEMENT-ERGONOMICS TICKET 06 (spec D3 item 3) added a THIRD parameter,
 * `scope` (`"actionable"` | `"all"`); SETTLEMENT-GATE-TAXONOMY TICKET 03
 * DELETED IT. There is one projection — this dispatch's own writable set,
 * applied at the evaluator seam (`evaluateWindowLanes`) to the value BOTH
 * halves of this tool's result are built from — and no parameter that could
 * ask for a second one. A widening the LANE DISPOSITION block below the report
 * could not follow was a divergence with a tool argument attached to it; a
 * widening the commit gate does not honour is a preview of a verdict nobody
 * will reach. See `projectLaneCheckerResultByScope`'s own doc for the
 * per-family predicate.
 *
 * A dispatch that carries NO `scopeProvenance` gets no report at all — the
 * system-failure channel, `judgeSettlementWindow`'s first question. It used to
 * make `"actionable"` behave like `"all"`, i.e. fall open to the whole
 * projection.
 */
const SETTLEMENT_LANE_CHECK_TOOL_SHAPE = {
  page: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "1-based; default 1. Every page RE-RUNS the check, so a page reflects the state at the moment " +
        "you ask — a row you have repaired since page 1 is gone from page 2, and page boundaries can " +
        "shift. Page through without writing in between when you want one consistent list.",
    ),
  pageBudget: z
    .number()
    .int()
    .positive()
    // Peer round three finding 02: this was positive-only, so `1_000_000` was
    // accepted — and this tool returns its render DIRECTLY, without the
    // worker's capped envelope, so the oversized result reached the host. The
    // same ceiling every public read surface takes, from the same transport
    // limit. (The other half of that finding — one indivisible block larger
    // than any budget — is still open: splitting a block or truncating one is
    // a contract call, see .scratch/peer-round-three/spec.md.)
    .max(MAX_PAGE_BUDGET)
    .optional()
    .describe(
      "Token ceiling per page, same name and meaning as `recall`'s own `pageBudget`. Overflow rolls to another page; a block (one lane's stats, one error instance, one folded summary line) is never truncated.",
    ),
  // NO `scope` (settlement-gate-taxonomy ticket 03) — see the doc comment
  // above. One projection, no widening to ask for.
};

export const SETTLEMENT_LANE_CHECK_TOOL_DESCRIPTION =
  "Run the lane checker over THIS window's own writable set and " +
  "return its findings as compact numbers and names — never a digraph, " +
  "never a write. Paged (`page`, `pageBudget` — same name and meaning as " +
  "`recall`'s own): overflow rolls to another page, never truncates a block, " +
  "and every page beyond the first ends stating how many remain and the " +
  "exact call for the next one; every page re-runs the check, so it shows " +
  "the state at the moment you ask rather than a frozen first-page snapshot. " +
  "Scoped to your own writable set, always and with no way to widen it: a " +
  "finding you could not act on is a finding `commit` will not judge you on " +
  "either. Two " +
  "WARNING families whose instances all repeat the same shape — time-order " +
  "violations and cross-task tagged edges — fold into one count-plus-" +
  "sample-addresses line each; every other report keeps one entry per block. " +
  "The output splits in two. ERRORS come first: states the " +
  "grammar forbids, each naming the turn it is ANCHORED at — an empty or " +
  "out-of-vocabulary turn type (E3), an edge whose side tag is missing " +
  "from that side's own endpoint turn (E4), and a DRAFT edge with either side " +
  "still empty (E6), which names the side that is missing. A draft is a legal " +
  "row to WRITE — placing an end is hindsight work — but it is not a legal row " +
  "to LEAVE, and settling it is exactly your work. " +
  "Commit refuses " +
  "while an EDGE error (E4, E6) anchored inside your writable range remains, " +
  "so repair those (retag, retract and re-add) and re-run. An error " +
  "anchored OUTSIDE your range is another window's work — leave it. " +
  "THE ERRORS BLOCK IS EXACTLY WHAT THE GATE REFUSES OVER — one rule builds " +
  "both, so this preview can neither hide a row commit will refuse nor show " +
  "you one it will not. An E3 (a turn's empty or out-of-vocabulary type) is " +
  "NOT in it: setting a turn's `type` is a note field no edge pass holds the " +
  "pen for, so it is printed below, under the warnings, as a finding this run " +
  "cannot repair. It is the first pass's debt, and a later window reaches it " +
  "through its own lookback. Do not chase it and do not try to retype a " +
  "turn to silence it; the call is refused. " +
  "Everything after the ERRORS block is WARNINGS: nothing under that header " +
  "blocks anything, so read them, act only where the material you already " +
  "hold supports it, and never spend a round trip on one. Report 1: " +
  "per-lane statistics (members, edge counts, who " +
  "cites a member from outside " +
  "— grounds, consume-class use, or testimony; a lane cited only by " +
  "consume is still ADOPTED, not unused). A lane has NO state: open/closed " +
  "and the single terminus they were computed from are gone. Its `coverage` " +
  "line says whether the members listed are the WHOLE lane or a slice of it, " +
  "with both counts — a slice is normal (your window is not the lane) and is " +
  "never something to repair, but a judgment made as if the slice were the " +
  "lane would be wrong. Report 2: " +
  "connectivity over each " +
  "lane's OWN edges — those whose two sides both name it; a provisional lane " +
  "(0-1 members) is not judged. A SEVERED lane this run touched is named " +
  "again at the very end, as a LANE DISPOSITION warning carrying the count " +
  "and each fracture's stitch target. It does NOT block `commit` and there is " +
  "nothing to file against it: write a stitch only where a truthful relation " +
  "is already supported by what you are reading, and leave an honest fracture " +
  "standing otherwise — a bridge invented to clear a line is worse than the " +
  "fracture. " +
  "Report 3: cross-lane coupling, each lane's " +
  "crossings counted in three groups, no threshold and no verdict. Report " +
  "4b: structural bypass candidates — a direct edge and a longer route " +
  "between the same two turns, both shown, neither marked for deletion, " +
  "because which to keep turns on what each contributes and this tool " +
  "cannot see that. Report 4c: time-order violations (an edge citing the " +
  "future). ATTRIBUTION, the warnings most often yours: an UNATTRIBUTED " +
  "CLUSTER is turns joined by edges with BOTH sides still empty — literally " +
  "your own settling queue, since membership is a NODE fact and an edge only " +
  "gets its two sides from you. Those same rows are ALSO listed one by one as " +
  "E6 above, on purpose and not as a double count: the cluster tells you the " +
  "SCALE of what is unattributed, E6 is the per-row list commit judges. " +
  "LANE PROLIFERATION is a task " +
  "declaring more lanes than max(1, 0.05 x its member turns). INDEX " +
  "GRANULARITY names a turn whose whole `indexes` batch is ONE node — an " +
  "index cites the batch that produced one phase result, so a single target " +
  "usually means a step got declared as a phase. It is a reading and never a " +
  "refusal: nothing blocks a single-target index, at write time or at commit. " +
  "All three name " +
  "their numbers, all three are debt or diagnosis rather than a defect: the repair is a " +
  "`create` plus settling both sides of an edge, fewer lanes, or a wider index batch — never a rewrite of the " +
  "turns. Treat a WARNING as a CANDIDATE for the same supply/correct/ " +
  "propose judgment every other duty above uses — never RE-RUN the check " +
  "more than once (reading a later `page` of the SAME run's findings is not " +
  "a re-run), and never let its output alone justify a write without the " +
  "usual Memory Rubric judgment.";

/**
 * Ticket 06 (spec "commit 重定位"): claim validity + a run summary + the job's
 * terminal mark — no separate `check` tool.
 *
 * Tag-mandate ticket 05 adds the GATE sentence. It belongs on the tool's own
 * description rather than only in the prompt for the same reason the lease
 * refusal does: the contract a call is judged by is the one fact a caller
 * must know at the moment of calling, and the description is the surface
 * carried into every retry.
 */
/**
 * The impression DUTY, carried on the tool DESCRIPTION as well as in the
 * prompt — the description is the surface a caller meets on every retry, so it
 * is where the mechanics belong. The writing LAW stays in the prompt
 * (`note-settlement-impression-teaching.ts`), the one channel this run is told
 * to trust.
 *
 * TICKET 10: this used to describe an `impressions` ARRAY ARGUMENT on this
 * call. The write is `remember`'s now; what `commit` describes is the check.
 */
/**
 * THE IMPRESSION WRITE, ON THE TOOL THAT OWNS CONTAINERS (lane-impressions
 * ticket 10, user ruling S15069/T2346). Shared byte-for-byte by both dispatch
 * shapes: the resume dispatch's `remember` has this action and nothing else,
 * and the unified run's has it after `finalize` and nothing else.
 */
export const SETTLEMENT_REMEMBER_IMPRESSION_DESCRIPTION =
  'Action "impression" WRITES ONE CONTAINER\'S DECISION about its impression, ' +
  "and it is the only way an impression is ever written. Takes `id` (the " +
  'container address exactly as your advisory printed it — "E<n>/#<tag>" for a ' +
  'lane, "E<n>" for the task tier), `baseRevision` (the revision that advisory ' +
  'printed for it), `decision` ("retain" or "replace") and, on a replace, ' +
  "`text` — the WHOLE new impression, never a patch. " +
  "CALL IT AS YOU DECIDE, one container at a time, not as one batch at the " +
  "end. The call VALIDATES IN FULL and refuses HERE: an over-cap line, a bare " +
  "anchor, a delivery word with no anchor on its line, a retain over a " +
  "container your own edges overrode or a merge left STALE — each is refused " +
  "with its violations named, and every decision you already recorded stands " +
  "untouched. Repair that one and call again. " +
  "A recorded decision is PENDING: nothing is written, no staleness is " +
  "cleared, and no debt is discharged until your own `commit` verifies the " +
  "whole set and promotes it. Deciding the same container twice keeps the " +
  "LAST decision.";

export const SETTLEMENT_COMMIT_IMPRESSION_DUTY_DESCRIPTION =
  "IMPRESSIONS ARE CHECKED HERE, NOT WRITTEN HERE. Every container this run " +
  "touched must already carry a decision, recorded one at a time with " +
  '`remember(action: "impression", …)` as you make it. This call verifies the ' +
  "duty inside its own transaction: a touched container with no decision " +
  "refuses the commit BY NAME, and so does a decision whose container moved " +
  "under it — its revision, or a lane's settled membership — in which case the " +
  "current coordinates are reprinted for you to read and decide again. " +
  "Nothing is written and no staleness is cleared until this call succeeds; " +
  "a refusal costs no attempt.";

/**
 * The RESUME dispatch's `remember`. One action wide, and the description says
 * so first: a run that reaches for the lane registry here is spending a round
 * trip to be refused, exactly the cost settlement-gate-taxonomy ticket 06
 * removed this tool to avoid.
 */
export const SETTLEMENT_REMEMBER_TOOL_DESCRIPTION =
  "MAINTAIN A CONTAINER'S IMPRESSION — the mental model a reader keeps after " +
  "the chronology is forgotten. This tool has exactly ONE action in the edge " +
  'pass: "impression". The lane registry — create, delete, merge — is the ' +
  "topic pass's own settled judgment, frozen by the transition you are " +
  "working, and every one of those actions is refused here, naming why. " +
  SETTLEMENT_REMEMBER_IMPRESSION_DESCRIPTION;

export const SETTLEMENT_COMMIT_TOOL_DESCRIPTION =
  "Finish this window: verify your job lease is still valid, report what " +
  "this run actually wrote, and mark the job durably complete. Call this " +
  "once you believe the window is done — whether or not you wrote " +
  "anything; every `note`/`remember` call already landed the instant it " +
  "ran, so an empty-handed `commit` (nothing to propose or correct) is a " +
  "normal, clean finish, not a no-op to avoid. This is the ONLY way the " +
  "job itself is marked done — without it, the window is retried later " +
  "even though your writes already stand. " +
  "Commit REFUSES while an EDGE state the grammar forbids still anchors on a " +
  "turn inside your writable set — " +
  "a tagged edge whose tags are missing from an endpoint turn's own tags " +
  "(E4), and a DRAFT edge with either side still empty (E6). " +
  "No WORD requires a lane tag — every relation has a legal bare form and " +
  "writing one is accepted — but an edge left with an empty side inside your " +
  "writable set is unfinished settlement, so place both sides or retract it. " +
  "The refusal lists every one with its address and the move " +
  "that clears it; repair them and call `commit` again — a refusal costs " +
  "you nothing and is not a failed attempt. Errors anchored OUTSIDE your " +
  "writable set are another window's work and never block you. " +
  // Staged settlement (spec Rev 5, §Per-provenance gate filter), widened to
  // every provenance by ticket 17: the divergence between what `lane_check`
  // prints as actionable and what this gate refuses over. Stated here because
  // the description is the surface carried into every retry.
  "ONE ERROR CLASS IS EXEMPT BY AUTHORITY rather than by location: an empty " +
  "or out-of-vocabulary turn type (E3) NEVER blocks this commit, on any turn " +
  "in your set — not a removed-side citer's, not a window member's. Its " +
  "repair is that turn's `type`, and no edge pass holds that pen (your `note` " +
  "refuses the field). It is the first pass's debt; a later window meets it " +
  "again through its own lookback, and the first pass's own transition gate " +
  "is what normally stops one reaching you at all. `lane_check` prints it " +
  "under the WARNINGS, which is the same class this gate gives it — the two " +
  "surfaces run one rule. " +
  "A SEVERED LANE NEVER REFUSES THIS COMMIT. A lane this run touched that is " +
  "left in two or more pieces rides the SUCCESSFUL receipt as a warning with " +
  "its count and its stitch target, and there is nothing you owe for it: no " +
  "disposition to file, no retry, no delay. Connectivity is a quality goal, " +
  "not a legal " +
  "state, and two writable endpoints do not mean any of the seven relation " +
  "words is true between them. " +
  // Staged settlement (spec Rev 5, §Shape numbers v1): what a SUCCESSFUL
  // commit hands back, so the run knows the numbers exist and are not
  // something it must compute or restate itself.
  "A successful commit also returns this window's SHAPE NUMBERS — per " +
  "worklist lane, its frozen member count and weak-component count; per lane " +
  "pair, the crossings grouped by relation word — plus every " +
  "homeless-motivated retraction with its cause. They are an audit of the " +
  "partition, never an instruction, and there is nothing to do about them. " +
  "If your job lease has been " +
  "reclaimed, commit refuses and no further commit from this run will " +
  "ever succeed — stop making tool calls. " +
  // Settlement-commit-report ticket 01: the contract for `report` lives
  // HERE, not only in the prompt — this description is the surface carried
  // into every retry, so it is where a caller learns what it is judged by.
  "Also takes `report` (string, REQUIRED, max 1000 characters — refused " +
  "if absent, empty, whitespace-only, or over the cap; never truncated): " +
  "this window's FRICTION, not its work — never a restatement of the " +
  "counts this same call already reports exactly. Name whichever of these " +
  "actually applied: where this window forced a guess; a relation you " +
  "wanted and the seven words could not express; a commit-gate refusal " +
  "(E4/E6) you had to route around; a turn you could not read, and " +
  "why. A refusal — gate or parameter — never stashes `report`; resend it " +
  "on your retry. " +
  SETTLEMENT_COMMIT_IMPRESSION_DUTY_DESCRIPTION;

/**
 * `commit`'s own input shape, both run shapes. ONE field: the report.
 *
 * The `impressions` array RETIRED here (lane-impressions ticket 10). A caller
 * that still sends one is refused by name — see `retiredImpressionsArgument`
 * below, which follows `mcp/remember.ts`'s own precedent for a retired input:
 * the schema stops accepting it, and the hand-rolled path that bypasses schema
 * validation gets a message naming its replacement rather than a generic error.
 */
export const SETTLEMENT_COMMIT_INPUT_SHAPE = {
  report: z.string(),
};

/**
 * THE RETIRED ARGUMENT'S OWN REFUSAL (lane-impressions ticket 10). Returned
 * before anything else this call would do, because a caller sending the array
 * has composed its whole judgment in the wrong place and needs to be told
 * where the judgment goes, not what else was wrong with the call.
 */
export function retiredImpressionsArgument(args: unknown): string | null {
  if (
    typeof args !== "object" ||
    args === null ||
    (args as Record<string, unknown>).impressions === undefined
  ) {
    return null;
  }
  return (
    "Parameter error: `impressions` has retired from `commit` — an impression is written " +
    'one container at a time with `remember(action: "impression", id, baseRevision, ' +
    'decision, text?)`, as you decide it, and `commit` only checks that every container ' +
    "you touched carries a decision. Nothing was committed; record your decisions and " +
    "call `commit` again."
  );
}

/**
 * The impression obligation, wired to ONE run: the maintainer that remembers
 * what this run has been SHOWN, plus the `settleImpressions` seam the write
 * engine calls inside its terminal transaction.
 *
 * Both query builders below use this same helper — the unified run and the
 * resume dispatch reach the same terminal commit carrying the same obligation,
 * and a second hand-rolled wiring is how the two would come to disagree about
 * what a refusal means.
 */
function wireSettlementImpressions(options: SettlementImpressionMaintainerOptions) {
  const maintainer = createSettlementImpressionMaintainer(options);
  let refused = false;
  return {
    maintainer,
    /** Set for the duration of one `commit` call; the reporting layer reads it to know a refusal rolled the transaction back. */
    wasRefused: () => refused,
    clearRefused: () => {
      refused = false;
    },
    settleImpressions: (db: Database): SettlementImpressionVerdict => {
      try {
        maintainer.settle(db);
        return { ok: true };
      } catch (error) {
        if (error instanceof ImpressionSettlementRefused) {
          refused = true;
          return { ok: false, refusal: error.message };
        }
        throw error;
      }
    },
  };
}

export interface CreateNoteSettlementSdkQueryOptions {
  db: Database;
  dataRoot: string;
  defaultProject?: string;
  queryImpl?: typeof query;
  createSdkMcpServerImpl?: typeof createSdkMcpServer;
  toolImpl?: typeof tool;
  /** Environment snapshot for the child; defaults to the sanitized baseline. */
  agentEnv?: NodeJS.ProcessEnv;
  /** Epoch seconds at the moment of each individual tool write; injectable for tests. */
  now?: () => number;
  /**
   * Test seam only, handed straight to the direct-write engine — see that
   * option's own doc comment, which this one exists to make reachable one
   * layer up. It is the only way to interleave a competing write around the
   * TERMINAL transaction, which is what proves the commit report's shape
   * numbers are captured inside it (final review, finding 9) rather than read
   * back afterwards off a table a later writer may already have moved.
   */
  runWriteTransaction?: typeof runWriteTransaction;
  /**
   * Test seam only (settlement-execution-repair ticket 01). Production
   * never sets this — see `note-settlement-stage1.ts`'s identical option for
   * why: a fresh registry per dispatch is the whole cross-generation
   * guarantee it owes, so overriding it is only ever a test's way of
   * observing the host loop's own coordinator calls.
   */
  originRegistry?: ResponseOriginRegistry;
  /** THE CLAIMED-SET SEAM (lane-impressions ticket 02) — see the unified builder's identical option. */
  claimImpressionDebts?: SettlementImpressionMaintainerOptions["claimImpressionDebts"];
  /** THE THIRD CHANNEL's two test seams (settlement-gate-taxonomy ticket 05) — see `SettlementSystemFailureOptions`. Production supplies neither. */
  systemFailure?: SettlementSystemFailureOptions;
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

/**
 * THE LANE REGISTRY IS CLOSED IN THE EDGE PASS (settlement-gate-taxonomy ticket
 * 06's finding, restated where lane-impressions ticket 10 put a tool back).
 * Unconditional rather than a denylist, so a registry action added tomorrow
 * cannot leak into this pass by omission.
 */
export function settlementRegistryClosedRefusal(action: unknown): string {
  return (
    `Parameter error: ${typeof action === "string" && action !== "" ? action : "this call"} ` +
    "is refused in the edge pass — the lane registry is the topic pass's own settled " +
    "judgment, frozen by the transition you are working, and a lane that looks wrong to you " +
    "is a later, explicit, user-ruled merge, never a rewrite from here. A SEVERED lane owes " +
    "you nothing: it is a warning naming a stitch target, it blocks no commit, and there is " +
    'no disposition to file. This tool\'s one action here is "impression". Nothing was ' +
    "written."
  );
}

// ---------------------------------------------------------------------------
// The commit gate (tag-mandate ticket 05, spec "The commit gate")
// ---------------------------------------------------------------------------

/**
 * The scope both settlement checker callers judge — this dispatch's own
 * IMMUTABLE WRITABLE SET, nothing else.
 *
 * PEER ROUND T1466 (finding P1-1): this used to be the job's prompt-number
 * RANGE (`windowStart..windowEnd`), and the range was strictly SMALLER than
 * the set the gate then filtered anchors against. The writable set is window
 * ∪ declared lookback ∪ deadlock-guard closure — a lookback turn can sit
 * anywhere in the session, so no range expresses it. Errors living on those
 * turns never LOADED, and filtering a projection cannot recover what the
 * projection never contained: a lookback turn's
 * empty type (E3) was invisible, and so was an E2 whose out-of-vocabulary row
 * runs from a lookback turn to an endpoint nothing else pulled in. The frozen
 * set goes in verbatim now, through the loader's `{ kind: "turns", turnIds }`
 * seed.
 */
export interface SettlementProjectionScope {
  writableTurnIds: ReadonlySet<number>;
  /**
   * The SAME ids, each carrying the SET of provenance classes that put it
   * there — ticket 04's frozen `note_settlement_writable_turns` snapshot,
   * consumed read-only. Read by the ONE classification rule
   * (`worker/note-settlement-finding-class.ts`, condition 3) and by nothing
   * else here: the PROJECTION is unaffected, since what the loader loads has
   * never depended on why an id is writable.
   *
   * Optional, and absent means "every writable id carries full authority" —
   * the pre-staging behaviour, which is also the correct reading for a job that
   * never transitioned.
   */
  writableProvenance?: SettlementProvenanceIndex;
  /**
   * THE JUDGMENT WINDOW (settlement-gate-taxonomy ticket 02) — this job's own
   * session and window bounds, handed to `loadLaneCheckScope` so the three
   * roles are bound at the LOADER instead of filtered at the render.
   *
   * It is NOT a second writable set and never grants anything: authority stays
   * `writableTurnIds`' answer alone. What it decides is what may be JUDGED —
   * the window's prompt numbers plus the 50 preceding ones of the same session
   * — and how far each involved lane is materialised. A closure turn the
   * deadlock guard dragged in from another session, or from 90 prompts back, is
   * still writable and is still LOADED as evidence; its own older findings
   * simply stop blocking a window that did not produce them.
   *
   * Optional for the same reason `writableProvenance` is: a fixture or a
   * pre-ticket caller that models no window gets the undifferentiated
   * projection, which is the pre-ticket behaviour.
   */
  judgment?: LaneJudgmentWindow;
}

/**
 * THE ONE PLACE THE THIRD CHANNEL'S FIRST THREE CASES ARE ASKED
 * (settlement-gate-taxonomy ticket 05; the channel's type, its four cases and
 * its operator path live in `note-settlement-system-failure.ts`).
 *
 * Ticket 03 shipped case 1's BEHAVIOUR — a missing production provenance fails
 * closed on both surfaces rather than falling open to whole history — as a
 * plain string, and recorded that this ticket owns the type, the other cases
 * and the log path. What is added here is not a second fail-closed rule: it is
 * that rule, typed, plus the two other questions a surface must answer BEFORE
 * it renders anything.
 *
 * The three questions, in the only order that can be asked:
 *
 *   1. Is there a scope descriptor at all?  (case 1)
 *   2. Does that descriptor describe the same turns as this run's authority?
 *      (case 2 — an incoherent descriptor has no projection to build)
 *   3. Did the ONE evaluator both surfaces read return a value consistent with
 *      the filters it advertises?  (case 3)
 *
 * Every caller either gets an evaluation it may render from, or a failure it
 * must render INSTEAD. There is no third outcome and no partial one: the spec's
 * rule is that the agent "must never be handed a list that pretends to be
 * repairable", and an empty list is still a list.
 */
type SettlementWindowJudgment =
  | { ok: true; evaluation: SettlementLaneEvaluation }
  | { ok: false; failure: SettlementSystemFailure };

function judgeSettlementWindow(
  db: Database,
  scope: SettlementProjectionScope,
  scopeProvenance: SettlementScopeProvenance | undefined,
  authoredTurnIds: ReadonlySet<number>,
): SettlementWindowJudgment {
  const missingProvenance = missingProductionProvenanceFailure(scopeProvenance);
  if (missingProvenance !== null) {
    return { ok: false, failure: missingProvenance };
  }
  const incoherentScope = unconstructibleProjectionFailure(
    scope.writableTurnIds,
    scopeProvenance!,
  );
  if (incoherentScope !== null) {
    return { ok: false, failure: incoherentScope };
  }
  const evaluation = evaluateWindowLanes(db, scope, authoredTurnIds);
  const selfContradiction = selfContradictingEvaluatorFailure({
    errorAnchorIds: evaluation.result.errors.map((error) => error.anchorId),
    writableTurnIds: scope.writableTurnIds,
    judged: evaluation.judged,
  });
  if (selfContradiction !== null) {
    return { ok: false, failure: selfContradiction };
  }
  return { ok: true, evaluation };
}

/**
 * ONE EVALUATION, READ BY EVERY SURFACE THAT JUDGES THIS RUN
 * (settlement-gate-taxonomy ticket 03).
 *
 * A `lane_check` call and a `commit` call each produce exactly one of these,
 * and every finding either of them prints is a RENDERING of this value:
 *
 *   - `lane_check` page 1 renders `result` through
 *     `renderLaneCheckerReportsPaged` AND appends the LANE DISPOSITION block
 *     computed from the SAME `result`. Those are the two halves ticket 01
 *     found disagreeing inside one call — the render was scope-projected, the
 *     disposition block re-ran the whole gate unprojected, and one tool result
 *     said "this lane is fine" above "this lane owes a disposition".
 *   - `commit` recomputes — a FRESH evaluation, inside the terminal
 *     transaction — and renders its two refusals from that one value. Not a
 *     shared snapshot: the spec rejects one explicitly, because the run's own
 *     writes between the preview and the commit make a snapshot stale and
 *     revisioning the whole graph to fix that is a bigger machine than the
 *     problem. One DEFINITION, two evaluations.
 */
interface SettlementLaneEvaluation {
  /** Judgment-anchored AND scope-projected. Nothing downstream filters it again. */
  result: LaneCheckerResult;
  /** The projection's own turns, so an anchor can be spelled as an `S<n>/T<m>` address. */
  turns: LaneCheckerTurnInput[];
  /**
   * THIS RUN'S JUDGMENT PREDICATE (ticket 04), carried out so the classifier
   * asks the SAME closure that decided what entered `result` — one definition,
   * two askers, exactly as ticket 03 arranged for the projection itself. A
   * second membership test built from the same inputs is how a preview and a
   * verdict come apart.
   */
  judged: (turnId: number) => boolean;
}

/**
 * ONE projection, one semantics: the `lane_check` tool and the commit gate
 * run the IDENTICAL `loadLaneCheckScope` -> `checkLanes` pass over the job's
 * own WRITABLE SET (spec's implementation decision: "the same
 * loadLaneCheckScope→checkLanes pass the lane_check tool uses — one
 * projection, no second semantics"). Two callers of one function, so the
 * cheap look the agent may take before committing and the verdict it is
 * judged by can never disagree about a fact.
 *
 * The seed is the SAME value three other readers already hold — the write
 * facade's range check, the commit gate's anchor filter and the prompt's
 * printed declaration — so "what you may write", "what you are shown" and
 * "what you are judged on" are one set rather than three that happen to
 * overlap.
 *
 * THE TWO FILTERS, both applied HERE and nowhere else (ticket 03):
 *
 *   1. THE ANCHOR RULE (ticket 02, spec: "Errors and warnings may anchor only
 *      here"). An error sitting on an EVIDENCE-CLOSURE turn (a cross-session
 *      closure endpoint, a lookback turn 90 prompts back) is a fact about
 *      somebody else's window; it is loaded because the graph needs it to be
 *      explicable and it is reported by nobody. `anchorsInJudgment` is that one
 *      predicate; with no judgment window declared every loaded turn is an
 *      anchor, so this filter is the identity and a caller that models no
 *      window is untouched.
 *   2. THE ACTIONABLE PROJECTION (`projectLaneCheckerResultByScope`), against
 *      this dispatch's WRITABLE SET — "actionable IS the writable set", user
 *      ruling [S15069/T1778]. It used to run inside
 *      `renderLaneCheckerReportsPaged`, which is only ONE of the consumers of
 *      this result; the LANE DISPOSITION block and the commit gate read the
 *      unprojected value and could therefore demand a repair for a lane the
 *      same tool result had just declined to describe.
 *
 * TICKET 04 CLOSES THE HOLE TICKET 02 OPENED, inside filter 1. A writable turn
 * OUTSIDE the judgment set — a deadlock-guard closure endpoint, a citer 90
 * prompts back — is still writable, so a run could DIRTY it (mint a draft edge,
 * orphan a side tag) and commit clean, because its own new finding anchored
 * where nothing may be judged. The fix is authorship, not authority:
 *
 *   - **Authority is NOT intersected with the judgment set**, and that is the
 *     reading a reader will assume, so it is named. Those turns are writable
 *     for one reason: this job's own stage-1 projection made their edges stale
 *     and the citing turn is the ONLY turn that can repair them. Narrowing
 *     authority to the judgment window would reinstate exactly the deadlock the
 *     closure exists to break, and the spec's judgment window is explicit that
 *     it "never grants anything" — it decides what may be JUDGED, not what may
 *     be written.
 *   - **Writing at a turn re-admits it as an anchor, whatever the distance.**
 *     The judgment set exists so a run is not judged on somebody else's debt; a
 *     finding sitting where this run just wrote is not somebody else's debt at
 *     any distance. And it can never deadlock: whatever the run wrote, it can
 *     retract, so condition 3 of the classification rule holds by construction.
 *
 * `authoredTurnIds` is the durable touch ledger's own answer
 * (`RunLaneTouches.turnIds`), so it survives the attempt boundary — attempt A
 * dirties a closure turn and dies, attempt B is still judged on it.
 *
 * ITS LIMIT, stated because the other reading is available: this re-admits by
 * WHERE THE RUN WROTE, not by what the run CAUSED. A run that empties a tag on
 * an endpoint turn can orphan an E4 anchored at a citing turn it never wrote,
 * and that stays out of judgment. Answering "did this run cause this finding"
 * is debt-id scoping, which this gate has never done and does not start doing
 * here; "where did this run write" is bounded, durable and decidable.
 *
 * Everything downstream — the paged render, the disposition gate, the commit
 * refusal — consumes the value this returns and filters nothing further.
 */
function evaluateWindowLanes(
  db: Database,
  scope: SettlementProjectionScope,
  /** `RunLaneTouches.turnIds`. Omitted by the direct-call test seams, which model no run and therefore no authorship. */
  authoredTurnIds?: ReadonlySet<number>,
): SettlementLaneEvaluation {
  const projection = loadLaneCheckScope(db, {
    kind: "turns",
    turnIds: [...scope.writableTurnIds],
    ...(scope.judgment ? { judgment: scope.judgment } : {}),
  });
  // Ticket 09 (D9): the loader's own per-SEGMENT registry/membership counts
  // go straight through as the fourth argument — the proliferation warning
  // must never be inferred from this window's projection (peer P1-11).
  // Ticket 04 adds the fifth: each widened lane's WHOLE declared membership, so
  // report 1's coverage line can say that what it lists is a slice.
  const result = checkLanes(
    projection.turns,
    projection.edges,
    projection.outOfVocabularyEdges,
    projection.segmentFacts,
    projection.laneMemberTotals,
  );
  const judged = (turnId: number): boolean =>
    anchorsInJudgment(projection.roles, turnId) || authoredTurnIds?.has(turnId) === true;
  return {
    judged,
    result: projectLaneCheckerResultByScope(
      {
        ...result,
        errors: result.errors.filter((error) => judged(error.anchorId)),
      },
      scope.writableTurnIds,
    ),
    // Tag-mandate ticket 06: the projection's OWN turns, carried out so the
    // report can spell an anchor as an address. Returned from here rather
    // than re-loaded by the caller for the same reason the result is — one
    // projection, one set of facts, no chance of the addresses describing a
    // different load than the verdict.
    turns: projection.turns,
  };
}

/**
 * The checker addresses turns by `turns.id` (its `anchorId`); the AGENT can
 * only write through `S<session>/T<prompt>` addresses. The refusal payload is
 * a repair list, so it is rendered in the address vocabulary the repair calls
 * actually take — a row id the model cannot type into `note` would make the
 * list unactionable. Falls back to the raw id if the row vanished between the
 * check and this render (it cannot in practice: the checker only ever
 * anchors at a live turn it just loaded).
 */
function turnAddressFor(db: Database, turnId: number): string {
  const turn = getTurnById(db, turnId);
  return turn ? `S${turn.sessionId}/T${turn.promptNumber}` : `turn #${turnId}`;
}

// ---------------------------------------------------------------------------
// Phase connectivity (phase-connectivity ticket 01) — REPORT-ONLY, gate OFF
// ---------------------------------------------------------------------------

/**
 * THE GATE IS OFF, AND THERE IS NO SWITCH (phase-connectivity ticket 06,
 * decision 1). A prior revision of this file declared a boolean "armed"
 * constant here, written once and read nowhere, and ticket 01's own Status
 * called arming it "a one-line flip" — false: this whole evaluation runs
 * inside `commit`'s `appendReports`, which on the success path executes
 * AFTER `writes.commit()` has already landed the window's writes. A constant
 * read nowhere cannot refuse anything before that point regardless of its
 * value, so it was deleted rather than wired up. ARMING ACTUALLY NEEDS: the
 * refusal moved into the pre-commit gate sequence (after the E3/E4/E6 lane
 * checks and the lane-disposition gate, before `writes.commit()` is called),
 * evaluated against a single fenced read of the graph so a concurrent write
 * cannot let the gate and the commit disagree about what it saw (the
 * concurrency fence across the loader's own queries is real and out of scope
 * here too — ticket 06, decision 5). That is its own ticket with its own
 * dry-run, not a flip of anything that lives in this file today.
 */

/**
 * Ticket 01's whole predicate, run over one window: every LIVE landing turn
 * inside `windowTurnIds` (the run's TARGET WINDOW — prerequisite 2's
 * obligation anchor, never the wider writable set a lookback/closure would
 * drag in), walked by `db/basis-reachability-load.ts`'s fixpoint closure and
 * judged by `shared/phase-connectivity.ts`'s pure predicate. `[]` when the
 * window carries no landing turn at all.
 */
function checkPhaseConnectivity(
  db: Database,
  windowTurnIds: ReadonlySet<number>,
): PhaseConnectivityFinding[] {
  const landingIds = selectLandingTurnIds(db, [...windowTurnIds]);
  if (landingIds.length === 0) {
    return [];
  }
  const closure = loadBasisReachabilityClosure(db, landingIds);
  const { types, graph } = closureAsPhaseConnectivityInput(closure);
  return evaluatePhaseConnectivity(landingIds, types, graph);
}

/** One report-only block, appended to `lane_check`/`commit` output — `""` when the window has no landing turn to judge. */
function renderPhaseConnectivityReport(
  db: Database,
  findings: readonly PhaseConnectivityFinding[],
): string {
  if (findings.length === 0) {
    return "";
  }
  // "unreached" is an ESTABLISHED violation (the walk's frontier emptied on
  // its own); "unresolved-at-cap" (ticket 06, decision 2) is not — the walk
  // ran out of hop budget before it could establish anything, so it is
  // rendered as its own distinct line and excluded from this count.
  const violationCount = findings.filter((finding) => finding.outcome === "unreached").length;
  const unresolvedAtCapCount = findings.filter((finding) => finding.outcome === "unresolved-at-cap").length;
  const lines = findings.map((finding) => {
    const address = turnAddressFor(db, finding.turnId);
    if (finding.outcome === "compound") {
      return `  [OK] ${address} — compound (own type carries "${finding.basisWord}")`;
    }
    if (finding.outcome === "reached") {
      return (
        `  [OK] ${address} — reaches ${turnAddressFor(db, finding.basisTurnId!)} via a directed walk ` +
        `(${finding.hops} hop(s), basis "${finding.basisWord}")`
      );
    }
    if (finding.outcome === "unresolved-at-cap") {
      return (
        `  [UNKNOWN] ${address} — walk exhausted its hop cap before reaching a basis-type node or a ` +
        "dead end (not a violation)"
      );
    }
    return `  [VIOLATION] ${address} — no basis-type node reachable by directed out-edge walk`;
  });
  return [
    `PHASE CONNECTIVITY (ticket 01, REPORT-ONLY — gate not armed; ${violationCount}/${findings.length} ` +
      `landing turn(s) unreached${
        unresolvedAtCapCount > 0 ? `, ${unresolvedAtCapCount} unresolved-at-cap (excluded from that count)` : ""
      }):`,
    ...lines,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Lane disposition (severed-lane ticket 02) — SEVERED-FRACTURE WARNINGS
// ---------------------------------------------------------------------------

/**
 * Every severed fracture in a lane THIS RUN TOUCHED, run POST-STATE (after
 * this call's own writes have landed, since `commit`'s handler calls this
 * AFTER `writes.commit`) over the SAME projection the lane checker itself
 * uses. `touched` is this run's own LANDED writes (`touched`, below — an edge
 * side or a landed tags write, never mere membership in the writable set);
 * the fractures are `computeLaneFractures`' consecutive pairs, recomputed
 * fresh, so a stitch self-evidences by simply not being reported again.
 *
 * TICKET 06 (user ruling S15069/T2278): THE DISPOSITION LEDGER IS GONE FROM
 * THIS FUNCTION. It used to ask `checkLaneDispositionJustification` whether a
 * `justify` row stood against the fracture's current fingerprint, and skip the
 * fracture when one did. That question had exactly one consumer — the refusal
 * ticket 04 removed — so what remained was a stored judgment that could
 * silence a warning permanently on no evidence anyone re-checks. There is no
 * such thing as a silenced fracture any more: a warning leaves the report on
 * its own as the window advances. The `justify` TOUCH source went with it,
 * which is the more important half — it was self-arming (job 166's lane was
 * armed by the very justify that was answering the gate), and every source
 * left is a write to the graph.
 *
 * Over-blocking fix (severed-lane ticket): `touched` used to be "any island member
 * is inside `scope.writableTurnIds`" — window ∪ lookback ∪ closure — so a
 * severed lane this run never wrote so much as one field of still owed a
 * disposition, whenever any of its members merely fell inside the rendered
 * lookback. `writableTurnIds` is WIDER than what a run actually does; the
 * gate now asks the narrower, correct question of `runTouches` (this run's
 * own accumulated write facts, `note-settlement-direct-write.ts`'s
 * `getRunLaneTouches()`) instead.
 *
 * A `DEFAULT_SEGMENT` (homeless) lane carries no real segment row to address
 * and is skipped — the same posture the rest of this codebase takes for a
 * homeless lane.
 *
 * TICKET 03: takes the caller's OWN `SettlementLaneEvaluation` rather than
 * running a second `evaluateWindowLanes` of its own. It used to recompute, and
 * that recomputation was unprojected — so inside ONE `lane_check` call the
 * connectivity section (projected) could omit the very lane this block then
 * demanded a disposition for. Both halves read one value now, and the fix is
 * structural: there is no scope argument here to get wrong, because there is
 * no projection step here at all.
 *
 * TICKET 04: THIS FUNCTION NO LONGER DECIDES WHETHER A FRACTURE BLOCKS. Every
 * fracture it finds is handed to `classifySettlementFinding` — the one rule —
 * and lands in whichever bucket that answers. Under the frozen rule a fracture
 * is a WARNING (connectivity is a quality goal, not a legal post-state; and a
 * writable pair does not imply a truthful relation), so `blocking` is empty in
 * practice and `commit` no longer refuses over a lane disposition. The
 * `blocking` bucket and its callers' refusal branches are DELIBERATELY LEFT
 * REACHABLE: they are what makes the demotion a property of the rule rather
 * than of this function, and flipping the rule's fracture arm turns the
 * demotion fixtures red at the commit verdict, which is where the behaviour
 * actually lives.
 */
function evaluateLaneDispositionGate(
  db: Database,
  evaluation: SettlementLaneEvaluation,
  runTouches: RunLaneTouches,
  scope: SettlementProjectionScope,
): { blocking: string[]; warnings: string[] } {
  const { result } = evaluation;
  const blocking: string[] = [];
  const fractureWarnings: string[] = [];
  const findingContext: SettlementFindingContext = {
    writableTurnIds: scope.writableTurnIds,
    ...(scope.writableProvenance ? { writableProvenance: scope.writableProvenance } : {}),
    anchorsInJudgment: evaluation.judged,
  };
  for (const component of result.components) {
    if (component.componentCount <= 1) {
      continue;
    }
    const segmentId = Number(component.key.segment);
    if (!Number.isInteger(segmentId)) {
      continue; // DEFAULT_SEGMENT — no real segment row to address
    }
    // TOUCHED means this run's own writes named the lane — never that a
    // member merely sat inside the writable set. Two ways in: a landed tags
    // write REMOVED the tag (which addresses the lane directly, segment+tag,
    // because the turn it left is no longer a member of it), or an edge side /
    // landed tags write named one of the lane's OWN members — matched against
    // `component.islands` (the checker's own membership answer) rather than
    // resolved to a segment independently, so this can never drift from what
    // the loader itself considers a member. TICKET 06 removed the third way
    // in, `justify`, which named a lane the run had written no member of — the
    // self-arming one.
    const touched =
      runTouches.laneKeys.has(laneTouchSegmentTagKey(segmentId, component.key.tag)) ||
      component.islands.some((island) =>
        island.memberIds.some((id) =>
          runTouches.turnTagPairs.has(laneTouchTurnTagKey(id, component.key.tag)),
        ),
      );
    if (!touched) {
      continue;
    }
    for (const fracture of computeLaneFractures(segmentId, component)) {
      const fractureText =
        `[LANE-DISPOSITION] E${segmentId} lane "${component.key.tag}" — severed fracture ` +
        `${turnAddressFor(db, fracture.representativeA)} <-> ` +
        `${turnAddressFor(db, fracture.representativeB)}`;
      // THE ONE RULE, ASKED (ticket 04). Whether this fracture blocks is not a
      // decision this loop is entitled to make.
      const findingClass = classifySettlementFinding(
        {
          kind: "lane-fracture",
          segmentId,
          tag: component.key.tag,
          representativeA: fracture.representativeA,
          representativeB: fracture.representativeB,
        },
        findingContext,
      );
      if (findingClass === "warning") {
        // A warning names the STITCH TARGET and nothing else — no verb, no
        // "owes", no `justify`. The block-level notice
        // (`LANE_CHECK_WARNING_NOTICE`) carries the contract once; repeating an
        // instruction per line is how a warning starts reading like a queue,
        // which is the round trip this batch exists to remove.
        fractureWarnings.push(`${fractureText} (stitch target)`);
        continue;
      }
      // UNREACHABLE UNDER THE FROZEN RULE, and deliberately still here
      // (ticket 04 decision 9): the demotion is a property of
      // `classifySettlementFinding`, not of this loop, so flipping the rule's
      // fracture arm has to turn the commit verdict red rather than hit a
      // missing branch. TICKET 06: the only discharge this line ever named was
      // a `justify`, and there is none — a fracture that blocked would now be
      // repaired by a stitch or by nothing at all.
      blocking.push(
        `${fractureText} has no stitching edge. Stitch it (write any of the seven relations ` +
          "across it) if the material you are reading makes one true.",
      );
    }
  }
  const warnings: string[] = [];
  // ONE BLOCK, headed by the verbatim notice (spec, "Warning wording"). Emitted
  // as a single string so the notice can never be separated from the findings
  // it governs by a consumer that joins the list differently.
  if (fractureWarnings.length > 0) {
    warnings.push(
      [
        `LANE DISPOSITION — ${fractureWarnings.length} severed fracture(s) in lane(s) this run touched:`,
        ...fractureWarnings.map((line) => `  ${line}`),
        LANE_CHECK_WARNING_NOTICE,
      ].join("\n"),
    );
  }
  // TICKET 06: the DUPLICATE-REASON ANOMALY WARNING stood here — the rate of
  // repeated `reason` strings across a segment's justify records, surfaced
  // above 50% as "human review suggested". It was the last consumer of the
  // ledger after ticket 04 took the gate away, and it is a signal about a
  // write nobody makes any more.
  return { blocking, warnings };
}

/** One error instance as a repair line: what is wrong, where, and the move that clears it. */
function describeCommitGateError(db: Database, error: LaneCheckerError): string {
  const anchor = turnAddressFor(db, error.anchorId);
  switch (error.class) {
    // E1 (an untagged extends/narrows) is RETIRED with the tag mandate
    // (lane-declaration ticket 02), and E2 (an out-of-vocabulary relation word)
    // with lane-model-v12 ticket 11: no stored row can carry a word outside the
    // seven and no write face can create one, so the gate — which only ever runs
    // against a migrated, writable database — has nothing to refuse over. The
    // FACT survives on the warning side, where a hard-readonly reader of legacy
    // stock can still meet it.
    case "E3":
      return (
        `[E3] ${anchor}: type ${
          error.types.length === 0
            ? "is empty"
            : `[${error.types.join(",")}] is outside the vocabulary (${error.outsideVocabulary.join(",")})`
        }. Set a legal type on this turn.`
      );
    case "E4":
      return (
        `[E4] ${anchor}: ${error.relation} -> ${turnAddressFor(db, error.citedId)} {${error.tags.join(",")}} — ` +
        `${error.missing
          .map((miss) => `"${miss.tag}" missing from the ${miss.endpoint} turn's own tags`)
          .join(", ")}. Add the tag to that turn, or retract the edge.`
      );
    // Ticket 20: the DRAFT edge. Unlike E3/E4 this is not a write-gate rule
    // re-checked over stock — the write gate accepts the shape, and this is
    // where the refusal lives instead. The repair line names BOTH ways out
    // (place the sides, or retract), because a draft settlement decides against
    // is cleared by deletion just as legitimately.
    case "E6":
      return (
        `[E6] ${anchor}: ${error.relation} -> ${turnAddressFor(db, error.citedId)} — DRAFT edge, ` +
        `${
          error.unsettledSides.length === 2
            ? "neither side names a lane"
            : `the ${error.unsettledSides[0]} side names no lane (the ${
                error.unsettledSides[0] === "tail" ? "head" : "tail"
              } side is {${error.tags.join(",")}})`
        }. Place both sides with a {turn, tailTag, headTag} entry, or retract the edge.`
      );
    default: {
      // Exhaustive over `LaneErrorClass` today (E3/E4/E6; E1 retired with the
      // tag mandate). A class added to the
      // checker must gain a line here rather than reach the agent as an
      // unexplained refusal — this is the compile-time reminder, and the
      // runtime fallback keeps the anchor actionable even if one ever slips
      // through.
      const unclassed = error as { class: string };
      return `[${unclassed.class}] ${anchor}: see \`lane_check\` for this instance.`;
    }
  }
}

/**
 * SETTLEMENT-ERGONOMICS TICKET 07 (spec D5): the commit refusal's finding
 * list, split by ERROR ORIGIN — where each blocking error's `anchorId` sits
 * among the three frozen buckets `resolveSettlementScopeProvenance` (spec D0)
 * computed. Measured on a real 100-turn run: 63 refusal errors reached the
 * agent in ONE undifferentiated list, spanning the window, the declared
 * lookback and the deadlock-guard closure with no way to tell which were the
 * agent's own to fix; this groups them so it can.
 *
 * THIS IS NOT A WRITABILITY SPLIT. `resolveSettlementWritableSet`'s collapse
 * of the rendered lookback and the closure into one `lookback` list is
 * untouched, and nothing here changes what may be written or how much — see
 * that function's own comment, and `SettlementScopeProvenance`'s. Every id
 * grouped below was already a member of `scope.writableTurnIds`; this
 * function answers a different question about the SAME ids — WHERE they came
 * from, not how writable they are.
 *
 * Classification mirrors `resolveSettlementScopeProvenance`'s own precedence
 * (`window > baseLookback > closureOnly`) rather than re-deriving it: an id
 * `provenance` does not place in `window` or `baseLookback` is filed under
 * `closureOnly`, the same catch-all that function uses, so an id the caller
 * forgot to classify still prints rather than silently vanishing from a
 * refusal the agent is judged by.
 */
function groupBlockingErrorsByOrigin(
  blocking: readonly LaneCheckerError[],
  provenance: SettlementScopeProvenance,
): {
  window: LaneCheckerError[];
  baseLookback: LaneCheckerError[];
  closureOnly: LaneCheckerError[];
} {
  const window: LaneCheckerError[] = [];
  const baseLookback: LaneCheckerError[] = [];
  const closureOnly: LaneCheckerError[] = [];
  for (const error of blocking) {
    if (provenance.window.has(error.anchorId)) {
      window.push(error);
    } else if (provenance.baseLookback.has(error.anchorId)) {
      baseLookback.push(error);
    } else {
      closureOnly.push(error);
    }
  }
  return { window, baseLookback, closureOnly };
}

/** One labelled section of the partitioned refusal, header plus its own repair lines — omitted entirely when empty. */
function renderBlockingErrorsByOrigin(
  db: Database,
  blocking: readonly LaneCheckerError[],
  provenance: SettlementScopeProvenance,
): string[] {
  const grouped = groupBlockingErrorsByOrigin(blocking, provenance);
  const sections: Array<[string, LaneCheckerError[]]> = [
    ["IN THIS WINDOW", grouped.window],
    ["IN YOUR DECLARED LOOKBACK", grouped.baseLookback],
    ["PULLED IN ONLY BY AN EDGE", grouped.closureOnly],
  ];
  const lines: string[] = [];
  for (const [label, errors] of sections) {
    if (errors.length === 0) {
      continue;
    }
    lines.push(`${label} (${errors.length}):`);
    for (const error of errors) {
      lines.push(`  ${describeCommitGateError(db, error)}`);
    }
  }
  return lines;
}

/**
 * THE GRAMMAR FINDINGS, SPLIT BY THE ONE RULE (settlement-gate-taxonomy ticket
 * 04). `commit`'s refusal list and `lane_check`'s two sections are the SAME
 * split, computed here and read by both, so a run cannot be shown one class and
 * judged on another.
 *
 * THE RULE ITSELF LIVES IN `note-settlement-finding-class.ts` and nothing here
 * restates it. This function's whole job is to ask it once per instance and to
 * put the answer in a bucket. What used to live here was
 * `blocksUnderProvenance`, whose hand-written carve-out ("E3 never blocks
 * here") was the spec's second written contradiction: `lane_check` printed the
 * class under `## ERRORS` and this gate silently removed it. The rule's third
 * condition covers it now — an E3's only repair is a `type` field write and the
 * edge pass holds no such pen — so the carve-out is gone rather than moved, and
 * the render shows the class on the side the gate actually treats it.
 */
function classifyEvaluationErrors(
  evaluation: SettlementLaneEvaluation,
  scope: SettlementProjectionScope,
): { blocking: LaneCheckerError[]; informational: LaneCheckerError[] } {
  const context: SettlementFindingContext = {
    writableTurnIds: scope.writableTurnIds,
    ...(scope.writableProvenance ? { writableProvenance: scope.writableProvenance } : {}),
    anchorsInJudgment: evaluation.judged,
  };
  const blocking: LaneCheckerError[] = [];
  const informational: LaneCheckerError[] = [];
  for (const error of evaluation.result.errors) {
    if (classifySettlementFinding({ kind: "grammar-error", error }, context) === "blocking-error") {
      blocking.push(error);
    } else {
      informational.push(error);
    }
  }
  return { blocking, informational };
}

/**
 * The same rule, in the shape `renderLaneCheckerReportsPaged` asks for — an
 * ADAPTER, not a second answer: it forwards to `classifySettlementFinding` per
 * instance and translates the class name into the render's own two words. The
 * render is a shared, pure module and cannot see a run's judgment set or its
 * authority, which is exactly why it asks rather than decides.
 */
function laneCheckErrorClassifier(
  evaluation: SettlementLaneEvaluation,
  scope: SettlementProjectionScope,
): (error: LaneCheckerError) => "blocking" | "informational" {
  const context: SettlementFindingContext = {
    writableTurnIds: scope.writableTurnIds,
    ...(scope.writableProvenance ? { writableProvenance: scope.writableProvenance } : {}),
    anchorsInJudgment: evaluation.judged,
  };
  return (error) =>
    classifySettlementFinding({ kind: "grammar-error", error }, context) === "blocking-error"
      ? "blocking"
      : "informational";
}

/**
 * The gate itself: run the checker over the job's immutable writable set and
 * REFUSE while any error anchors INSIDE it. TICKET 03 split it in two — this
 * name is now the standalone entry point (evaluate, then render); production
 * calls `renderSettlementCommitGateRefusal` directly with an evaluation it
 * already holds, so `commit`'s refusal is a rendering of the same value its
 * disposition gate reads and not a second computation.
 *
 * Returns the refusal payload, or `null` when the window is clean enough to
 * commit. Four properties this function exists to hold:
 *
 *   - **The projection is the writable set** (peer round T1466, finding
 *     P1-1). Seed and filter are now the SAME value — `evaluateWindowLanes`
 *     above — so "an error the gate could refuse over" and "an error the
 *     projection loaded" cannot come apart. When they did, a lookback turn's
 *     E3 (and, before its retirement, E1) and an external-endpoint E2 were
 *     unreachable by construction: the
 *     filter below is a subset operation, and no subset of a projection that
 *     never loaded a row can produce that row.
 *   - **Anchor filtering is the whole verdict.** `LaneCheckerError.anchorId`
 *     is a turn id the repairing agent can address (an edge error anchors at
 *     its CITING turn, a type error at the turn itself), and membership in
 *     `writableTurnIds` is the first question asked of it. An error anchored
 *     outside blocks its OWN window and never this one — without that
 *     scoping a single bad out-of-window edge pins a window on a
 *     permanently failing commit, the terminal-state trap (spec "Anchoring
 *     and repairability", the burned window_start precedent S15069/T1410).
 *     Staged settlement added the SECOND question, same principle one level
 *     finer: can this job's authority over that anchor repair this CLASS of
 *     error. TICKET 04 folded both questions, and the judgment question with
 *     them, into ONE RULE — `classifySettlementFinding` — so this gate no
 *     longer holds a filter of its own at all; it renders whichever instances
 *     that rule classed blocking.
 *   - **`result.errors` is uncapped and so is this list.** The checker's
 *     RENDER caps for display; the data does not, because an instance that
 *     sorted past a cap would slip the gate and the window would commit
 *     dirty. Every offending instance is named here for the same reason.
 *   - **Exemptions flow from the checker alone.** Compact markers and
 *     legally-skipped/rolled-back turns never reach `errors` at all
 *     (`db/lane-checker-load.ts`'s `liveTurnSql` gate, and the checker's own
 *     compact skip), so there is no second exemption predicate here to drift
 *     from the first.
 */
export function evaluateSettlementCommitGate(
  db: Database,
  scope: SettlementProjectionScope,
  // Settlement-ergonomics ticket 07 (spec D0/D5): optional so a caller that
  // never modeled the distinction (a pre-ticket-07 stub, or a fixture testing
  // something else entirely) gets the OLD flat, undifferentiated list. THE
  // PRODUCTION TOOL PATH NO LONGER REACHES THIS FALLBACK (ticket 03): a
  // `commit`/`lane_check` call whose dispatch carried no `scopeProvenance`
  // fails closed on the system-failure channel before this function is called
  // at all — see `judgeSettlementWindow`. What is left here is the
  // direct-call TEST seam, which is exactly what the ticket permits ("a test
  // seam that needs a legacy fallback must not reach the production tool
  // path").
  scopeProvenance?: SettlementScopeProvenance,
  /** Ticket 04: `RunLaneTouches.turnIds`. A direct-call seam that models no run passes none, and no finding is re-admitted by authorship. */
  authoredTurnIds?: ReadonlySet<number>,
): string | null {
  return renderSettlementCommitGateRefusal(
    db,
    evaluateWindowLanes(db, scope, authoredTurnIds),
    scope,
    scopeProvenance,
  );
}

/**
 * The gate's RENDERING half (ticket 03): a pure function of an evaluation the
 * caller already has. `commit` calls this with the SAME
 * `SettlementLaneEvaluation` its disposition gate reads, so its two refusals
 * describe one look at the graph rather than two.
 */
function renderSettlementCommitGateRefusal(
  db: Database,
  evaluation: SettlementLaneEvaluation,
  scope: SettlementProjectionScope,
  scopeProvenance?: SettlementScopeProvenance,
): string | null {
  const { blocking, informational } = classifyEvaluationErrors(evaluation, scope);
  if (blocking.length === 0) {
    return null;
  }
  // ONE non-blocking remainder is left to count. The other — "N further
  // error(s) anchor OUTSIDE your writable set" — is GONE with ticket 03's
  // projection: `evaluateWindowLanes` now projects the result to the writable
  // set before anybody reads it, so `result.errors` has no out-of-set member
  // left to count and the line could only ever have printed "0". It was also
  // the last place `commit` reported a finding `lane_check` had never shown:
  // the preview's own default projection has dropped those rows since
  // settlement-ergonomics ticket 06, so the count named errors the agent could
  // not see anywhere. Ticket 17's remainder below survives because it names a
  // class (E3) that IS inside the writable set and IS shown by the preview —
  // and since ticket 04 the preview shows it on the WARNING side, which is the
  // side this line has always described it from.
  const beyondAuthority = informational.length;
  return [
    `Commit refused — ${blocking.length} error(s) the grammar forbids still anchor inside your ` +
      "writable set. NOTHING was committed and this is NOT a failed attempt: repair these " +
      "and call `commit` again in this same run.",
    ...(scopeProvenance
      ? renderBlockingErrorsByOrigin(db, blocking, scopeProvenance)
      : blocking.map((error) => `  ${describeCommitGateError(db, error)}`)),
    beyondAuthority > 0
      ? `(${beyondAuthority} further error(s) inside your writable set are turn-TYPE debts (E3) — ` +
        "their repair is a note field no edge pass holds the pen for, whatever put the turn in your " +
        "set. They are stage 1's, reached through a later window's lookback, and are not blocking here.)"
      : null,
    "`lane_check` shows the same list, plus the warnings, without a commit attempt.",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

// ---------------------------------------------------------------------------
// The frozen-scope install seam (settlement-execution-repair ticket 02,
// spec "The frozen scope is installed by an internal handoff") — PREFACTOR
// ---------------------------------------------------------------------------

/**
 * THE FROZEN EDGES SCOPE moved out (claim-monitor-repair ticket 02, peer
 * round 2 gate 6) to `note-settlement-edges-scope.ts`, and is re-exported
 * here so every existing importer is untouched. It never had an SDK
 * dependency; it only LIVED beside one, and that was the last value edge
 * dragging this whole module — the model client with it — into the worker's
 * own bundle. See the new module's own comment for why the split is what
 * makes "the worker hosts no settlement model" checkable rather than merely
 * asserted.
 */
export {
  installSettlementEdgesScope,
  type SettlementEdgesScope,
  type SettlementEdgesScopeHolder,
} from "./note-settlement-edges-scope";

export function createNoteSettlementSdkQuery(
  options: CreateNoteSettlementSdkQueryOptions,
): NoteSettlementQuery {
  const queryImpl = options.queryImpl ?? query;
  const createSdkMcpServerImpl =
    options.createSdkMcpServerImpl ?? createSdkMcpServer;
  const toolImpl = options.toolImpl ?? tool;
  // Epoch seconds, injectable like every other clock on this closure — the
  // lease heartbeat below stamps with it.
  const nowEpoch = options.now ?? (() => Math.floor(Date.now() / 1000));
  const handlers = createDatabaseBackedHandlers(options.db, {
    defaultProject: options.defaultProject,
    audience: "worker",
  });

  return async (
    request: NoteSettlementQueryRequest,
  ): Promise<NoteSettlementQueryResult> => {
    const abortController = new AbortController();

    // THE RESPONSE-ORIGIN COORDINATOR (ticket 01 — lands INERT: nothing
    // refuses on an origin yet, a later ticket arms that). Fresh per
    // dispatch, exactly like `abortController` above — see
    // `note-settlement-response-origin.ts` for why a fresh registry per call
    // is the whole cross-generation guarantee this owes. `readStage` reads
    // the durable row itself, not `request.stage`: the row is what this same
    // run's own `commit`/gate checks already key on, and freezing off a
    // value that cannot change would silently misname every response after
    // a transition.
    //
    // Wired to `abortController.signal` BEFORE `forwardAbort` below can ever
    // fire it: an `AbortSignal` only notifies listeners registered before
    // the moment `.abort()` runs, and `request.signal` may already be
    // aborted by the time this closure starts — a listener added after the
    // synchronous `forwardAbort()` call a few lines down would silently miss
    // it.
    const originRegistry =
      options.originRegistry ??
      createResponseOriginRegistry({
        readStage: () => getNoteSettlementJob(options.db, request.jobId)?.stage ?? null,
      });
    abortController.signal.addEventListener(
      "abort",
      () => originRegistry.abort(),
      { once: true },
    );

    const forwardAbort = (): void => {
      abortController.abort(request.signal?.reason);
    };
    if (request.signal) {
      if (request.signal.aborted) {
        forwardAbort();
      } else {
        request.signal.addEventListener("abort", forwardAbort, { once: true });
      }
    }

    // Job identity (spec G6, ticket 10a): built HERE, inside the per-request
    // closure, from the dispatch's own job record — never from anything the
    // model supplied. `settlementTurnWriteInputShape`/`settlementMembershipWriteInputShape`
    // declare no `jobId`/`claimGeneration` field at all, so the SDK's own
    // arg-parsing (built from that same shape, ahead of the handler) never
    // delivers one even if a model tried to state one; and neither facade's
    // own evaluator ever reads a job identity off its input regardless —
    // see those files' own comments. This closure is the only place these
    // values exist for this request, and they never travel through the
    // model's own input or output. It is also why the handlers above are
    // built ONCE at module-call time while THIS context (and the direct-
    // write engine built from it, ticket 05) must be built per request: a
    // job's identity does not exist until a request names one.
    //
    // THE THREE TRANSITION SNAPSHOTS (staged-settlement spec Rev 5,
    // §Persisted snapshots), read ONCE per request and frozen for its whole
    // life. THIS is what makes stage 2 the pass the spec describes: its
    // authority, its worklist and its graph's vertices are READ, never
    // re-derived — a retry that recomputed them would settle a different graph
    // than the one its own commit's shape numbers describe.
    //
    // `null` means the job never transitioned (still stage 1, or a job from
    // before staged settlement). Then — and only then — the values the dispatch
    // computed live stand, which is exactly the pre-staging behaviour. When the
    // snapshot IS there it WINS over the request's own live computation, so a
    // caller that recomputed the writable set cannot widen what this run may
    // write past what stage 1 froze.
    const scopeHolder = installSettlementEdgesScope(options.db, request.jobId, {
      writableTurnIds: request.writableTurnIds,
      scopeProvenance: request.scopeProvenance,
    });
    /**
     * ONE scope descriptor for every checker call this request makes
     * (settlement-gate-taxonomy ticket 02). A FUNCTION, not a value: the
     * writable set and its provenance live on `scopeHolder.current`, which a
     * later `installSettlementEdgesScope` may replace mid-request, and the four
     * call sites below used to re-spell the same two fields each — so a third
     * field could be added to three of them and forgotten in the fourth. The
     * judgment window is this dispatch's own, taken from the request and never
     * from anything the model supplied.
     */
    const projectionScope = (): SettlementProjectionScope => ({
      writableTurnIds: scopeHolder.current.writableTurnIds,
      writableProvenance: scopeHolder.current.writableProvenance,
      judgment: {
        sessionId: request.sessionId,
        windowStart: request.windowStart,
        windowEnd: request.windowEnd,
      },
    });
    /**
     * THE THIRD CHANNEL, per request (settlement-gate-taxonomy ticket 05).
     *
     * `raiseSystemFailure` is the ONE way a failure leaves this dispatch: it
     * reaches the OPERATOR first — the worker log, not this run's transcript,
     * which nobody reads unless they already suspect a problem — and then
     * returns the agent-facing render. Sinking and rendering are one call so a
     * later surface cannot render a failure it forgot to report.
     *
     * `protocolBoundedResult` is case 4, asked ONCE per judgment result, on the
     * exact bytes the protocol is about to carry (never on a fragment, and never
     * before the trailing blocks are appended — those are what pushed real
     * results over).
     */
    const systemFailureSink = options.systemFailure?.sink ?? logSettlementSystemFailure;
    const resultTokenCeiling =
      options.systemFailure?.resultTokenCeiling ?? SETTLEMENT_RESULT_TOKEN_CEILING;
    const raiseSystemFailure = (
      failure: SettlementSystemFailure,
      surface: "lane_check" | "commit",
    ): string => {
      systemFailureSink(failure, {
        surface,
        jobId: request.jobId,
        claimGeneration: request.claimGeneration,
      });
      return renderSettlementSystemFailure(failure);
    };
    const protocolBoundedResult = (
      text: string,
      surface: "lane_check" | "commit",
    ): { content: Array<{ type: "text"; text: string }> } => {
      const failure = overProtocolResultFailure(text, resultTokenCeiling);
      return failure === null
        ? textResult(text)
        : textResult(raiseSystemFailure(failure, surface));
    };
    const turnFacadeContext: SettlementTurnFacadeContext = {
      jobId: request.jobId,
      claimGeneration: request.claimGeneration,
      // The third member of the ownership tuple — the writer identity below,
      // and every `assertNoteSettlementJobClaimed` the direct-write engine
      // runs, key on it.
      stage: request.stage,
      // GETTERS, not values copied out at construction: the direct-write
      // engine (`note-settlement-direct-write.ts`) holds this object by
      // reference and reads `context.writableProvenance`/
      // `context.reviewableTurnIds` fresh on every call — so a later
      // `installSettlementEdgesScope(..., scopeHolder)` (ticket 03) is
      // visible here with no engine rebuild, exactly like the gate closures
      // below that read `scopeHolder.current` directly.
      get writableProvenance() {
        return scopeHolder.current.writableProvenance;
      },
      sessionId: request.sessionId,
      // ONE definition of the writable set (tag-mandate ticket 05): the
      // facade's range check reads the SAME `request.writableTurnIds` the
      // commit gate judges anchors against. The facade's field keeps its
      // older name (`reviewableTurnIds`) because the membership facade shares
      // that interface; what it CARRIES is this dispatch's declared writable
      // set, closure included — nothing recomputes "window ∪ rendered
      // lookback" independently any more.
      get reviewableTurnIds() {
        return scopeHolder.current.writableTurnIds;
      },
      contextBuiltAtEpoch: request.contextBuiltAtEpoch,
    };
    // ONE identity for this run's reads AND its writes (tag-mandate ticket
    // 06). The write facades derive the same string from the same two numbers
    // (`claimWriterId`, the pinned encoding in `db/write-gate.ts`); deriving
    // it once here and handing it to `recall` is what closes the loop the
    // retired context render used to close from the other side. Per request,
    // like everything else on this closure: a lapsed claim and its successor
    // are different writers, so the successor inherits none of the lapsed
    // run's read grants.
    // Staged settlement: the FULL ownership tuple. `recall`'s grants are
    // recorded under this string, so a lane, a turn or a field stage 1 read is
    // invisible to stage 2's gate check and stage 2 goes and reads it itself.
    const settlementReaderId = claimWriterId(
      request.jobId,
      request.claimGeneration,
      request.stage,
    );
    // The read handlers for THIS request's identity. A second handler set
    // beside the module-level `handlers` above, and deliberately so: an
    // identity belongs to a whole handler set (see `resolveReaderId`), and
    // settlement's two read tools are two different readers — `recall` grants,
    // `timeline` (registered off the anonymous set below) never does.
    const readHandlers = createDatabaseBackedHandlers(options.db, {
      defaultProject: options.defaultProject,
      audience: "worker",
      resolveReaderId: () => settlementReaderId,
      ...(options.now ? { now: options.now } : {}),
    });
    // THE COMMIT REPORT'S SHAPE HALF, CAPTURED INSIDE THE TERMINAL
    // TRANSACTION (final review, finding 9). Filled by the hook below; read
    // after `writes.commit()` returns, where it is a record of the state the
    // commit itself left rather than a fresh look at a table any later writer
    // may already have moved.
    let terminalShape: SettlementShapeNumbers | null = null;
    let terminalRetractions: SettlementHomelessRetraction[] = [];
    // TICKET 19, finding 1: THE TERMINAL GATES' OWN VERDICT, PRODUCED INSIDE
    // THE TERMINAL TRANSACTION. Same closure-and-hook shape as `terminalShape`
    // above and for the same reason — the gates read the live edge and tag
    // tables, so evaluated out here (as they were) they judged a graph any
    // writer landing before `BEGIN IMMEDIATE` had already changed, and the
    // commit went on to mark the job `done` over the newly minted E6/E4 or the
    // freshly undispositioned fracture.
    //
    // This layer now evaluates NOTHING of its own: it reads the verdict the
    // callback left here and routes on it. Reset immediately before each
    // `writes.commit()` call so a second, idempotent `commit` — which returns
    // "Already committed" without opening a transaction, so without running
    // the gates — cannot re-append the FIRST call's warnings.
    let terminalGateVerdict: SettlementTerminalGateVerdict | null = null;
    // Read through a CALL, never as a bare reference: the hook that fills this
    // is a different function, and TypeScript's flow analysis does not model
    // that — a direct read after the reset below would be narrowed to the
    // `null` it was just set to and the refusal branch would not compile.
    const readTerminalGateVerdict = (): SettlementTerminalGateVerdict | null =>
      terminalGateVerdict;
    // THE IMPRESSION OBLIGATION (lane-impressions ticket 02). The RESUME
    // dispatch carries it too, and that is not symmetry for its own sake: this
    // is the path a reclaim takes after a crash between the transition and the
    // terminal commit, so it reaches the same `commit` carrying the same
    // obligation over the same frozen worklist. Wiring it in one shape and not
    // the other would mean the crash-recovery path settles windows with no
    // impression maintenance at all.
    const impressions = wireSettlementImpressions({
      db: options.db,
      jobId: request.jobId,
      // THE LEASE, for the impression WRITE (ticket 10): this dispatch has one
      // fixed stage for its whole life, so the getter answers `request.stage`
      // and the fence is the same `(job, generation, stage)` tuple every other
      // write face here asserts.
      claimGeneration: request.claimGeneration,
      readStage: () => request.stage,
      readWritableTurnIds: () => scopeHolder.current.writableTurnIds,
      // THE REAL CLAIM (lane-impressions ticket 03), with ticket 02's seam kept
      // as the OVERRIDE rather than replaced: a test still injects its own set,
      // and production no longer defaults to claiming nothing.
      claimImpressionDebts:
        options.claimImpressionDebts ??
        createAttachedImpressionDebtClaimer({
          jobId: request.jobId,
          sessionId: request.sessionId,
          now: nowEpoch,
        }),
      ...(options.now ? { now: options.now } : {}),
    });
    // SEED THE LEDGER (lane-impressions ticket 02). The coordinates this run was
    // SHOWN reached it through its PROMPT, rendered by the dispatch in another
    // process — so this side has to compute the same block once to know what was
    // shown. Without it the run's first `commit` would be refused as "you were
    // never shown this container's coordinates" over coordinates it is in fact
    // reading off its own prompt. Both reads are the same pure function over the
    // same durable rows; if a concurrent writer moved something between them,
    // the fence rejects, which is the correct answer either way.
    impressions.maintainer.renderAdvisories();
    const writes = createSettlementDirectWriteEngine({
      db: options.db,
      context: turnFacadeContext,
      now: options.now,
      settleImpressions: impressions.settleImpressions,
      ...(options.runWriteTransaction
        ? { runWriteTransaction: options.runWriteTransaction }
        : {}),
      captureAtCommit: (db) => {
        terminalShape = computeSettlementShapeNumbers(db, request.jobId);
        terminalRetractions = collectSettlementHomelessRetractions(
          db,
          request.jobId,
          scopeHolder.current.writableTurnIds,
        );
      },
      // TICKET 19, finding 1 — "look once, INSIDE". Both terminal gates, in
      // the order they always ran (an E3/E4/E6 grammar error is this window's
      // more basic defect than an owed disposition), now evaluated under the
      // write lock that is about to mark this job done. The refusal strings
      // are byte-identical to the ones this handler used to compose out here;
      // the engine returns them unwrapped and rolls its transaction back, so a
      // refusal still costs no attempt and the run may repair and retry.
      //
      // `writes.getRunLaneTouches()` reaches back into the engine being
      // constructed — legal, and deliberate: this callback runs only from
      // `commit`, long after the binding exists, and the disposition gate's
      // two callers (this one and `lane_check`'s preview) must read the touch
      // ledger from exactly one place or they can disagree about what this run
      // has written.
      evaluateTerminalGates: (db) => {
        // FAIL CLOSED before anything is judged (ticket 03, typed by ticket
        // 05). A commit is the one place where falling open costs the most: the
        // job would be marked done over a graph nobody could describe. The
        // verdict carries the failure on its OWN arm — it is not a refusal, and
        // this run has nothing to repair and no reason to call `commit` again.
        const scope = projectionScope();
        const runTouches = writes.getRunLaneTouches();
        const judgment = judgeSettlementWindow(
          db,
          scope,
          scopeHolder.current.scopeProvenance,
          runTouches.turnIds,
        );
        if (!judgment.ok) {
          raiseSystemFailure(judgment.failure, "commit");
          terminalGateVerdict = { ok: false, systemFailure: judgment.failure };
          return terminalGateVerdict;
        }
        // ONE EVALUATION, TWO RENDERINGS (ticket 03). The grammar refusal and
        // the disposition refusal below are two READINGS of this single value,
        // taken at one instant inside the terminal transaction — never two
        // independent looks at a graph a write could move between them.
        const evaluation = judgment.evaluation;
        const refusal = renderSettlementCommitGateRefusal(
          db,
          evaluation,
          scope,
          scopeHolder.current.scopeProvenance,
        );
        if (refusal !== null) {
          terminalGateVerdict = { ok: false, refusal };
          return terminalGateVerdict;
        }
        // THE LANE DISPOSITION PASS (severed-lane ticket 02, [S15069/T1951]).
        // It was a MANDATORY gate; settlement-gate-taxonomy ticket 04 (user
        // ruling T2274) demoted its findings to warnings through the one
        // classification rule, so what normally comes back now is
        // `warnings` — carried onto the SUCCESSFUL commit's receipt below.
        // The refusal branch under it is not dead: it renders whatever the rule
        // classes blocking, and that is where the demotion is actually observable.
        const disposition = evaluateLaneDispositionGate(db, evaluation, runTouches, scope);
        if (disposition.blocking.length > 0) {
          terminalGateVerdict = {
            ok: false,
            refusal: [
              `Commit refused — ${disposition.blocking.length} severed lane fracture(s) touched by ` +
                "this run still owe a disposition. NOTHING was committed and this is NOT a failed " +
                "attempt: repair these and call `commit` again in this same run.",
              ...disposition.blocking.map((line) => `  ${line}`),
            ].join("\n"),
          };
          return terminalGateVerdict;
        }
        // Switch 2, defaulted: a clean disposition gate still carries the
        // duplicate-reason anomaly signal forward onto the actual commit
        // receipt, so it is never lost for want of a refusal to ride along
        // with.
        terminalGateVerdict = { ok: true, warnings: disposition.warnings };
        return terminalGateVerdict;
      },
      // era-grant-by-settlement ticket 02: `commit`'s own forward era grant
      // reads these straight off the job's frozen bounds, the same window
      // `windowStart`/`windowEnd` above declare to `lane_check` — never
      // `request.writableTurnIds`, which also carries the rendered lookback
      // and the deadlock-guard closure.
      windowStart: request.windowStart,
      windowEnd: request.windowEnd,
    });
    // Ticket 06 (spec "Stop hook 重实现"): per REQUEST, like the engine it
    // reads — the block count is a fact about this run's stops, and a shared
    // one would let an earlier window's stops silence a later window's
    // warning. Registered as an SDK hook rather than through
    // `hooks/hook-command.ts`: that command short-circuits to success for
    // `CLAUDE_CODE_ENTRYPOINT === "sdk-ts"`, so mnemo's file-configured hooks
    // deliberately never fire inside a spawned SDK child. Reads the job row
    // directly (jobId + claim generation) rather than through the write
    // engine — direct write means the hook's probe is "job claimed but not
    // yet done", a plain read, not a re-run of any write-side logic.
    const stopHook = createSettlementStopHook({
      db: options.db,
      jobId: request.jobId,
      claimGeneration: request.claimGeneration,
    });

    // Ticket 06: read ONCE, after the model's run has fully ended (below,
    // mirroring `getLastCommitMetrics`'s own "the model never sees this
    // value" discipline) — a plain per-request flag, never exposed as a
    // tool result itself, just whether the call ever happened.
    let laneCheckCalled = false;

    // THE LEASE HEARTBEAT (S15069/T1540 ruling). Wrapping the tool FACTORY,
    // not each handler, is the point: every tool this server registers — reads
    // included, since the read-only prelude alone outran the lease
    // (S15069/T1539) — renews the claim before it runs, and a tool added later
    // inherits that automatically instead of having to remember. The renewal
    // is fenced on this run's own generation inside the UPDATE, so a dispatch
    // whose lease already moved renews nothing; its writes still meet the
    // fence in their own transaction, and its reads stay harmless.
    // TICKET 01: `extra` is threaded through EXPLICITLY now — the wrapper's
    // own two declared parameters, not a `never[]` rest/spread whose type
    // forbade a real caller from naming a second parameter at all. No
    // handler registered below reads `extra` yet (this ticket arms nothing);
    // the explicit signature is what lets a LATER ticket's handler call
    // `resolveResponseOrigin(originRegistry, extra)` with a typed seam
    // instead of an unsafe cast.
    //
    // SETTLEMENT-EXECUTION-REPAIR TICKET 13, ITEM 2 (implementation-review P2
    // sweep) — arming was CONSIDERED HERE AND DECLINED; this stays a
    // documented narrowing, not an oversight. Reused verbatim from below,
    // `createUnifiedNoteSettlementSdkQuery`'s `leasedTool` DOES resolve
    // `resolveResponseOrigin(originRegistry, extra)` per call and fails
    // closed on `"unknown"`, because THAT dispatch can transition mid-run
    // (`finalize` moves `topics` -> `edges` while the model is still
    // composing a same-response sibling call) — the coordinator exists
    // precisely to stop that sibling from inheriting edge-pass authority
    // from the durable row alone (spec Rev 5, §"Two-layer identity").
    //
    // THIS dispatch never transitions. It is spawned already AT `edges` — a
    // fresh cold run under a NEW generation, one per retry (spec §Solution:
    // "resumed at `edges` by a fresh cold run under a new generation") — and
    // every tool call it will ever serve, for its whole life, wants that
    // SAME fixed stage (`request.stage`, closed over below and never
    // reassigned). There is no earlier-response mapping for a later call to
    // wrongly inherit, so the property the coordinator protects against — a
    // stale PRE-transition origin surviving past a transition it never saw —
    // cannot occur here by construction, not merely by observed behavior.
    // What already guards this path is the generation+stage CAS every write
    // goes through regardless (`SettlementTurnFacadeContext.stage` is fixed
    // to `request.stage` here, and `assertNoteSettlementJobClaimed` — reached
    // by every write face through the direct-write engine — throws the
    // moment a call's believed stage stops matching the job row's own,
    // exactly as it does on every other settlement write path); a reclaimed
    // or stale lease is refused there, not by a per-call origin lookup this
    // single-stage dispatch has no second stage to need.
    //
    // REUSE WAS THE TICKET'S OWN PREFERRED REPAIR AND WAS REJECTED HERE AS
    // DISPROPORTIONATE. Gating this dispatch's write faces the same way would
    // require every existing caller of a registered `note`/`remember`/
    // `commit` handler to start supplying `extra._meta["claudecode/
    // toolUseId"]` mapped through an observed assistant message — a shape
    // dozens of this dispatch's OWN tests do not carry
    // (`tests/worker/note-settlement-sdk-query.test.ts` calls
    // `handlers.get("note")!({...})` with no second argument at all, in 70+
    // places, none of them this ticket's territory to rewrite) and that a
    // SIBLING test file already documents as the intended contract for this
    // exact path: `tests/worker/staged-settlement-integration.test.ts`'s
    // `scriptedResumeQueryImpl` comment reads "no origin staging needed, it
    // has only one stage to be". Reworking that shape across files this
    // ticket does not own, to close a gap this dispatch's own single-stage
    // construction already closes by construction, was judged the
    // disproportionate side of the ticket's own reuse-or-narrow fork — see
    // spec Rev 5's own narrowing note under "Two-layer identity" for the
    // durable record, and
    // `tests/worker/note-settlement-response-origin.test.ts`'s "cold `edges`
    // resume applies no per-call origin gate" block for the pin.
    const leasedTool = ((
      name: string,
      description: string,
      shape: unknown,
      handler: (args: Record<string, unknown>, extra: unknown) => unknown,
    ) =>
      toolImpl(
        name as never,
        description as never,
        shape as never,
        (async (args: Record<string, unknown>, extra: unknown) => {
          touchNoteSettlementJobLease(
            options.db,
            request.jobId,
            request.claimGeneration,
            nowEpoch(),
            // The FULL tuple (finding 3) — see the DB helper's own comment:
            // fenced on the generation alone, a stale stage-1 child would keep
            // this stage-2 lease alive from outside the pass that owns it.
            request.stage,
          );
          return handler(args, extra);
        }) as never,
      )) as unknown as typeof toolImpl;

    const server = createSdkMcpServerImpl({
      name: "mnemo",
      version: "0.29.0",
      tools: [
        // RECALL, UNDER THIS RUN'S OWN WRITER IDENTITY (tag-mandate ticket
        // 06). This is the grant unification: `readerId` is the SAME
        // `claim:<job>:<generation>` string the write facade checks
        // `checkFieldGate` against, so a turn the agent recalls is a turn it
        // may then write — through `recordReadGrants`/
        // `recordFieldCompleteness`, the identical seam every other reader
        // uses, with no settlement carve-out anywhere in the gate. The
        // completeness half is what makes a whole-field `write` over another
        // writer's text possible at all now that no render licenses it: a
        // recall that delivered the field WHOLE records `complete: true`, and
        // a truncated one records `false` and sends the agent back for a
        // bigger `turn` budget — Block A's own Step-0 sentence, enforced.
        //
        // The reader identity reaches the shared factory through
        // `resolveReaderId` (peer round fold-back) — this registration used to
        // call `recallMemory` itself and restate the worker envelope
        // byte-for-byte beside it, on the grounds that a per-REQUEST claim
        // identity had no seam in a factory built once per module call. The
        // seam exists now, and the copy is gone with it: the envelope this
        // read is delivered in, and the grant that envelope authorizes (peer
        // round P1-6), are one implementation for both callers.
        leasedTool(
          "recall",
          MNEMO_TOOL_DESCRIPTIONS.recall,
          workerRecallInputShape,
          async (args: Record<string, unknown>) =>
            (await readHandlers.recall?.(args)) ?? textResult("recall unavailable"),
        ),
        // TIMELINE, WITH NO READER IDENTITY — and that absence is the
        // feature. Block A tells the agent "`timeline` helps navigate; it
        // substitutes for none of this reading and licenses nothing", and
        // this registration is what makes that true rather than merely
        // asserted: the shared handler resolves no caller session here, so
        // `readerId` is null and `mcp/timeline.ts` records no grant at all.
        // A navigational view that licensed writes would let an agent skip
        // Step 0's coverage entirely.
        leasedTool(
          "timeline",
          MNEMO_TOOL_DESCRIPTIONS.timeline,
          timelineInputShape,
          async (args: Record<string, unknown>) =>
            textResult(
              (await handlers.timeline?.(args))?.content[0]?.text ??
                "timeline unavailable",
            ),
        ),
        leasedTool(
          "note",
          SETTLEMENT_NOTE_TOOL_DESCRIPTION,
          settlementTurnWriteInputShape,
          async (args: SettlementTurnWriteInput) => {
            // THE FACE, NOT THE SCHEMA — the mirror image of stage 1's own
            // `note` guard, and for its stated reason: the shape is shared, and
            // a settlement-only field list would fork the two surfaces'
            // vocabularies for one pass's sake. See
            // `STAGE_TWO_TURN_NOTE_FIELDS` for why this is an allowlist and
            // what a `tags` write would actually do to the frozen snapshots.
            const record = args as Record<string, unknown>;
            const sessionAddressed =
              typeof record.session === "string" && record.turn === undefined;
            const allowed = sessionAddressed
              ? STAGE_TWO_SESSION_NOTE_FIELDS
              : STAGE_TWO_TURN_NOTE_FIELDS;
            const refused = Object.keys(record).filter(
              (key) => record[key] !== undefined && !allowed.has(key),
            );
            if (refused.length > 0) {
              return textResult(
                sessionAddressed
                  ? `Parameter error: ${refused.join(", ")} ${
                      refused.length === 1 ? "is" : "are"
                    } refused on a session-addressed call from the edge pass — that address ` +
                      "writes this session's own narrative and nothing else. Address a turn to " +
                      "write its edges. Nothing was written."
                  : `Parameter error: ${refused.join(", ")} ${
                      refused.length === 1 ? "is" : "are"
                    } refused on the edge pass — a turn's note, type and tags are stage 1's ` +
                      "judgment, and it is settled. Your pen on a turn is its EDGES: declare one, " +
                      "retract a false one. Tags especially: membership is derived from that " +
                      "field, so writing it would move a turn between lanes underneath the " +
                      "frozen worklist, member lists and shape receipt this pass is reading — " +
                      "they would go on describing a partition that no longer exists. A lane " +
                      "that looks wrong to you is a later, explicit, user-ruled merge. This " +
                      "session's own narrative is a `session`-addressed call and stays yours. " +
                      "Nothing was written.",
              );
            }
            return writes.writeNote(args);
          },
        ),
        // THE IMPRESSION WRITE (lane-impressions ticket 10). The resume
        // dispatch is the path a reclaim takes after a crash between the
        // transition and the terminal commit, so it reaches the same `commit`
        // carrying the same duty — and a duty with no way to discharge it is a
        // deadlock, not a discipline. One action, and the registry verbs are
        // refused with the reason ticket 06 retired them for.
        leasedTool(
          "remember",
          SETTLEMENT_REMEMBER_TOOL_DESCRIPTION,
          settlementRememberInputShape,
          async (args: Record<string, unknown>) => {
            const action = args.action;
            if (action !== SETTLEMENT_IMPRESSION_ACTION) {
              return textResult(settlementRegistryClosedRefusal(action));
            }
            return textResult(impressions.maintainer.decide(options.db, args).text);
          },
        ),
        leasedTool(
          "commit",
          SETTLEMENT_COMMIT_TOOL_DESCRIPTION,
          // Settlement-commit-report ticket 01: `report` is required at the
          // schema layer (no `.optional()`), matching decision 1 literally —
          // but `writes.commit()` re-validates it itself regardless (absent,
          // empty, whitespace-only, over-cap), since the test harness that
          // drives this handler directly bypasses schema validation, and the
          // friendly, length-stating refusal text lives in that one place
          // rather than in whatever generic message a schema-validation
          // failure would produce.
          SETTLEMENT_COMMIT_INPUT_SHAPE,
          async (args: { report?: string }) => {
            // THE RETIRED ARGUMENT (lane-impressions ticket 10), answered
            // before anything else — a caller still composing its judgments
            // here needs to be told where judgments go.
            const retired = retiredImpressionsArgument(args);
            if (retired !== null) {
              return textResult(retired);
            }
            // THE COMMIT GATE (tag-mandate ticket 05), evaluated INSIDE
            // `writes.commit()`'s own write transaction since ticket 19 —
            // see the `evaluateTerminalGates` hook at this dispatch's engine
            // construction. A refusal there rolls that transaction back
            // before the completion CAS, so it still costs no attempt:
            // nothing touches the job row, the job stays `claimed` with its
            // attempt count untouched, and the agent may repair and call
            // `commit` again in this same run, like any other rejected tool
            // call. Attempts are consumed only where they always were — by
            // the dispatch layer, when a run ENDS without the job ever
            // reaching `done` (worker/note-settlement-dispatch.ts).
            //
            // Settlement-commit-report ticket 01 (decision 6, confirmed):
            // this refusal returns BEFORE `args.report` is ever read, so
            // nothing about it is stashed anywhere — the agent resends
            // `report` on the retry precisely because this call never
            // looked at the one it sent.
            //
            // Skipped once this run has already committed: `commit` is
            // idempotent within a run (the engine returns "Already
            // committed"), and re-judging a window whose job row is already
            // terminal would answer a question nothing can act on.
            const phaseConnectivityWindowIds =
              scopeHolder.current.scopeProvenance?.window ??
              scopeHolder.current.writableTurnIds;
            const appendReports = (
              text: string,
              extraLines: readonly string[] = [],
            ): { content: Array<{ type: "text"; text: string }> } => {
              const phaseReport = renderPhaseConnectivityReport(
                options.db,
                checkPhaseConnectivity(options.db, phaseConnectivityWindowIds),
              );
              const tail = [...extraLines, phaseReport].filter((line) => line !== "");
              return textResult(tail.length > 0 ? `${text}\n\n${tail.join("\n\n")}` : text);
            };
            terminalGateVerdict = null;
            // Round-5 P1: the shape/retraction artifacts reset WITH the
            // verdict, for the same reason — an idempotent repeat `commit`
            // returns "Already committed" without opening a transaction, so
            // `captureAtCommit` never runs and whatever the FIRST call left in
            // this closure would otherwise replay as if it were fresh output.
            // The rendering comment below promises "null here means this call
            // did not land the commit"; this reset is what makes that promise
            // true.
            terminalShape = null;
            terminalRetractions = [];
            impressions.clearRefused();
            const committed = await writes.commit(args.report);
            const committedText = committed.content[0]?.text ?? "";
            // A gate refusal comes back through `commit` verbatim; this layer
            // only re-attaches the phase-connectivity report it always did.
            // The shape and retraction blocks below are deliberately skipped:
            // the transaction rolled back, so `captureAtCommit` never ran and
            // there is no terminal state for them to describe. An impression
            // refusal (lane-impressions ticket 02) rolls the same transaction
            // back at the same point, so it takes the same branch.
            const gateVerdict = readTerminalGateVerdict();
            if ((gateVerdict !== null && !gateVerdict.ok) || impressions.wasRefused()) {
              // CASE 4 (ticket 05), on the REFUSAL and never on a landed
              // receipt. This branch is post-rollback — nothing was committed,
              // so a fail-closed answer here states a true fact. A receipt
              // describes a durable write, and replacing one with "the run
              // cannot proceed" would be the channel telling a lie; that
              // asymmetry is deliberate and is the limit of this guard.
              return protocolBoundedResult(
                appendReports(committedText).content[0]!.text,
                "commit",
              );
            }
            const dispositionWarnings: readonly string[] =
              gateVerdict === null ? [] : gateVerdict.warnings;
            // THE COMMIT REPORT'S SHAPE HALF (staged-settlement spec Rev 5,
            // §Shape numbers v1 + §Homeless record). These numbers audit the
            // partition this run settled, so they must describe the state the
            // commit made DURABLE — which is why they are captured inside the
            // terminal transaction (`captureAtCommit` above) rather than read
            // back here. Read after the fact they were a plain look at the live
            // edge table, in which a writer that landed between the commit and
            // this line is already visible: the receipt would then describe a
            // graph this job never settled, with nothing in it to say so.
            //
            // Both blocks are read from the JOB's own frozen record and are
            // therefore empty and silent for a job that never transitioned —
            // no worklist, no lanes to project, no dispositions to have caused
            // a retraction. `null` here means this call did not land the
            // commit (a repeat call on an already-committed run), and the
            // blocks stay silent for the same reason.
            const shapeReport = terminalShape
              ? renderSettlementShapeNumbers(terminalShape)
              : "";
            const retractionReport = renderSettlementHomelessRetractions(
              options.db,
              terminalRetractions,
            );
            return appendReports(committedText, [
              ...dispositionWarnings,
              shapeReport,
              retractionReport,
            ]);
          },
        ),
        leasedTool(
          "lane_check",
          SETTLEMENT_LANE_CHECK_TOOL_DESCRIPTION,
          SETTLEMENT_LANE_CHECK_TOOL_SHAPE,
          async (args: { page?: number; pageBudget?: number }) => {
            laneCheckCalled = true;
            // ONE EVALUATION FOR BOTH HALVES OF THIS RESULT (ticket 03). The
            // paged report below and the LANE DISPOSITION block under it are
            // two renderings of THIS value. They used to be two computations
            // with two different scope rules — the render projected to the
            // writable set, the disposition block re-ran the gate unprojected
            // — so one call could print a clean connectivity section above a
            // demand to repair a lane that section had just declined to
            // describe. That is the disagreement job 166's own abandonment
            // note named.
            //
            // The SAME pass the commit gate runs (ticket 05): the preview and
            // the verdict are one projection, so the list this prints cannot
            // differ from the list `commit` judges. Ticket 06 additionally
            // hands the render that projection's turns, so an anchor prints as
            // `S<session>/T<prompt>` — the address the repair call itself
            // takes, matching the commit refusal's own vocabulary.
            //
            // "ACTIONABLE" IS THE WRITABLE SET (peer round three finding 04,
            // user ruling [S15069/T1778]) — the same set the commit gate
            // filters by, applied inside `evaluateWindowLanes`. Ticket 06 had
            // scoped it to `scopeProvenance.window`, which hid an error
            // anchored on a declared-lookback or closure turn by default and
            // then refused the commit over it.
            const scope = projectionScope();
            const runTouches = writes.getRunLaneTouches();
            // FAIL CLOSED (ticket 03, typed by ticket 05): no descriptor, no
            // coherent descriptor, or an evaluator disagreeing with itself
            // means no projection — so no report. Returned INSTEAD of a report,
            // never alongside one.
            const judgment = judgeSettlementWindow(
              options.db,
              scope,
              scopeHolder.current.scopeProvenance,
              runTouches.turnIds,
            );
            if (!judgment.ok) {
              return textResult(raiseSystemFailure(judgment.failure, "lane_check"));
            }
            const evaluation = judgment.evaluation;
            const { result, turns } = evaluation;
            // Settlement-ergonomics ticket 05: paged and aggregated, never
            // the plain uncapped render — see `renderLaneCheckerReportsPaged`'s
            // own doc for why a SEPARATE entry point exists rather than a
            // change to `renderLaneCheckerReports` itself (the CLI/console
            // still call that one, unbounded, on purpose).
            //
            // TICKET 04: the render is handed THE SAME class predicate the
            // commit gate obeys, so the ERRORS section it prints is exactly the
            // list `commit` would refuse over and the demoted findings sit
            // under the warnings header. The preview cannot show one class and
            // the verdict judge another.
            const paged = renderLaneCheckerReportsPaged(result, buildLaneAnchorAddresses(turns), {
              page: args.page,
              pageBudget: args.pageBudget,
              classifyError: laneCheckErrorClassifier(evaluation, scope),
            });
            // Ticket 01 (phase connectivity, report-only) + ticket 02 (lane
            // disposition, MANDATORY at `commit` — shown here too so the
            // agent can see what would refuse before it ever calls
            // `commit`). Appended only on page 1: these are not themselves
            // paginated, and repeating them on every page of an already-long
            // lane report would waste budget the pagination contract exists
            // to protect.
            const extraSections: string[] = [];
            if ((args.page ?? 1) === 1) {
              const phaseReport = renderPhaseConnectivityReport(
                options.db,
                checkPhaseConnectivity(
                  options.db,
                  scopeHolder.current.scopeProvenance?.window ??
                    scopeHolder.current.writableTurnIds,
                ),
              );
              if (phaseReport) {
                extraSections.push(phaseReport);
              }
              const disposition = evaluateLaneDispositionGate(
                options.db,
                evaluation,
                runTouches,
                scope,
              );
              if (disposition.blocking.length > 0) {
                extraSections.push(
                  [
                    `LANE DISPOSITION (blocking at commit; ${disposition.blocking.length} ` +
                      "fracture(s) touched by this run still owe a disposition):",
                    ...disposition.blocking.map((line) => `  ${line}`),
                  ].join("\n"),
                );
              }
              extraSections.push(...disposition.warnings);
            }
            const text = extraSections.length > 0 ? `${paged.text}\n\n${extraSections.join("\n\n")}` : paged.text;
            // CASE 4, asked on the bytes the protocol is about to carry — after
            // the unpaged tail blocks, which are what pushed the real results
            // over. A page that does not fit is a SYSTEM FAILURE and never a
            // truncated report: the harness's own fallback saves the overflow
            // to a file and instructs the run to read all of it back, which is
            // the paid round trip this batch exists to remove.
            return protocolBoundedResult(text, "lane_check");
          },
        ),
      ],
    });

    try {
      const execution = queryImpl({
        prompt: request.prompt,
        options: {
          model: request.model,
          cwd: options.dataRoot,
          // The bundled CJS worker breaks the SDK's import.meta.url CLI
          // resolution; resolve explicitly, same as diary/query-session.
          pathToClaudeCodeExecutable: resolveClaudeCodeExecutablePath(),
          env: {
            ...(options.agentEnv ?? buildIsolatedEnv(process.env, {})),
            // One short burst with no cross-run reuse: the 1h cache would pay
            // the write premium for nothing.
            FORCE_PROMPT_CACHING_5M: "1",
          },
          tools: [],
          allowedTools: [...SETTLEMENT_ALLOWED_TOOLS],
          mcpServers: { mnemo: server },
          hooks: { Stop: [{ hooks: [stopHook] }] },
          abortController,
          systemPrompt: request.systemPrompt,
          // Ticket 01: omit the SDK option entirely rather than pass an
          // undefined-valued key when unconfigured (null or absent).
          ...(request.maxThinkingTokens != null
        ? { maxThinkingTokens: request.maxThinkingTokens }
        : {}),
        },
      });

      let envelope: string | null = null;
      for await (const message of execution as AsyncIterable<SDKMessage>) {
        // TICKET 01: the round-boundary observation — see
        // `note-settlement-response-origin.ts`. Every OTHER message type
        // (partial deltas, user/tool-result echoes, system/status messages)
        // carries no `tool_use` id of its own to freeze, so only `assistant`
        // is worth a branch here.
        if (message.type === "assistant") {
          observeSdkAssistantMessage(originRegistry, message);
          continue;
        }
        if (message.type !== "result") {
          continue;
        }
        if (message.subtype !== "success" || message.is_error) {
          throw new Error(
            `note settlement query failed (${message.subtype})`,
          );
        }
        envelope = message.result;
      }
      // The stream has fully drained — whichever response was still open
      // when it did is now closed, so anything still waiting on it resolves
      // "unknown" rather than hanging on the deadline alone.
      originRegistry.closeResponse();

      if (envelope === null) {
        throw new Error("note settlement query returned no result envelope");
      }
      // Ticket 10c (carried into ticket 05's direct-write engine):
      // `commitMetrics` is read ONCE, here, after the model's run has fully
      // ended (every message drained above) — never during it, and never
      // through a tool the model could call. This is what makes it safe
      // under spec G9 (invisible to the grading agent at every point in its
      // run): the value did not exist anywhere the model could observe it
      // until this line.
      return {
        text: envelope,
        commitMetrics: writes.getLastCommitMetrics(),
        laneCheckCalled,
      };
    } finally {
      // Disposal is the harder failure (rejects, never resolves "unknown") —
      // appropriate here because `finally` also runs on a thrown exception,
      // where `closeResponse` above never got the chance to run at all.
      originRegistry.dispose();
      if (request.signal) {
        request.signal.removeEventListener("abort", forwardAbort);
      }
    }
  };
}

// =============================================================================
// THE UNIFIED RUN (settlement-execution-repair spec Rev 5, §Implementation
// decisions 1 + the ARMING half of 3(a); ticket 03). ONE registration site
// carrying the union toolset, driven by ONE stage-neutral prompt
// (`note-settlement-unified-prompt.ts`) — the topic pass and the edge pass in
// one SDK session, one context, one cache.
//
// WHERE THIS LIVES, AND WHY IT IS NOT A THIRD FILE. The stage-2-shaped half of
// every write face below (the edge allowlist, the commit gate, the lane-
// disposition gate, the phase-connectivity report, `lane_check`) is this
// file's own private machinery, already built for `createNoteSettlementSdkQuery`
// above — `checkWindowLanes`, `evaluateSettlementCommitGate`,
// `evaluateLaneDispositionGate`, `checkPhaseConnectivity`,
// `renderPhaseConnectivityReport`, `STAGE_TWO_TURN_NOTE_FIELDS`,
// `STAGE_TWO_SESSION_NOTE_FIELDS`, `installSettlementEdgesScope`. A new file
// would either duplicate every one of them or export them all outward for a
// single caller. The topic-pass-shaped half is imported instead, from
// `note-settlement-stage1.ts`'s own exported gate/projection functions
// (`evaluateStageOneTransitionGate`, `collectStageOneProjection`,
// `checkStageOneLaneTag`, `homelessMemberFingerprint`, `resolveWritableTurn`)
// — functions stage 1's own standalone registration used to call too (ticket
// 04 retired that registration site, `note-settlement-stage1.ts`'s
// `createNoteSettlementStageOneSdkQuery`, once the scheduler was rewired onto
// this union site alone — "no duplicated tool() call sites remain" is now
// true of the registration itself, not merely of the GATE/PROJECTION/
// FIELD-SET logic those functions still share as the one implementation
// beneath both this file and note-settlement-stage1.ts's surviving pure
// helpers).
//
// WRITE CAPABILITY IS THE CALL'S OWN ORIGIN, NEVER THE ROW READ FRESH (spec
// 3(a), literally: "bound to the stage the call ORIGINATED under, never to the
// row's stage at execution time"). Every write face below resolves its call's
// origin through ticket 01's registry FIRST, and that resolved value — never a
// second, live read of `note_settlement_jobs.stage` — is what decides which
// shape of behaviour applies and what gets stamped into
// `SettlementTurnFacadeContext.stage` for the write engine's own
// `assertNoteSettlementJobClaimed` fence to check "together with the durable
// row" (the ticket's own phrase): that fence, unchanged from every other
// settlement write path, throws the moment a call's believed stage stops
// matching the job row's actual one — which a stale same-response sibling
// call, held at its pre-transition origin, now reliably does.
// =============================================================================

/**
 * The write faces' shared vocabulary for "this call's stage could not be
 * bound" (registry says `"unknown"`) — FAILS CLOSED, never a guess and never
 * a fallback to the durable row alone (spec 3(a)'s own words). Every
 * stage-gated write face reaches this through the same sentence shape so an
 * agent meeting it on `note` reads the same fact it would meet on `commit`.
 */
function unifiedUnknownOriginRefusal(nothingClause: string): string {
  return (
    "Parameter error: this call's own pass could not be determined, so it is refused rather than " +
    `guessed — an unresolved call never inherits authority from the job row alone. ${nothingClause} ` +
    "Retry the call in your next response."
  );
}

/**
 * The SAME-RESPONSE SIBLING shape (spec 3(a); ticket 03's own pinned
 * decision): a call composed in the SAME assistant response as a `finalize`
 * that already succeeded keeps ITS OWN pre-transition origin — the response-
 * origin registry freezes a message's mapping once, immutably — so it is
 * refused with this exact reasoning rather than the plain "call finalize
 * first" text a genuinely pre-finalize call gets. Edge-pass capability begins
 * only with the first NEW assistant message id.
 */
function unifiedSiblingRefusal(nothingClause: string): string {
  return (
    "Refused — stage advanced mid-response: your own `finalize` earlier in THIS SAME response " +
    "already succeeded, and this call was composed alongside it, so it still carries the pass you " +
    `were in before that call landed. ${nothingClause} Read finalize's own result, then re-issue ` +
    "this exact call in your NEXT response."
  );
}

/**
 * The union toolset (spec decision 1) — every face either pass ever reaches,
 * registered ONCE. `commit`/`lane_check` are present from the run's first
 * message; their own handlers below are what makes them unreachable before
 * `finalize`, not their absence from this list.
 */
export const NOTE_SETTLEMENT_UNIFIED_ALLOWED_TOOLS = [
  "mcp__mnemo__recall",
  "mcp__mnemo__timeline",
  "mcp__mnemo__note",
  "mcp__mnemo__remember",
  "mcp__mnemo__finalize",
  "mcp__mnemo__commit",
  "mcp__mnemo__lane_check",
] as const;

export const UNIFIED_NOTE_TOOL_DESCRIPTION =
  "WRITE a turn's fields — lands immediately, in this same call. BEFORE your " +
  "own `finalize` has succeeded: title/content/insight, type and tags — the " +
  "topic pass's own fields, judged by the Memory Rubric in your prompt; the " +
  "seven relation fields and their retract… mirrors are refused, naming the " +
  "edge pass you have not reached yet. Tags are the projection: a whole-set " +
  "`tags` write states the turn's task tag, every lane it belongs to and " +
  "every `topic:` word — a lane word left out is REMOVED, a `topic:` word " +
  "left out is refused (use `retireTopic` to correct one). AFTER `finalize` " +
  "has succeeded: the fourteen edge fields only (the seven relations and " +
  "their retract… mirrors) on a turn address, or `title`/`content` on this " +
  "session's own `session` address — title/content/insight/type/tags are " +
  "refused on a turn address, because that judgment is now your own settled " +
  "one and `tags` especially would move a turn between lanes underneath the " +
  "worklist `finalize` froze. `turn` is an \"S<session>/T<prompt>\" address " +
  "from the writable set your prompt declares; omit a field to leave it " +
  "alone. A field that already holds something needs `mode.<field>: " +
  "\"write\"` (the full replacement value) or the edit form `{ mode: " +
  "\"edit\", oldString, newString }`. A call composed in the SAME response as " +
  "a successful `finalize`, before you have seen a new response of your own, " +
  "is refused naming that — read finalize's result first.";

export const UNIFIED_REMEMBER_TOOL_DESCRIPTION =
  "DECLARE a lane — lands immediately, in this same call. This tool belongs " +
  "to the TOPIC PASS only: BEFORE your own `finalize`, action \"create\" or " +
  "\"delete\". A lane is (task, ONE tag); `create` needs a canonical tag " +
  "carrying no phase word (research/design/implement/fix/review/verification " +
  "and their families are refused, naming the offending word). `merge` is " +
  "refused in both passes — folding two lanes into one is the user's own " +
  "explicit call, made later. " +
  // Settlement-gate-taxonomy ticket 06 (user ruling S15069/T2278) emptied the
  // edge pass's half of this tool: `justify` was its one action and it retired
  // with the gate it answered. Lane-impressions ticket 10 refilled it with one
  // action of a different kind — the registry is still frozen, but the edge
  // pass now writes the CONTAINER STATE its own adjudication produces.
  "AFTER `finalize` THE LANE REGISTRY IS CLOSED — create, delete and merge are " +
  "all refused there: the registry is the topic pass's own settled judgment, " +
  "frozen by your transition. A severed lane owes you nothing there — it is a " +
  "WARNING on `lane_check` and on your commit receipt naming a stitch target, " +
  "it blocks no commit, and there is no disposition to file for it. What this " +
  'tool DOES hold after `finalize` is one action: "impression". ' +
  SETTLEMENT_REMEMBER_IMPRESSION_DESCRIPTION;

export const UNIFIED_FINALIZE_TOOL_DESCRIPTION =
  "END the topic pass and open the edge pass, IN THIS SAME RUN — lands " +
  "immediately, in this same call, and runs at most once. Call it once the " +
  "whole writable set is audited, every window turn carries a `topic:` word, " +
  "and the final projection is written. It freezes what the edge pass may " +
  "read — the writable set, the (task, lane) worklist your projection " +
  "touched, each of those lanes' members, and the lane words your projection " +
  "REMOVED — and records any homeless group per member. Its own result is " +
  "DATA ONLY: the frozen writable set, worklist, removed-side debts and " +
  "homeless groups, printed as facts — every instruction for what to do with " +
  "them already lives in your prompt. It marks nothing done and grants " +
  "nothing; only your own later `commit` publishes. " +
  "Takes `summary` (string, REQUIRED, max 1000 characters): the lines you " +
  "found, which were existing lanes and which are new, and where this window " +
  "forced a guess. " +
  "Takes `homeless` (optional): one entry per group of turns whose subject " +
  "has no legal task to live in — `label`, `reason` and `turns` (member " +
  "addresses). Never open a task or mint a lane to avoid this list. " +
  "REFUSES while a turn in your writable set has an empty or " +
  "out-of-vocabulary `type`, or a window turn carries no `topic:` word. A " +
  "refusal costs nothing and is not a failed attempt: repair and call it " +
  "again in this same run. Refused outright once you are already in the " +
  "edge pass — it runs once.";

export const UNIFIED_COMMIT_TOOL_DESCRIPTION =
  "Finish this window's edge pass — reachable ONLY after your own `finalize` " +
  "has succeeded; calling it before that refuses, naming `finalize` as what " +
  "you still owe. " +
  SETTLEMENT_COMMIT_TOOL_DESCRIPTION;

export interface NoteSettlementUnifiedQueryRequest {
  prompt: string;
  systemPrompt: string;
  model: string;
  maxThinkingTokens?: number | null;
  signal?: AbortSignal;
  jobId: number;
  claimGeneration: number;
  /** Always `"topics"` in production — the unified run only ever begins the topic pass. */
  stage: NoteSettlementStage;
  sessionId: number;
  writableTurnIds: ReadonlySet<number>;
  scopeProvenance: SettlementScopeProvenance;
  contextBuiltAtEpoch: number;
  windowStart: number;
  windowEnd: number;
}

export interface NoteSettlementUnifiedQueryResult {
  text: string;
  /** Did THIS run's own `finalize` land the transition? Advisory — the row is the authority. */
  finalized: boolean;
  commitMetrics: NoteSettlementCommitRecord | null;
  laneCheckCalled: boolean;
}

export type NoteSettlementUnifiedQuery = (
  request: NoteSettlementUnifiedQueryRequest,
) => Promise<NoteSettlementUnifiedQueryResult>;

export interface CreateUnifiedNoteSettlementSdkQueryOptions {
  db: Database;
  dataRoot: string;
  defaultProject?: string;
  queryImpl?: typeof query;
  createSdkMcpServerImpl?: typeof createSdkMcpServer;
  toolImpl?: typeof tool;
  agentEnv?: NodeJS.ProcessEnv;
  now?: () => number;
  runWriteTransaction?: typeof runWriteTransaction;
  /** Test seam only — see the same option on the two single-stage query builders above. */
  originRegistry?: ResponseOriginRegistry;
  /**
   * THE CLAIMED-SET SEAM (lane-impressions ticket 02's own boundary — the claim
   * machinery and the debt writers are ticket 03). Threaded straight to
   * `createSettlementImpressionMaintainer`; the default claims nothing.
   */
  claimImpressionDebts?: SettlementImpressionMaintainerOptions["claimImpressionDebts"];
  /** THE THIRD CHANNEL's two test seams (settlement-gate-taxonomy ticket 05) — see `SettlementSystemFailureOptions`. Production supplies neither. */
  systemFailure?: SettlementSystemFailureOptions;
}

/**
 * THE UNIFIED RUN'S QUERY SEAM — ticket 03's whole deliverable. Not wired to
 * the scheduler (that is ticket 04's territory and this ticket's own pinned
 * "does not touch the scheduler" boundary); exercised directly by
 * `tests/worker/staged-settlement-unified-run.test.ts` through the same
 * `queryImpl`-swap idiom the rest of this batch uses.
 */
export function createUnifiedNoteSettlementSdkQuery(
  options: CreateUnifiedNoteSettlementSdkQueryOptions,
): NoteSettlementUnifiedQuery {
  const queryImpl = options.queryImpl ?? query;
  const createSdkMcpServerImpl =
    options.createSdkMcpServerImpl ?? createSdkMcpServer;
  const toolImpl = options.toolImpl ?? tool;
  const nowEpoch = options.now ?? (() => Math.floor(Date.now() / 1000));
  const handlers = createDatabaseBackedHandlers(options.db, {
    defaultProject: options.defaultProject,
    audience: "worker",
  });

  return async (
    request: NoteSettlementUnifiedQueryRequest,
  ): Promise<NoteSettlementUnifiedQueryResult> => {
    const abortController = new AbortController();

    const originRegistry =
      options.originRegistry ??
      createResponseOriginRegistry({
        readStage: () => getNoteSettlementJob(options.db, request.jobId)?.stage ?? null,
      });
    abortController.signal.addEventListener(
      "abort",
      () => originRegistry.abort(),
      { once: true },
    );

    const forwardAbort = (): void => {
      abortController.abort(request.signal?.reason);
    };
    if (request.signal) {
      if (request.signal.aborted) {
        forwardAbort();
      } else {
        request.signal.addEventListener("abort", forwardAbort, { once: true });
      }
    }

    // THE PRE-RUN TAG SNAPSHOT (note-settlement-stage1.ts's own module
    // header): the one input to `removedLanes` that cannot be reconstructed
    // after the projection lands. Taken here, before a single tool is
    // registered, exactly like stage 1's own standalone dispatch.
    const priorTagsByTurn = new Map<number, readonly string[]>();
    for (const turnId of request.writableTurnIds) {
      priorTagsByTurn.set(turnId, getTurnById(options.db, turnId)?.tags ?? []);
    }

    // THE FROZEN-SCOPE HANDOFF SEAM (ticket 02). At construction the
    // transition has not run, so `readSettlementFrozenScope` returns `null`
    // and the live-computed fallback stands — the topic pass's own authority,
    // identical to stage 1's standalone dispatch. `finalize`'s own handler
    // below calls this SAME function again, passing this SAME holder, the
    // instant its transition transaction commits — swapping every closure
    // that reads `scopeHolder.current` onto the frozen edge-pass scope with
    // no engine rebuild.
    const scopeHolder = installSettlementEdgesScope(options.db, request.jobId, {
      writableTurnIds: request.writableTurnIds,
      scopeProvenance: request.scopeProvenance,
    });
    /** ONE scope descriptor for every checker call this request makes — see the legacy builder's identical closure for why it is a function and not a value. */
    const projectionScope = (): SettlementProjectionScope => ({
      writableTurnIds: scopeHolder.current.writableTurnIds,
      writableProvenance: scopeHolder.current.writableProvenance,
      judgment: {
        sessionId: request.sessionId,
        windowStart: request.windowStart,
        windowEnd: request.windowEnd,
      },
    });
    /** THE THIRD CHANNEL, per request — identical to the legacy builder's own pair above; see its comment. */
    const systemFailureSink = options.systemFailure?.sink ?? logSettlementSystemFailure;
    const resultTokenCeiling =
      options.systemFailure?.resultTokenCeiling ?? SETTLEMENT_RESULT_TOKEN_CEILING;
    const raiseSystemFailure = (
      failure: SettlementSystemFailure,
      surface: "lane_check" | "commit",
    ): string => {
      systemFailureSink(failure, {
        surface,
        jobId: request.jobId,
        claimGeneration: request.claimGeneration,
      });
      return renderSettlementSystemFailure(failure);
    };
    const protocolBoundedResult = (
      text: string,
      surface: "lane_check" | "commit",
    ): { content: Array<{ type: "text"; text: string }> } => {
      const failure = overProtocolResultFailure(text, resultTokenCeiling);
      return failure === null
        ? textResult(text)
        : textResult(raiseSystemFailure(failure, surface));
    };

    // THE CALL'S OWN BELIEVED STAGE (spec 3(a)) — set by the `leasedTool`
    // wrapper below from EVERY call's own resolved origin, and read by three
    // things: the lease heartbeat, the reader identity `recall` records its
    // grants under, and `SettlementTurnFacadeContext.stage` (a getter, so the
    // write engine — built once, held by reference — always reads THIS
    // call's value, never a value copied out at construction). A shared box
    // is safe here because every call within one assistant response shares
    // one frozen origin by construction (ticket 01), and a write face never
    // reaches the engine at all when its OWN resolved origin is `"unknown"`
    // or a stale same-response sibling — see `unifiedUnknownOriginRefusal`/
    // `unifiedSiblingRefusal` below.
    const identityStage: { current: NoteSettlementStage } = { current: request.stage };

    const turnFacadeContext: SettlementTurnFacadeContext = {
      jobId: request.jobId,
      claimGeneration: request.claimGeneration,
      get stage() {
        return identityStage.current;
      },
      sessionId: request.sessionId,
      get writableProvenance() {
        return scopeHolder.current.writableProvenance;
      },
      get reviewableTurnIds() {
        return scopeHolder.current.writableTurnIds;
      },
      contextBuiltAtEpoch: request.contextBuiltAtEpoch,
    };
    const readHandlers = createDatabaseBackedHandlers(options.db, {
      defaultProject: options.defaultProject,
      audience: "worker",
      // Ticket 03: the reader identity is THIS CALL's own believed stage, not
      // a value fixed at construction — a `recall` made after `finalize` has
      // succeeded records its grant under the edge pass's own writer
      // identity, exactly as a cold stage-2 dispatch's `recall` would.
      resolveReaderId: () => claimWriterId(request.jobId, request.claimGeneration, identityStage.current),
      ...(options.now ? { now: options.now } : {}),
    });

    let terminalShape: SettlementShapeNumbers | null = null;
    let terminalRetractions: SettlementHomelessRetraction[] = [];
    let terminalGateVerdict: SettlementTerminalGateVerdict | null = null;
    const readTerminalGateVerdict = (): SettlementTerminalGateVerdict | null => terminalGateVerdict;

    // THE IMPRESSION OBLIGATION (lane-impressions ticket 02). Reads the writable
    // set through `scopeHolder` rather than off `request`, so the anchor
    // -invalidation check and the advisory both narrow to the FROZEN edge-pass
    // scope the instant `finalize` swaps it in.
    const impressions = wireSettlementImpressions({
      db: options.db,
      jobId: request.jobId,
      // THE LEASE, for the impression WRITE (ticket 10) — read through the same
      // `identityStage` box the write engine's own context reads, so a decision
      // recorded after `finalize` is fenced under the stage that call actually
      // originated in rather than the one this closure was built under.
      claimGeneration: request.claimGeneration,
      readStage: () => identityStage.current,
      readWritableTurnIds: () => scopeHolder.current.writableTurnIds,
      // THE REAL CLAIM (lane-impressions ticket 03) — same wiring as the resume
      // builder above, for the same reason it is not symmetry for its own sake:
      // both shapes reach one terminal commit carrying one obligation.
      claimImpressionDebts:
        options.claimImpressionDebts ??
        createAttachedImpressionDebtClaimer({
          jobId: request.jobId,
          sessionId: request.sessionId,
          now: nowEpoch,
        }),
      ...(options.now ? { now: options.now } : {}),
    });

    const writes = createSettlementDirectWriteEngine({
      db: options.db,
      context: turnFacadeContext,
      now: options.now,
      settleImpressions: impressions.settleImpressions,
      ...(options.runWriteTransaction ? { runWriteTransaction: options.runWriteTransaction } : {}),
      captureAtCommit: (db) => {
        terminalShape = computeSettlementShapeNumbers(db, request.jobId);
        terminalRetractions = collectSettlementHomelessRetractions(
          db,
          request.jobId,
          scopeHolder.current.writableTurnIds,
        );
      },
      evaluateTerminalGates: (db) => {
        // Ticket 03, typed by ticket 05 — identical to the legacy builder's own
        // gate above; see its comment for why the failure rides its own verdict
        // arm rather than a refusal's.
        const scope = projectionScope();
        const runTouches = writes.getRunLaneTouches();
        const judgment = judgeSettlementWindow(
          db,
          scope,
          scopeHolder.current.scopeProvenance,
          runTouches.turnIds,
        );
        if (!judgment.ok) {
          raiseSystemFailure(judgment.failure, "commit");
          terminalGateVerdict = { ok: false, systemFailure: judgment.failure };
          return terminalGateVerdict;
        }
        const evaluation = judgment.evaluation;
        const refusal = renderSettlementCommitGateRefusal(
          db,
          evaluation,
          scope,
          scopeHolder.current.scopeProvenance,
        );
        if (refusal !== null) {
          terminalGateVerdict = { ok: false, refusal };
          return terminalGateVerdict;
        }
        const disposition = evaluateLaneDispositionGate(db, evaluation, runTouches, scope);
        if (disposition.blocking.length > 0) {
          terminalGateVerdict = {
            ok: false,
            refusal: [
              `Commit refused — ${disposition.blocking.length} severed lane fracture(s) touched by ` +
                "this run still owe a disposition. NOTHING was committed and this is NOT a failed " +
                "attempt: repair these and call `commit` again in this same run.",
              ...disposition.blocking.map((line) => `  ${line}`),
            ].join("\n"),
          };
          return terminalGateVerdict;
        }
        terminalGateVerdict = { ok: true, warnings: disposition.warnings };
        return terminalGateVerdict;
      },
      windowStart: request.windowStart,
      windowEnd: request.windowEnd,
    });

    const stopHook = createSettlementStopHook({
      db: options.db,
      jobId: request.jobId,
      claimGeneration: request.claimGeneration,
    });

    let finalized = false;
    let laneCheckCalled = false;

    /** Every write face's shared origin-resolution preamble — three outcomes: sibling, unknown, or a real (pre/post-transition) origin to dispatch on. */
    type OriginDecision =
      | { kind: "sibling" }
      | { kind: "unknown" }
      | { kind: "resolved"; origin: "topics" | "edges" };
    function decideOrigin(origin: ResponseOrigin): OriginDecision {
      if (origin === "unknown") {
        return { kind: "unknown" };
      }
      if (origin === "topics" && finalized) {
        return { kind: "sibling" };
      }
      return { kind: "resolved", origin };
    }

    // Resolved and cached per call, keyed by `resolveResponseOrigin`'s own
    // registry lookup (already-mapped ids resolve synchronously) — called
    // here for the lease heartbeat's sake, and again inside whichever
    // write-face handler needs a typed `ResponseOrigin` value, at no real
    // extra cost.
    const touchIdentityStage = async (extra: unknown): Promise<void> => {
      const origin = await resolveResponseOrigin(originRegistry, extra);
      if (origin !== "unknown") {
        identityStage.current = origin;
      }
      touchNoteSettlementJobLease(
        options.db,
        request.jobId,
        request.claimGeneration,
        nowEpoch(),
        identityStage.current,
      );
    };

    const leasedTool = ((
      name: string,
      description: string,
      shape: unknown,
      handler: (args: Record<string, unknown>, extra: unknown) => unknown,
    ) =>
      toolImpl(
        name as never,
        description as never,
        shape as never,
        (async (args: Record<string, unknown>, extra: unknown) => {
          await touchIdentityStage(extra);
          return handler(args, extra);
        }) as never,
      )) as unknown as typeof toolImpl;

    const server = createSdkMcpServerImpl({
      name: "mnemo",
      version: "0.29.0",
      tools: [
        leasedTool(
          "recall",
          MNEMO_TOOL_DESCRIPTIONS.recall,
          workerRecallInputShape,
          async (args: Record<string, unknown>) =>
            (await readHandlers.recall?.(args)) ?? textResult("recall unavailable"),
        ),
        leasedTool(
          "timeline",
          MNEMO_TOOL_DESCRIPTIONS.timeline,
          timelineInputShape,
          async (args: Record<string, unknown>) =>
            textResult(
              (await handlers.timeline?.(args))?.content[0]?.text ?? "timeline unavailable",
            ),
        ),
        leasedTool(
          "note",
          UNIFIED_NOTE_TOOL_DESCRIPTION,
          settlementTurnWriteInputShape,
          async (args: SettlementTurnWriteInput, extra: unknown) => {
            const origin = await resolveResponseOrigin(originRegistry, extra);
            const decision = decideOrigin(origin);
            if (decision.kind === "unknown") {
              return textResult(unifiedUnknownOriginRefusal("Nothing was written."));
            }
            if (decision.kind === "sibling") {
              return textResult(unifiedSiblingRefusal("Nothing was written."));
            }
            if (decision.origin === "topics") {
              const reached = [...RELATION_FIELD_ENTRIES, ...RETRACTION_FIELD_ENTRIES]
                .map(([key]) => key)
                .filter((key) => (args as Record<string, unknown>)[key] !== undefined);
              if (reached.length > 0) {
                return textResult(
                  `Parameter error: ${reached.join(", ")} ${
                    reached.length === 1 ? "is" : "are"
                  } refused before your own \`finalize\` — edges belong to the edge pass, which you ` +
                    "reach only once finalize succeeds. Nothing was written.",
                );
              }
              return writes.writeNote(args);
            }
            // origin === "edges": the edge-pass allowlist.
            const record = args as Record<string, unknown>;
            const sessionAddressed =
              typeof record.session === "string" && record.turn === undefined;
            const allowed = sessionAddressed
              ? STAGE_TWO_SESSION_NOTE_FIELDS
              : STAGE_TWO_TURN_NOTE_FIELDS;
            const refused = Object.keys(record).filter(
              (key) => record[key] !== undefined && !allowed.has(key),
            );
            if (refused.length > 0) {
              return textResult(
                sessionAddressed
                  ? `Parameter error: ${refused.join(", ")} ${
                      refused.length === 1 ? "is" : "are"
                    } refused on a session-addressed call from the edge pass — that address writes ` +
                      "this session's own narrative and nothing else. Nothing was written."
                  : `Parameter error: ${refused.join(", ")} ${
                      refused.length === 1 ? "is" : "are"
                    } refused in the edge pass — a turn's note, type and tags are the topic pass's ` +
                      "settled judgment. Your pen on a turn is now its EDGES: declare one, retract a " +
                      "false one. This session's own narrative is a `session`-addressed call and " +
                      "stays yours. Nothing was written.",
              );
            }
            return writes.writeNote(args);
          },
        ),
        leasedTool(
          "remember",
          UNIFIED_REMEMBER_TOOL_DESCRIPTION,
          settlementRememberInputShape,
          async (args: SettlementRememberInput, extra: unknown) => {
            const origin = await resolveResponseOrigin(originRegistry, extra);
            const decision = decideOrigin(origin);
            if (decision.kind === "unknown") {
              return textResult(unifiedUnknownOriginRefusal("Nothing was written."));
            }
            if (decision.kind === "sibling") {
              return textResult(unifiedSiblingRefusal("Nothing was written."));
            }
            const action = (args as { action?: string }).action;
            if (decision.origin === "topics") {
              // THE IMPRESSION IS THE EDGE PASS'S (lane-impressions ticket 10).
              // Not a policy: the coordinates an impression decision is fenced
              // on — the touched set, each container's cap and its membership
              // digest — are born in this run's own `finalize` transaction and
              // do not exist yet. A decision here would be made against nothing.
              if (action === SETTLEMENT_IMPRESSION_ACTION) {
                return textResult(
                  "Parameter error: impression is refused before your own `finalize` — the " +
                    "containers you owe a judgment on, their current text and their caps are " +
                    "frozen by that transition and printed on its result. Read them first. " +
                    "Nothing was written.",
                );
              }
              if (action === "merge") {
                return textResult(
                  "Parameter error: merge is refused before your own finalize. Folding two lanes " +
                    "into one is the user's own explicit call, made later. Nothing was written.",
                );
              }
              // TICKET 06: `justify` no longer needs a branch of its own here.
              // It is not in `SETTLEMENT_LANE_ACTIONS` any more, so the schema
              // refuses it and the facade's own retirement map answers the
              // hand-rolled path with the one sentence that matters — a
              // severed lane owes nothing. A per-origin refusal here would say
              // "not yet" about a verb that is never coming.
              if (action === "create") {
                const rawTag = (args as { tag?: unknown }).tag;
                if (typeof rawTag === "string") {
                  const refusal = checkStageOneLaneTag(rawTag);
                  if (refusal !== null) {
                    return textResult(`Parameter error: ${refusal}`);
                  }
                }
              }
              // The impression action is answered above, so what reaches the
              // registry facade here is exactly its own three verbs.
              return writes.writeMembership(args as SettlementMembershipWriteInput);
            }
            // origin === "edges": ONE action survives (lane-impressions ticket
            // 10). The lane REGISTRY is still closed — ticket 06's finding is
            // untouched, and its refusal is still unconditional rather than a
            // denylist, so a registry action added to the facade tomorrow
            // cannot leak in by omission. What the edge pass writes here is
            // the container state its own adjudication produced.
            if (action === SETTLEMENT_IMPRESSION_ACTION) {
              return textResult(
                impressions.maintainer.decide(options.db, args as Record<string, unknown>).text,
              );
            }
            return textResult(settlementRegistryClosedRefusal(action));
          },
        ),
        leasedTool(
          "finalize",
          UNIFIED_FINALIZE_TOOL_DESCRIPTION,
          STAGE_ONE_FINALIZE_INPUT_SHAPE,
          async (args: { summary?: unknown; homeless?: unknown }, extra: unknown) => {
            const origin = await resolveResponseOrigin(originRegistry, extra);
            const decision = decideOrigin(origin);
            if (decision.kind === "unknown") {
              return textResult(unifiedUnknownOriginRefusal("Nothing was transitioned."));
            }
            if (decision.kind === "sibling") {
              return textResult(unifiedSiblingRefusal("Nothing was transitioned."));
            }
            if (decision.origin === "edges") {
              return textResult(
                "finalize refused — this run has already moved to the edge pass; finalize is the " +
                  "topic pass's own transition and runs at most once per run. Nothing was " +
                  "transitioned. Stop calling finalize.",
              );
            }
            const summary = args.summary;
            if (typeof summary !== "string" || summary.trim() === "") {
              return textResult(
                "Parameter error: summary is required — a sentence or three naming the lines you " +
                  "found, which were existing lanes and which are new. Nothing was transitioned.",
              );
            }
            if (summary.length > STAGE_ONE_SUMMARY_MAX_CHARS) {
              return textResult(
                `Parameter error: summary is ${summary.length} characters, over the ` +
                  `${STAGE_ONE_SUMMARY_MAX_CHARS}-character cap. It is never truncated — shorten ` +
                  "it below ~800 characters and call again. Nothing was transitioned.",
              );
            }

            const refusal = evaluateStageOneTransitionGate(options.db, {
              writableTurnIds: request.writableTurnIds,
              windowTurnIds: request.scopeProvenance.window,
            });
            if (refusal !== null) {
              return textResult(refusal);
            }

            const homelessInput = Array.isArray(args.homeless) ? args.homeless : [];
            const homelessGroups: {
              taskScopeId: number;
              canonicalLabel: string;
              memberFingerprint: string;
              reason: string;
              turnIds: number[];
            }[] = [];
            for (const raw of homelessInput as Array<{
              label?: unknown;
              reason?: unknown;
              turns?: unknown;
            }>) {
              const label = typeof raw.label === "string" ? raw.label.trim() : "";
              const reason = typeof raw.reason === "string" ? raw.reason.trim() : "";
              const addresses = Array.isArray(raw.turns) ? raw.turns : [];
              if (label === "" || reason === "" || addresses.length === 0) {
                return textResult(
                  "Parameter error: every homeless entry needs a label, a reason and at least one " +
                    "member turn. Nothing was transitioned.",
                );
              }
              const turnIds: number[] = [];
              for (const address of addresses) {
                const parsed =
                  typeof address === "string" ? parseTurnAddress(address) : null;
                if (!parsed) {
                  return textResult(
                    `Parameter error: homeless group "${label}" names ${JSON.stringify(address)}, ` +
                      'which is not an "S<session>/T<prompt>" address. Nothing was transitioned.',
                  );
                }
                const resolved = resolveWritableTurn(
                  options.db,
                  parsed.sessionId,
                  parsed.promptNumber,
                  request.writableTurnIds,
                );
                if (resolved === null) {
                  return textResult(
                    `Parameter error: homeless group "${label}" names S${parsed.sessionId}/T${parsed.promptNumber}, ` +
                      "which is not in your writable set. A disposition is recorded only for turns " +
                      "this window owns. Nothing was transitioned.",
                  );
                }
                turnIds.push(resolved);
              }
              homelessGroups.push({
                taskScopeId: TASKLESS_TASK_SCOPE_ID,
                canonicalLabel: label,
                memberFingerprint: homelessMemberFingerprint(turnIds),
                reason,
                turnIds,
              });
            }

            const projection = collectStageOneProjection(
              options.db,
              priorTagsByTurn,
              request.writableTurnIds,
            );

            const homedSet = new Set(projection.homedTurnIds);
            const contradicted = [
              ...new Set(
                homelessGroups.flatMap((group) =>
                  group.turnIds.filter((turnId) => homedSet.has(turnId)),
                ),
              ),
            ];
            if (contradicted.length > 0) {
              const named = contradicted
                .map((turnId) => turnAddressFor(options.db, turnId))
                .join(", ");
              return textResult(
                `Parameter error: ${named} ${
                  contradicted.length === 1 ? "is" : "are"
                } declared homeless, but your own tags give ${
                  contradicted.length === 1 ? "it" : "them"
                } a task and a declared lane — a turn cannot both have a home and have none. ` +
                  "Either drop it from the homeless group, or strip the tags that home it and say " +
                  "why it belongs nowhere. Nothing was transitioned.",
              );
            }

            const regroupedTurnIds = new Set<number>();
            const supersessions: NoteSettlementSupersessionIntent[] = [];
            homelessGroups.forEach((group, index) => {
              for (const turnId of group.turnIds) {
                if (regroupedTurnIds.has(turnId)) {
                  continue;
                }
                regroupedTurnIds.add(turnId);
                supersessions.push({
                  turnId,
                  successorKind: "regrouped",
                  successorGroupIndex: index,
                });
              }
            });
            for (const turnId of projection.homedTurnIds) {
              if (regroupedTurnIds.has(turnId)) {
                continue;
              }
              supersessions.push({ turnId, successorKind: "homed" });
            }

            const transitioned = transitionNoteSettlementJobToEdges(
              options.db,
              request.jobId,
              request.claimGeneration,
              nowEpoch(),
              {
                stage1Metrics: JSON.stringify({
                  summary,
                  worklistLanes: projection.worklist.length,
                  removedLanes: projection.removedLanes.length,
                  homelessGroups: homelessGroups.length,
                }),
                snapshots: {
                  window: [...request.scopeProvenance.window],
                  lookback: [...request.scopeProvenance.baseLookback],
                  closure: [...request.scopeProvenance.closureOnly],
                  worklist: projection.worklist,
                  removedLanes: projection.removedLanes,
                },
                homelessGroups,
                homelessSupersessions: supersessions,
              },
            );
            if (!transitioned) {
              return textResult(
                `finalize refused — this dispatch no longer owns job ${request.jobId} (it was ` +
                  "reclaimed, terminalised, or has already transitioned). Nothing was " +
                  "transitioned. Stop making tool calls.",
              );
            }
            finalized = true;
            // THE HANDOFF (ticket 02's seam, called a second time): the
            // transition transaction above has just persisted the three
            // snapshots — read them ONCE and swap `scopeHolder.current` in
            // place, so every closure that already captured `scopeHolder` (the
            // write engine's gates, `lane_check`, `note`'s edge-pass allowlist
            // branch above) observes the frozen edge-pass scope on its very
            // next call, with no rebuild.
            installSettlementEdgesScope(
              options.db,
              request.jobId,
              {
                writableTurnIds: request.writableTurnIds,
                scopeProvenance: request.scopeProvenance,
              },
              scopeHolder,
            );
            // DATA ONLY (spec decision 1's own words) — a needle test pins the
            // absence of imperative duty language here. Every instruction for
            // what this data means lives in the prompt, the trusted channel.
            return textResult(
              [
                renderUnifiedFinalizeDataResult(
                  options.db,
                  request.jobId,
                  transitioned.transitionSeq,
                  scopeHolder.current,
                ),
                // THE IMPRESSION ADVISORY (lane-impressions ticket 02): each
                // touched container's current text, its CAS base revision and
                // the token CAP it must fit — "the model must know its budget
                // BEFORE generating, not discover at commit that 450 tokens
                // face a 135 cap". Rendered HERE because the worklist and its
                // frozen per-lane member snapshots — the caps' own inputs —
                // come into existence in the transaction that just committed;
                // the prompt, built before the run, could not have known them.
                // DATA ONLY, like everything else in this result: the writing
                // law is in the prompt.
                impressions.maintainer.renderAdvisories(),
              ].join("\n\n"),
            );
          },
        ),
        leasedTool(
          "commit",
          UNIFIED_COMMIT_TOOL_DESCRIPTION,
          SETTLEMENT_COMMIT_INPUT_SHAPE,
          async (args: { report?: string }, extra: unknown) => {
            const retired = retiredImpressionsArgument(args);
            if (retired !== null) {
              return textResult(retired);
            }
            const origin = await resolveResponseOrigin(originRegistry, extra);
            const decision = decideOrigin(origin);
            if (decision.kind === "unknown") {
              return textResult(unifiedUnknownOriginRefusal("Nothing was committed."));
            }
            if (decision.kind === "sibling") {
              return textResult(unifiedSiblingRefusal("Nothing was committed."));
            }
            if (decision.origin === "topics") {
              return textResult(
                "commit refused — this run is still in the topic pass; call `finalize` first. " +
                  "Nothing was committed.",
              );
            }
            const phaseConnectivityWindowIds =
              scopeHolder.current.scopeProvenance?.window ?? scopeHolder.current.writableTurnIds;
            const appendReports = (
              text: string,
              extraLines: readonly string[] = [],
            ): { content: Array<{ type: "text"; text: string }> } => {
              const phaseReport = renderPhaseConnectivityReport(
                options.db,
                checkPhaseConnectivity(options.db, phaseConnectivityWindowIds),
              );
              const tail = [...extraLines, phaseReport].filter((line) => line !== "");
              return textResult(tail.length > 0 ? `${text}\n\n${tail.join("\n\n")}` : text);
            };
            terminalGateVerdict = null;
            terminalShape = null;
            terminalRetractions = [];
            impressions.clearRefused();
            const committed = await writes.commit(args.report);
            const committedText = committed.content[0]?.text ?? "";
            const gateVerdict = readTerminalGateVerdict();
            if ((gateVerdict !== null && !gateVerdict.ok) || impressions.wasRefused()) {
              // Same reason the gate branch skips them: the transaction rolled
              // back, so `captureAtCommit` never ran and there is no terminal
              // state for the shape/retraction blocks to describe. Ticket 05's
              // case 4 rides the same branch, for the same reason — see the
              // legacy builder's own commit handler.
              return protocolBoundedResult(
                appendReports(committedText).content[0]!.text,
                "commit",
              );
            }
            const dispositionWarnings: readonly string[] =
              gateVerdict === null ? [] : gateVerdict.warnings;
            const shapeReport = terminalShape ? renderSettlementShapeNumbers(terminalShape) : "";
            const retractionReport = renderSettlementHomelessRetractions(
              options.db,
              terminalRetractions,
            );
            return appendReports(committedText, [
              ...dispositionWarnings,
              shapeReport,
              retractionReport,
            ]);
          },
        ),
        leasedTool(
          "lane_check",
          SETTLEMENT_LANE_CHECK_TOOL_DESCRIPTION,
          SETTLEMENT_LANE_CHECK_TOOL_SHAPE,
          async (args: { page?: number; pageBudget?: number }) => {
            laneCheckCalled = true;
            // Tickets 03 and 05, identical to the legacy builder's own handler
            // above — see its comments for why the projection is one value, why
            // an unconstructible one yields no report at all, and why the
            // finished text is measured against the protocol before it leaves.
            const scope = projectionScope();
            const runTouches = writes.getRunLaneTouches();
            const judgment = judgeSettlementWindow(
              options.db,
              scope,
              scopeHolder.current.scopeProvenance,
              runTouches.turnIds,
            );
            if (!judgment.ok) {
              return textResult(raiseSystemFailure(judgment.failure, "lane_check"));
            }
            const evaluation = judgment.evaluation;
            const { result, turns } = evaluation;
            const paged = renderLaneCheckerReportsPaged(result, buildLaneAnchorAddresses(turns), {
              page: args.page,
              pageBudget: args.pageBudget,
              classifyError: laneCheckErrorClassifier(evaluation, scope),
            });
            const extraSections: string[] = [];
            if ((args.page ?? 1) === 1) {
              const phaseReport = renderPhaseConnectivityReport(
                options.db,
                checkPhaseConnectivity(
                  options.db,
                  scopeHolder.current.scopeProvenance?.window ?? scopeHolder.current.writableTurnIds,
                ),
              );
              if (phaseReport) {
                extraSections.push(phaseReport);
              }
              const disposition = evaluateLaneDispositionGate(
                options.db,
                evaluation,
                runTouches,
                scope,
              );
              if (disposition.blocking.length > 0) {
                extraSections.push(
                  [
                    `LANE DISPOSITION (blocking at commit; ${disposition.blocking.length} ` +
                      "fracture(s) touched by this run still owe a disposition):",
                    ...disposition.blocking.map((line) => `  ${line}`),
                  ].join("\n"),
                );
              }
              extraSections.push(...disposition.warnings);
            }
            const text = extraSections.length > 0 ? `${paged.text}\n\n${extraSections.join("\n\n")}` : paged.text;
            return protocolBoundedResult(text, "lane_check");
          },
        ),
      ],
    });

    try {
      const execution = queryImpl({
        prompt: request.prompt,
        options: {
          model: request.model,
          cwd: options.dataRoot,
          pathToClaudeCodeExecutable: resolveClaudeCodeExecutablePath(),
          env: {
            ...(options.agentEnv ?? buildIsolatedEnv(process.env, {})),
            FORCE_PROMPT_CACHING_5M: "1",
          },
          tools: [],
          allowedTools: [...NOTE_SETTLEMENT_UNIFIED_ALLOWED_TOOLS],
          mcpServers: { mnemo: server },
          hooks: { Stop: [{ hooks: [stopHook] }] },
          abortController,
          systemPrompt: request.systemPrompt,
          ...(request.maxThinkingTokens != null
            ? { maxThinkingTokens: request.maxThinkingTokens }
            : {}),
        },
      });

      let envelope: string | null = null;
      for await (const message of execution as AsyncIterable<SDKMessage>) {
        if (message.type === "assistant") {
          observeSdkAssistantMessage(originRegistry, message);
          continue;
        }
        if (message.type !== "result") {
          continue;
        }
        if (message.subtype !== "success" || message.is_error) {
          throw new Error(`note settlement unified query failed (${message.subtype})`);
        }
        envelope = message.result;
      }
      originRegistry.closeResponse();
      if (envelope === null) {
        throw new Error("note settlement unified query returned no result envelope");
      }
      return {
        text: envelope,
        finalized,
        commitMetrics: writes.getLastCommitMetrics(),
        laneCheckCalled,
      };
    } finally {
      originRegistry.dispose();
      if (request.signal) {
        request.signal.removeEventListener("abort", forwardAbort);
      }
    }
  };
}

/**
 * `finalize`'s own DATA-ONLY result (spec decision 1). Every line states a
 * fact the transition just persisted or the run already declared — never an
 * instruction. What to DO with this data is the prompt's job, not this
 * string's.
 */
function renderUnifiedFinalizeDataResult(
  db: Database,
  jobId: number,
  transitionSeq: number | null,
  scope: SettlementEdgesScope,
): string {
  const frozenAddresses = [...scope.writableTurnIds]
    .sort((a, b) => a - b)
    .map((id) => turnAddressFor(db, id));
  const worklist = buildSettlementWorklistRendering(db, jobId);
  const lines: string[] = [
    `job ${jobId}, transition ${transitionSeq}.`,
    `frozen writable set (${frozenAddresses.length}): ${
      frozenAddresses.length > 0 ? frozenAddresses.join(", ") : "(none)"
    }`,
    `worklist lanes (${worklist.lanes.length}):`,
  ];
  if (worklist.lanes.length === 0) {
    lines.push("  (none)");
  }
  for (const lane of worklist.lanes) {
    lines.push(`  ${lane.address} (${lane.memberAddresses.length}): ${lane.memberAddresses.join(", ")}`);
  }
  lines.push(`removed-side debts (${worklist.debts.length}):`);
  if (worklist.debts.length === 0) {
    lines.push("  (none)");
  }
  for (const debt of worklist.debts) {
    lines.push(`  edge #${debt.edgeId}: ${debt.citingAddress} names removed lane "${debt.removedLaneTag}"`);
  }
  lines.push(`homeless groups (${worklist.homeless.length}):`);
  if (worklist.homeless.length === 0) {
    lines.push("  (none)");
  }
  for (const group of worklist.homeless) {
    lines.push(`  "${group.label}" — ${group.reason}: ${group.memberAddresses.join(", ")}`);
  }
  return lines.join("\n");
}
