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
import {
  claimWriterId,
  settlementTurnPermissions,
  type SettlementProvenanceIndex,
} from "../db/write-gate";
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
import { buildIsolatedEnv } from "../mnemosyne/env";
import { loadLaneCheckScope } from "../db/lane-checker-load";
import { loadBasisReachabilityClosure, closureAsPhaseConnectivityInput, selectLandingTurnIds } from "../db/basis-reachability-load";
import {
  computeDuplicateReasonRate,
  computeLaneFractures,
  checkLaneDispositionJustification,
  laneTouchSegmentTagKey,
  laneTouchTurnTagKey,
  DUPLICATE_REASON_ANOMALY_RATE,
  type RunLaneTouches,
} from "../db/lane-disposition";
import { getTurnById } from "../db/turns";
import { RELATION_FIELD_ENTRIES, RETRACTION_FIELD_ENTRIES } from "../db/citations";
import { TASKLESS_TASK_SCOPE_ID } from "../db/homeless-record";
import { checkLanes, type LaneCheckerError } from "../shared/lane-checker";
import {
  buildLaneAnchorAddresses,
  renderLaneCheckerReportsPaged,
  type LaneCheckerScope,
} from "../shared/lane-checker-render";
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
  type SettlementMembershipWriteInput,
} from "./note-settlement-membership-facade";
import {
  createSettlementDirectWriteEngine,
  type NoteSettlementCommitRecord,
  type SettlementTerminalGateVerdict,
} from "./note-settlement-direct-write";
import {
  createResponseOriginRegistry,
  observeSdkAssistantMessage,
  resolveResponseOrigin,
  type ResponseOrigin,
  type ResponseOriginRegistry,
} from "./note-settlement-response-origin";
import { createSettlementStopHook } from "./note-settlement-stop-hook";
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
 *      see `blocksUnderProvenance`.
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
 * The `remember` tool's STAGE-2 call contract, which is now one action wide
 * (final review, finding 1): `justify`.
 *
 * The lane registry belongs to stage 1 — the pass whose whole job is judging
 * the window's topic lines — and the transition FROZE the partition this pass
 * reads. `create`/`delete`/`merge` here would let stage 2 rewrite that
 * judgment from underneath its own snapshot; `merge` in particular moves every
 * member turn's tags and every edge side of a whole task, past a writable set
 * and a worklist that then describe nothing. Consolidation stays what the spec
 * makes it: a later, explicit, user-ruled merge.
 *
 * `justify` survives because the MANDATORY-DISPOSITION gate runs at this
 * pass's own terminal commit and a justification is its one legal discharge —
 * removing it would leave a run that cannot honestly stitch a fracture with no
 * way to finish.
 */
export const SETTLEMENT_REMEMBER_TOOL_DESCRIPTION =
  "DISPOSE of a SEVERED lane — the one action this pass has on this tool. " +
  "action: \"justify\", and nothing else: `create`, `delete` and `merge` are " +
  "refused here, because the lane registry is stage 1's and it froze the " +
  "worklist you are working. A lane that looks wrong to you is a later, " +
  "explicit, user-ruled merge, never a rewrite from this pass. " +
  "justify (severed-lane ticket 02): id + tag + representative + " +
  "otherRepresentative (both \"S<n>/T<m>\" — the CURRENT representatives of " +
  "the two components a SEVERED lane's fracture sits between, named by " +
  "`lane_check`'s Report 2) + reason (why none of the seven relation words " +
  "applies). MANDATORY when a lane you touched stays severed at `commit` — " +
  "a genuine stitching edge always self-evidences instead and needs no " +
  "justify. TWO reads earn it, and the refusal names whichever is missing: " +
  "recall the LANE (id=\"E<n>/#<tag>\") until every era-visible member of " +
  "`otherRepresentative`'s own component has been shown to you — members the " +
  "era cutoff hides are excluded from that obligation and the refusal says " +
  "so — and recall `otherRepresentative` ITSELF whole, " +
  "recall(id=\"S<n>/T<m>\", filter={fields:[\"content\"]}). That second read " +
  "always works: the era cutoff narrows lane and task membership listings, " +
  "never an explicit turn address, so an out-of-era representative is still " +
  "readable one turn at a time. Bound to the fracture's own fingerprint AND " +
  "to the content it was granted on, so it is silently invalidated the moment " +
  "the topology changes (your own later stitch, a further split) or either " +
  "representative's content is written after it. " +
  "Never required — this window may finish without ever calling this tool.";

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
 * SETTLEMENT-ERGONOMICS TICKET 06 (spec D3 item 3) adds the THIRD parameter,
 * `scope`: `"actionable"` (default) narrows the render to findings anchored,
 * or covering members, inside this job's own WINDOW (`request.scopeProvenance
 * .window`, spec D0) — never the wider writable set, which also carries the
 * declared lookback and the deadlock-guard closure. `"all"` widens back to
 * the projection's own writable-set scope; it is NOT a budget escape hatch —
 * the render is still aggregated and still paginated exactly as above. See
 * `projectLaneCheckerResultByScope`'s own doc for the per-family predicate.
 * Omitting `scopeProvenance` on the request (a caller predating ticket 07)
 * makes `"actionable"` behave like `"all"` — the same fail-open convention
 * `evaluateSettlementCommitGate` already uses for the identical field.
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
  scope: z
    .enum(["actionable", "all"])
    .optional()
    .describe(
      "\"actionable\" (default): only findings this round's own window can act on. \"all\": every finding in your writable set's projection — still aggregated, still paginated, never a shortcut around the page budget.",
    ),
};

export const SETTLEMENT_LANE_CHECK_TOOL_DESCRIPTION =
  "Run the lane checker over THIS window's own writable set and " +
  "return its findings as compact numbers and names — never a digraph, " +
  "never a write. Paged (`page`, `pageBudget` — same name and meaning as " +
  "`recall`'s own): overflow rolls to another page, never truncates a block, " +
  "and every page beyond the first ends stating how many remain and the " +
  "exact call for the next one; every page re-runs the check, so it shows " +
  "the state at the moment you ask rather than a frozen first-page snapshot. " +
  "Scoped (`scope`): \"actionable\" (default) shows only findings THIS " +
  "round's own window can act on — an error anchored inside it, or a " +
  "warning whose covered members touch it; \"all\" widens back to the " +
  "whole writable set's projection (still aggregated, still paginated, " +
  "never a way around the page budget). Two " +
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
  "THIS PREVIEW LISTS MORE THAN THE GATE REFUSES OVER, and the gate is the " +
  "truth: an E3 anywhere — on a window turn as much as on a turn you may " +
  "write RELATIONS on only — prints here as actionable and does NOT block " +
  "your commit, because setting a turn's `type` is a note field no edge pass " +
  "holds the pen for. It is the first pass's debt, and a later window reaches " +
  "it through its own lookback. Do not chase it and do not try to retype a " +
  "turn to silence it; the call is refused. " +
  "Everything after the ERRORS block is WARNINGS: aspirational facts, " +
  "never enforced. Report 1: per-lane statistics (members, edge counts, who " +
  "cites a member from outside " +
  "— grounds, consume-class use, or testimony; a lane cited only by " +
  "consume is still ADOPTED, not unused). A lane has NO state: open/closed " +
  "and the single terminus they were computed from are gone. Report 2: " +
  "connectivity over each " +
  "lane's OWN edges — those whose two sides both name it; a provisional lane " +
  "(0-1 members) is not judged. Report 3: cross-lane coupling, each lane's " +
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
  "is what normally stops one reaching you at all. `lane_check` still prints " +
  "it as actionable, and the refusal above still counts it — this gate is the " +
  "truth about what blocks. " +
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
  "on your retry.";

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
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
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
   * consumed read-only. Read by the terminal gate's per-provenance filter
   * (`blocksUnderProvenance` below) and by nothing else here: the PROJECTION is
   * unaffected, since what the loader loads has never depended on why an id is
   * writable.
   *
   * Optional, and absent means "every writable id carries full authority" —
   * the pre-staging behaviour, which is also the correct reading for a job that
   * never transitioned.
   */
  writableProvenance?: SettlementProvenanceIndex;
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
 * overlap. The loader still WIDENS from that seed (each touched lane's full
 * edge set, the component closure, the seed-scoped out-of-vocabulary pass),
 * so an error anchored outside the set can still be REPORTED; the gate's own
 * anchor filter is what decides that it does not block.
 */
function checkWindowLanes(db: Database, scope: SettlementProjectionScope) {
  const projection = loadLaneCheckScope(db, {
    kind: "turns",
    turnIds: [...scope.writableTurnIds],
  });
  return {
    // Ticket 09 (D9): the loader's own per-SEGMENT registry/membership counts
    // go straight through as the fourth argument — the proliferation warning
    // must never be inferred from this window's projection (peer P1-11).
    result: checkLanes(
      projection.turns,
      projection.edges,
      projection.outOfVocabularyEdges,
      projection.segmentFacts,
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
// Lane disposition (severed-lane ticket 02) — MANDATORY-DISPOSITION ERROR
// ---------------------------------------------------------------------------

/**
 * Ticket 02's whole gate, run POST-STATE (after this call's own writes have
 * landed, since `commit`'s handler calls this AFTER `writes.commit`) over
 * the SAME projection the lane checker itself uses. For every SEVERED lane
 * (componentCount > 1) TOUCHED by this run's own LANDED writes (`touched`,
 * below — see its own doc comment: an edge side, a landed tags write or a
 * `justify`, never mere membership in the writable set), every remaining
 * consecutive-pair fracture (`computeLaneFractures`) needs a justify record
 * bound to its CURRENT fingerprint — a stitch self-evidences (the re-run
 * checker no longer reports the fracture, so no fingerprint is computed for
 * it at all) and a stale justify (bound to a fingerprint the topology has
 * since moved past) simply does not match, so it blocks exactly as if it had
 * never been written.
 *
 * Over-blocking fix (this ticket): `touched` used to be "any island member
 * is inside `scope.writableTurnIds`" — window ∪ lookback ∪ closure — so a
 * severed lane this run never wrote so much as one field of still owed a
 * disposition, whenever any of its members merely fell inside the rendered
 * lookback. `writableTurnIds` is WIDER than what a run actually does; the
 * gate now asks the narrower, correct question of `runTouches` (this run's
 * own accumulated write facts, `note-settlement-direct-write.ts`'s
 * `getRunLaneTouches()`) instead.
 *
 * A `DEFAULT_SEGMENT` (homeless) lane carries no real segment row to bind a
 * justify to and is skipped — the same "nothing to justify against" posture
 * the rest of this codebase takes for a homeless lane.
 */
function evaluateLaneDispositionGate(
  db: Database,
  scope: SettlementProjectionScope,
  runTouches: RunLaneTouches,
): { blocking: string[]; warnings: string[] } {
  const { result } = checkWindowLanes(db, scope);
  const blocking: string[] = [];
  const segmentsSeen = new Set<number>();
  for (const component of result.components) {
    if (component.componentCount <= 1) {
      continue;
    }
    const segmentId = Number(component.key.segment);
    if (!Number.isInteger(segmentId)) {
      continue; // DEFAULT_SEGMENT — no real segment row to bind a justify to
    }
    // TOUCHED means this run's own writes named the lane — never that a
    // member merely sat inside the writable set. Two ways in: a `justify`
    // addressed the lane directly (segment+tag, no turn involved), or an
    // edge side / landed tags write named one of the lane's OWN members —
    // matched against `component.islands` (the checker's own membership
    // answer) rather than resolved to a segment independently, so this can
    // never drift from what the loader itself considers a member.
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
    segmentsSeen.add(segmentId);
    for (const fracture of computeLaneFractures(segmentId, component)) {
      const disposition = checkLaneDispositionJustification(
        db,
        segmentId,
        component.key.tag,
        fracture.fingerprint,
      );
      if (disposition.status === "fresh") {
        continue;
      }
      const fractureText =
        `[LANE-DISPOSITION] E${segmentId} lane "${component.key.tag}" — severed fracture ` +
        `${turnAddressFor(db, fracture.representativeA)} <-> ` +
        `${turnAddressFor(db, fracture.representativeB)}`;
      // TICKET 08 decision 3: a justification that EXISTS but was granted on
      // evidence that has since moved is not the same refusal as no
      // justification at all — the caller has to know that its own earlier
      // work was undone by a later write, or it will read this as the gate
      // having lost the row.
      blocking.push(
        disposition.status === "stale"
          ? `${fractureText} has a justify on record, but the content it was granted on has ` +
            `MOVED since: ${disposition.moved
              .map((entry) => turnAddressFor(db, entry.turnId))
              .join(", ")} ` +
            "was written after that justify landed, so the disposition no longer describes what it " +
            "judged. Re-read that representative whole and justify the fracture again."
          : `${fractureText} has no stitching edge and no justify on ` +
            "record. Stitch it (write any of the seven relations across it), or call remember(justify, " +
            "id, tag, representative, otherRepresentative, reason) naming both representatives.",
      );
    }
  }
  const warnings: string[] = [];
  for (const segmentId of segmentsSeen) {
    const rate = computeDuplicateReasonRate(db, segmentId);
    if (rate && rate.rate > DUPLICATE_REASON_ANOMALY_RATE) {
      warnings.push(
        `[LANE-DISPOSITION] duplicate-reason rate for E${segmentId}: ${rate.duplicateCount}/${rate.total} ` +
          `(${Math.round(rate.rate * 100)}%) — anomalous; human review suggested.`,
      );
    }
  }
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
 * THE PER-PROVENANCE TERMINAL FILTER (staged-settlement spec Rev 5,
 * §Per-provenance gate filter). One error instance, two questions:
 *
 *   1. does it anchor inside this dispatch's writable set at all (the original
 *      filter, unchanged — an error anchored outside blocks its OWN window);
 *   2. can the authority THIS job holds over that anchor actually repair it?
 *
 * Question 2 is new and it exists because of one shape. A `removed-side-citer`
 * is in the writable set for a debt: this job's stage-1 projection removed a
 * lane from a turn the citer's edge points at, so the edge's side attribution
 * is stale and the citing turn is the only one that can fix it. That grants
 * RELATION writes and nothing else — the citer's note fields belong to whatever
 * window owns them.
 *
 * So the classes split by the authority each one NEEDS, which the checker's own
 * definitions already fix (`shared/lane-checker.ts`, module header):
 *
 *   - **E3 NEVER BLOCKS HERE, FOR ANY PROVENANCE** (ticket 17, reviewer ruling
 *     on round-3 finding P0-1). It is an empty or out-of-vocabulary turn
 *     `type`, anchored AT THE TURN ITSELF, and its only repair is writing that
 *     turn's `type` — a NOTE FIELD. Stage 2 holds no field authority ANYWHERE:
 *     the `note` face's allowlist (`STAGE_TWO_TURN_NOTE_FIELDS`) refuses
 *     `type` on a window member exactly as it refuses it on a removed-side
 *     citer, so the provenance the anchor carries makes no difference to
 *     whether this job could discharge the debt. It could not.
 *
 *     An earlier revision blocked window-provenance E3 on the reasoning that
 *     stage 1's transition gate never hands over an unfinished type, so the
 *     class was dormant. It is not dormant: after the transition, another
 *     legitimate writer — the main agent's own public `note`, whose schema
 *     accepts `type: []` (`mcp/definitions.ts`) — can empty a window turn's
 *     type, and a stage-2 retry resumes at `edges` without re-running stage 1.
 *     That made a concurrently-triggerable TERMINAL TRAP: refuse, refuse,
 *     refuse, window abandoned, and nothing repaired by the abandonment.
 *
 *     Enforcement lives where the authority lives. Stage 1's transition gate
 *     (`evaluateStageOneTransitionGate`) already refuses to hand over a turn
 *     with an unfinished type, and a type emptied AFTER the transition is the
 *     NEXT window's stage-1 debt, reached through its lookback. The class is
 *     still REPORTED here and by `lane_check` — narrowing the blocking set is
 *     not hiding the fact.
 *   - **E4 and E6 need `relations`.** Both anchor at an edge's CITING turn and
 *     both are discharged by retracting the edge or re-placing its sides, which
 *     is precisely what every provenance class authorizes. (E4's other repair —
 *     tagging the ENDPOINT — needs field authority over a different turn, so it
 *     is not the repair this anchor's own authority guarantees; the retraction
 *     is, and one legal repair is what makes an error repairable.)
 *
 * The `relations` question is still asked rather than assumed: every provenance
 * class carries it today, but the rule is `settlementWritePermissions`' to
 * state, reached through `settlementTurnPermissions` and never restated here
 * (spec reviewer guardrail 1: the old mutually-exclusive three-way helper is
 * not the model). A provenance added tomorrow without relation authority gets
 * the right answer for free.
 *
 * This is NOT debt-id scoping. Nothing here asks whether an error is one this
 * job's removal CAUSED; it asks what the job can repair, which is the same
 * repairability principle the anchor filter itself already applies, evaluated
 * one level finer.
 */
function blocksUnderProvenance(
  scope: SettlementProjectionScope,
  error: LaneCheckerError,
): boolean {
  if (!scope.writableTurnIds.has(error.anchorId)) {
    return false;
  }
  if (error.class === "E3") {
    return false;
  }
  return settlementTurnPermissions(scope.writableProvenance, error.anchorId).relations;
}

/**
 * The gate itself: run the checker over the job's immutable writable set and
 * REFUSE while any error anchors INSIDE it.
 *
 * Returns the refusal payload, or `null` when the window is clean enough to
 * commit. Four properties this function exists to hold:
 *
 *   - **The projection is the writable set** (peer round T1466, finding
 *     P1-1). Seed and filter are now the SAME value — `checkWindowLanes`
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
 *     Staged settlement adds the SECOND question, same principle one level
 *     finer: can this job's authority over that anchor repair this CLASS of
 *     error — see `blocksUnderProvenance`. Ticket 17 carried that question to
 *     its conclusion: a turn-TYPE debt (E3) is unrepairable by an edge pass on
 *     ANY provenance, so it never blocks here, and stage 1's transition gate is
 *     where type authority — and therefore type enforcement — lives.
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
  // something else entirely) gets the OLD flat, undifferentiated list —
  // `createNoteSettlementSdkQuery`'s own commit handler, the one production
  // caller, always supplies it (`request.scopeProvenance`).
  scopeProvenance?: SettlementScopeProvenance,
): string | null {
  const { result } = checkWindowLanes(db, scope);
  const blocking = result.errors.filter((error) => blocksUnderProvenance(scope, error));
  if (blocking.length === 0) {
    return null;
  }
  // The two non-blocking remainders are counted SEPARATELY and said
  // separately: they are different facts, and the pre-staging line ("anchor
  // OUTSIDE your writable set — another window's work") is a lie about an
  // error that anchors squarely INSIDE it and is merely beyond this job's
  // authority to repair. An agent told the wrong one goes looking for a
  // scoping bug that does not exist. Ticket 17 widened the second remainder
  // from "relations-only turns" to every in-set E3, so its wording no longer
  // names a provenance the reader would then check its own turn against and
  // find false.
  const outOfScope = result.errors.filter(
    (error) => !scope.writableTurnIds.has(error.anchorId),
  ).length;
  const beyondAuthority = result.errors.length - blocking.length - outOfScope;
  return [
    `Commit refused — ${blocking.length} error(s) the grammar forbids still anchor inside your ` +
      "writable set. NOTHING was committed and this is NOT a failed attempt: repair these " +
      "and call `commit` again in this same run.",
    ...(scopeProvenance
      ? renderBlockingErrorsByOrigin(db, blocking, scopeProvenance)
      : blocking.map((error) => `  ${describeCommitGateError(db, error)}`)),
    outOfScope > 0
      ? `(${outOfScope} further error(s) anchor OUTSIDE your writable set — another window's work, not listed and not blocking.)`
      : null,
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
 * `SettlementFrozenScope`'s own six fields, fallback-completed for a job
 * still on stage 1 (spec "The frozen scope is installed by an internal
 * handoff" — same inputs, same outputs as `readSettlementFrozenScope`
 * itself). This file's closures and write engine consume only the first
 * three today — the writable set, its provenance classes, and the
 * three-bucket window/lookback/closure split the refusal renderer and the
 * phase-connectivity window take; `worklist`/`debts`/`laneMembers` carry
 * straight through unread here, ready for a later caller of this same
 * install function (the prompt-building layer already reads
 * `readSettlementFrozenScope` on its own, out of this ticket's territory).
 */
export interface SettlementEdgesScope {
  writableTurnIds: ReadonlySet<number>;
  writableProvenance: SettlementProvenanceIndex;
  scopeProvenance: SettlementScopeProvenance | undefined;
  worklist: SettlementFrozenScope["worklist"];
  debts: SettlementFrozenScope["debts"];
  laneMembers: SettlementFrozenScope["laneMembers"];
}

/**
 * A mutable box, installed once and re-installed in place. Everything this
 * dispatch's write engine and gate closures read is `holder.current` at the
 * moment they run, never a value copied out at construction — so a LATER
 * `installSettlementEdgesScope` call (ticket 03: the finalize handler, once
 * the transition it guards has just persisted the snapshots this reads)
 * swaps this run's authority without rebuilding the write engine or any
 * closure that captured the holder.
 */
export interface SettlementEdgesScopeHolder {
  current: SettlementEdgesScope;
}

/**
 * THE install function — the one path that reads `readSettlementFrozenScope`
 * and turns it into this dispatch's edges scope, callable at two times with
 * IDENTICAL behaviour:
 *
 *   - AT REQUEST CONSTRUCTION (today, below): the transition snapshots do
 *     not exist yet for a job still on stage 1, so `readSettlementFrozenScope`
 *     returns `null` and `fallback` — the dispatch's own live-computed
 *     writable set — stands, exactly the pre-staging behaviour.
 *   - LATER, AGAINST A LIVE RUN (ticket 03): called again after a finalize
 *     handler's transition transaction commits, this time reading the
 *     snapshots that transaction just persisted. Passing the SAME `holder`
 *     mutates `holder.current` in place rather than allocating a new box, so
 *     every closure that closed over `holder` — not over its old contents —
 *     observes the swap on its very next call.
 *
 * `holder` omitted allocates a fresh one (the construction-time call below);
 * supplied, it is mutated and returned so the caller keeps using its own
 * reference.
 */
export function installSettlementEdgesScope(
  db: Database,
  jobId: number,
  fallback: Pick<SettlementEdgesScope, "writableTurnIds" | "scopeProvenance">,
  holder?: SettlementEdgesScopeHolder,
): SettlementEdgesScopeHolder {
  const frozen = readSettlementFrozenScope(db, jobId);
  const scope: SettlementEdgesScope = {
    writableTurnIds: frozen?.writableTurnIds ?? fallback.writableTurnIds,
    writableProvenance: frozen?.writableProvenance ?? new Map(),
    scopeProvenance: frozen?.scopeProvenance ?? fallback.scopeProvenance,
    worklist: frozen?.worklist ?? [],
    debts: frozen?.debts ?? [],
    laneMembers: frozen?.laneMembers ?? new Map(),
  };
  if (holder) {
    holder.current = scope;
    return holder;
  }
  return { current: scope };
}

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
    const writes = createSettlementDirectWriteEngine({
      db: options.db,
      context: turnFacadeContext,
      now: options.now,
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
        const refusal = evaluateSettlementCommitGate(
          db,
          {
            writableTurnIds: scopeHolder.current.writableTurnIds,
            writableProvenance: scopeHolder.current.writableProvenance,
          },
          scopeHolder.current.scopeProvenance,
        );
        if (refusal !== null) {
          terminalGateVerdict = { ok: false, refusal };
          return terminalGateVerdict;
        }
        // THE MANDATORY-DISPOSITION GATE (severed-lane ticket 02,
        // [S15069/T1951]) — unlike ticket 01's phase-connectivity walk this is
        // NOT gated off: the ticket ratified the refusal itself, so it runs
        // the moment this machinery ships.
        const disposition = evaluateLaneDispositionGate(
          db,
          {
            writableTurnIds: scopeHolder.current.writableTurnIds,
            writableProvenance: scopeHolder.current.writableProvenance,
          },
          writes.getRunLaneTouches(),
        );
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
      // The FULL tuple (finding 3).
      stage: request.stage,
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
      version: "0.26.1",
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
        leasedTool(
          "remember",
          SETTLEMENT_REMEMBER_TOOL_DESCRIPTION,
          settlementMembershipWriteInputShape,
          async (args: SettlementMembershipWriteInput) => {
            // STAGE 2 HOLDS NO MEMBERSHIP-MUTATION SURFACE (final review,
            // finding 1). The partition is stage 1's judgment, frozen by the
            // transition, and stage 2's authority is the snapshot of it — but
            // the facade it was handed could rewrite that partition wholesale:
            // `merge` moves every member turn's tags and every edge side of a
            // whole task, past a writable set and past a frozen worklist that
            // no longer describe anything. `create`/`delete` are the same
            // power one step smaller. A refusal at the toolset is the only
            // mechanism available, exactly as commit-unreachability is for
            // stage 1: the CAS underneath stays stage-agnostic on purpose.
            //
            // `justify` STAYS, and it is not an exception: the
            // mandatory-disposition gate runs at THIS pass's terminal commit,
            // and a justification is its one legal discharge. Refusing it
            // would leave a run that cannot honestly stitch a fracture with no
            // way to finish at all.
            const action = (args as { action?: string }).action;
            if (action !== undefined && action !== "justify") {
              return textResult(
                `Parameter error: ${action} is refused on the edge pass — the lane registry is ` +
                  "stage 1's, and it froze the worklist you are reading. A lane that looks wrong " +
                  "to you is a later, explicit, user-ruled merge, never a rewrite from here. " +
                  "`justify` is the one action on this tool: a severed lane's mandatory " +
                  "disposition at your own commit. Nothing was written.",
              );
            }
            return writes.writeMembership(args);
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
          { report: z.string() },
          async (args: { report?: string }) => {
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
            const committed = await writes.commit(args.report);
            const committedText = committed.content[0]?.text ?? "";
            // A gate refusal comes back through `commit` verbatim; this layer
            // only re-attaches the phase-connectivity report it always did.
            // The shape and retraction blocks below are deliberately skipped:
            // the transaction rolled back, so `captureAtCommit` never ran and
            // there is no terminal state for them to describe.
            const gateVerdict = readTerminalGateVerdict();
            if (gateVerdict !== null && !gateVerdict.ok) {
              return appendReports(committedText);
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
          async (args: { page?: number; pageBudget?: number; scope?: LaneCheckerScope }) => {
            laneCheckCalled = true;
            // The SAME pass the commit gate runs (ticket 05) — see
            // `checkWindowLanes`: the preview and the verdict are one
            // projection, so the list this prints cannot differ from the
            // list `commit` judges. Ticket 06 additionally hands the render
            // that projection's turns, so an anchor prints as
            // `S<session>/T<prompt>` — the address the repair call itself
            // takes, matching the commit refusal's own vocabulary. Finding
            // P1-1: the scope is this dispatch's WRITABLE SET, the same seed
            // the gate builds from — a preview over a narrower projection
            // would hide exactly the rows the gate is about to refuse over.
            const { result, turns } = checkWindowLanes(options.db, {
              writableTurnIds: scopeHolder.current.writableTurnIds,
              writableProvenance: scopeHolder.current.writableProvenance,
            });
            // Settlement-ergonomics ticket 05: paged and aggregated, never
            // the plain uncapped render — see `renderLaneCheckerReportsPaged`'s
            // own doc for why a SEPARATE entry point exists rather than a
            // change to `renderLaneCheckerReports` itself (the CLI/console
            // still call that one, unbounded, on purpose).
            //
            // `"actionable"` IS THE WRITABLE SET (peer round three finding 04,
            // user ruling [S15069/T1778]) — the same set the commit gate
            // filters by, so the default view and the verdict are one list.
            // Ticket 06 had scoped it to `scopeProvenance.window`, which
            // contradicted the paragraph directly above: an error anchored on
            // a declared-lookback or closure turn was invisible by default and
            // fatal at commit, and the prompt told the agent those were the
            // same list. It also contradicted "actionable"'s own definition —
            // this round CAN write every turn in the writable set, so a
            // finding there is precisely something it can act on. The wider
            // default costs some output; hiding a blocking row costs a
            // refused commit the agent was told could not happen.
            const paged = renderLaneCheckerReportsPaged(result, buildLaneAnchorAddresses(turns), {
              page: args.page,
              pageBudget: args.pageBudget,
              scope: args.scope,
              actionableTurnIds: scopeHolder.current.writableTurnIds,
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
                {
                  writableTurnIds: scopeHolder.current.writableTurnIds,
                  writableProvenance: scopeHolder.current.writableProvenance,
                },
                writes.getRunLaneTouches(),
              );
              if (disposition.blocking.length > 0) {
                extraSections.push(
                  [
                    `LANE DISPOSITION (ticket 02 — MANDATORY at commit; ${disposition.blocking.length} ` +
                      "fracture(s) touched by this run still owe a disposition):",
                    ...disposition.blocking.map((line) => `  ${line}`),
                  ].join("\n"),
                );
              }
              extraSections.push(...disposition.warnings);
            }
            const text = extraSections.length > 0 ? `${paged.text}\n\n${extraSections.join("\n\n")}` : paged.text;
            return textResult(text);
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
// — the SAME functions stage 1's own standalone registration calls, so the
// GATE RULES and the PROJECTION ALGORITHM are one implementation shared by
// both call sites. What differs between `createNoteSettlementStageOneSdkQuery`
// above^ (^ note-settlement-stage1.ts) and this function is ONLY the SDK
// `tool()` registration call itself — one topics-only site the scheduler's
// existing two-dispatch chain still drives (ticket 04 retires that chain; this
// ticket does not touch the scheduler), and this ORIGIN-GATED union site,
// which no scheduler wiring reaches yet. "No duplicated tool definitions" is
// read here as no duplicated GATE/PROJECTION/FIELD-SET logic — the two
// registration call sites are the artifact of that scheduler boundary, not a
// second copy of what either pass may do.
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
  "DECLARE or DISPOSE a lane — lands immediately, in this same call. BEFORE " +
  "your own `finalize`: action \"create\" or \"delete\". A lane is (task, ONE " +
  "tag); `create` needs a canonical tag carrying no phase word " +
  "(research/design/implement/fix/review/verification and their families are " +
  "refused, naming the offending word). `merge` is refused in both passes — " +
  "folding two lanes into one is the user's own explicit call, made later. " +
  "`justify` is refused before `finalize` too: it answers a commit gate you " +
  "have not reached yet. AFTER `finalize`: `justify` is the only action — the " +
  "lane registry is the topic pass's own settled judgment, frozen by your " +
  "transition, and `create`/`delete` are refused naming that. justify: id + " +
  "tag + representative + otherRepresentative (both \"S<n>/T<m>\") + reason — " +
  "the severed-lane disposition your own terminal `commit` may require.";

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

    const writes = createSettlementDirectWriteEngine({
      db: options.db,
      context: turnFacadeContext,
      now: options.now,
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
        const refusal = evaluateSettlementCommitGate(
          db,
          {
            writableTurnIds: scopeHolder.current.writableTurnIds,
            writableProvenance: scopeHolder.current.writableProvenance,
          },
          scopeHolder.current.scopeProvenance,
        );
        if (refusal !== null) {
          terminalGateVerdict = { ok: false, refusal };
          return terminalGateVerdict;
        }
        const disposition = evaluateLaneDispositionGate(
          db,
          {
            writableTurnIds: scopeHolder.current.writableTurnIds,
            writableProvenance: scopeHolder.current.writableProvenance,
          },
          writes.getRunLaneTouches(),
        );
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
      // KNOWN LIMITATION (out of this ticket's territory — the stop hook file
      // is not this ticket's to change): fixed at the run's OWN starting
      // stage. A unified run that transitions mid-session keeps being nudged
      // toward `finalize` by name after it has already moved to the edge
      // pass; spec's own "Stop hook, stage-aware and bounded" decision is a
      // separate repair against this same file.
      stage: request.stage,
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
      version: "0.26.1",
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
          settlementMembershipWriteInputShape,
          async (args: SettlementMembershipWriteInput, extra: unknown) => {
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
              if (action === "merge") {
                return textResult(
                  "Parameter error: merge is refused before your own finalize. Folding two lanes " +
                    "into one is the user's own explicit call, made later. Nothing was written.",
                );
              }
              if (action === "justify") {
                return textResult(
                  "Parameter error: justify is refused before your own finalize — it answers a " +
                    "commit gate about a severed lane's edges, and you reach no commit until your " +
                    "own finalize has succeeded. Nothing was written.",
                );
              }
              if (action === "create") {
                const rawTag = (args as { tag?: unknown }).tag;
                if (typeof rawTag === "string") {
                  const refusal = checkStageOneLaneTag(rawTag);
                  if (refusal !== null) {
                    return textResult(`Parameter error: ${refusal}`);
                  }
                }
              }
              return writes.writeMembership(args);
            }
            // origin === "edges": only `justify` survives.
            if (action !== undefined && action !== "justify") {
              return textResult(
                `Parameter error: ${action} is refused in the edge pass — the lane registry is the ` +
                  "topic pass's own settled judgment, frozen by your finalize. A lane that looks " +
                  "wrong to you is a later, explicit, user-ruled merge, never a rewrite from here. " +
                  "`justify` is the one action available now. Nothing was written.",
              );
            }
            return writes.writeMembership(args);
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
                  "it and call again. Nothing was transitioned.",
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
              renderUnifiedFinalizeDataResult(
                options.db,
                request.jobId,
                transitioned.transitionSeq,
                scopeHolder.current,
              ),
            );
          },
        ),
        leasedTool(
          "commit",
          UNIFIED_COMMIT_TOOL_DESCRIPTION,
          { report: z.string() },
          async (args: { report?: string }, extra: unknown) => {
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
            const committed = await writes.commit(args.report);
            const committedText = committed.content[0]?.text ?? "";
            const gateVerdict = readTerminalGateVerdict();
            if (gateVerdict !== null && !gateVerdict.ok) {
              return appendReports(committedText);
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
          async (args: { page?: number; pageBudget?: number; scope?: LaneCheckerScope }) => {
            laneCheckCalled = true;
            const { result, turns } = checkWindowLanes(options.db, {
              writableTurnIds: scopeHolder.current.writableTurnIds,
              writableProvenance: scopeHolder.current.writableProvenance,
            });
            const paged = renderLaneCheckerReportsPaged(result, buildLaneAnchorAddresses(turns), {
              page: args.page,
              pageBudget: args.pageBudget,
              scope: args.scope,
              actionableTurnIds: scopeHolder.current.writableTurnIds,
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
                {
                  writableTurnIds: scopeHolder.current.writableTurnIds,
                  writableProvenance: scopeHolder.current.writableProvenance,
                },
                writes.getRunLaneTouches(),
              );
              if (disposition.blocking.length > 0) {
                extraSections.push(
                  [
                    `LANE DISPOSITION (MANDATORY at commit; ${disposition.blocking.length} ` +
                      "fracture(s) touched by this run still owe a disposition):",
                    ...disposition.blocking.map((line) => `  ${line}`),
                  ].join("\n"),
                );
              }
              extraSections.push(...disposition.warnings);
            }
            const text = extraSections.length > 0 ? `${paged.text}\n\n${extraSections.join("\n\n")}` : paged.text;
            return textResult(text);
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
