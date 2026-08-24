import {
  createSdkMcpServer,
  query,
  tool,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { Database } from "bun:sqlite";

import {
  MNEMO_TOOL_DESCRIPTIONS,
  timelineInputShape,
  workerRecallInputShape,
} from "../mcp/definitions";
import { createDatabaseBackedHandlers } from "../mcp/handlers";
import { claimWriterId } from "../db/write-gate";
import { touchNoteSettlementJobLease } from "../db/note-settlement";
import { buildIsolatedEnv } from "../mnemosyne/env";
import { loadLaneCheckScope } from "../db/lane-checker-load";
import { getTurnById } from "../db/turns";
import { checkLanes, type LaneCheckerError } from "../shared/lane-checker";
import {
  buildLaneAnchorAddresses,
  renderLaneCheckerReports,
} from "../shared/lane-checker-render";
import { resolveClaudeCodeExecutablePath } from "./claude-executable";
import type {
  NoteSettlementQuery,
  NoteSettlementQueryRequest,
  NoteSettlementQueryResult,
} from "./note-settlement-dispatch";
import {
  settlementMembershipWriteInputShape,
  type SettlementMembershipWriteInput,
} from "./note-settlement-membership-facade";
import { createSettlementDirectWriteEngine } from "./note-settlement-direct-write";
import { createSettlementStopHook } from "./note-settlement-stop-hook";
import {
  settlementTurnWriteInputShape,
  type SettlementTurnFacadeContext,
  type SettlementTurnWriteInput,
} from "./note-settlement-turn-facade";

/**
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
 * All eight words take either entry form and NONE requires a tag ([T1548]/
 * [T1562]) — the mandate that made `extends`/`narrows` tagged-only is
 * withdrawn, and lane tags are settlement's own instrument rather than a
 * shape the main agent owes. What the paragraph must still teach is what the
 * gate still refuses, which is now DECLARATION rather than word choice: a
 * tagged edge names a lane declared in the segment of BOTH endpoints, a self
 * edge never carries a tag, and two rows for one (pair, relation) may not
 * share a tag. The three-way split survives — ASSERTION, the RELATIONS READ
 * an edge write consumes (finding P1-8's gate), and RETRACTION, which keeps
 * the bare form because a legacy untagged row must stay deletable
 * (`retractSupersedes` included). A stale teacher produces a call the gate
 * then rejects, and the rejection reads as a bug rather than a rule; this
 * file is in the enumerated surface set that pins against exactly that.
 *
 * Ticket 05 (read-write-contract spec "结算(直写改造)"): DIRECT WRITE, not
 * staged — this call validates fully right now AND lands, in this same
 * transaction, before the tool result returns. There is no `commit` left to
 * wait for a write's own durability; `commit` is repurposed by ticket 06 to
 * claim validity + a run summary + the job's terminal mark (see its own
 * description below).
 */
export const SETTLEMENT_NOTE_TOOL_DESCRIPTION =
  "WRITE a turn's note, type/tags or edges, OR this " +
  "session's narrative — lands immediately, in this same call. Hindsight " +
  "work: supply what is missing, correct what is wrong, retract what is " +
  "false, judged by the Memory Rubric in the prompt. " +
  "Exactly one of `turn` (\"S<session>/T<prompt>\", from the writable set " +
  "this prompt declares) or `session` (\"S<session>\", this session). " +
  "On `turn`: title/content/insight, type/tags and the edge fields, only " +
  "for a turn in that writable set; omit to leave alone. A first note for a " +
  "turn needs title and content together. A field that already holds " +
  "something needs `mode.<field>: \"write\"` (the full replacement text or " +
  "set) or the edit form `{ mode: \"edit\", oldString, newString }` for one " +
  "exactly-matched span — the same rule, and the same words, the main " +
  "agent's own `note` uses; a whole-field `write` over text your own " +
  "`recall` delivered only truncated is refused, and the edit form is the " +
  "way through. " +
  "Each field is checked and applied " +
  "INDEPENDENTLY: if another writer (the main agent's own later note, or a " +
  "prior settlement attempt) touched a field since this dispatch's context " +
  "was read, that ONE field yields (reported in the receipt, not written) " +
  "while the other still lands. " +
  "override/narrows/extends/indexes/consume/grounds/verifies/refutes: " +
  "address lists — the SAME eight relations and legality validator the main " +
  "agent's own `note` tool uses. ASSERTION takes two entry forms and ALL " +
  "EIGHT words accept either: a bare address acts on the cited turn itself, " +
  "a `{turn, tags}` entry acts on the named lane(s). NO word requires a " +
  "tag — lane tags are yours to place with hindsight, never a shape the main " +
  "agent owed. A tagged entry is checked against the lane REGISTRY, per tag, " +
  "in this order: the tag must be canonical (NFC, trimmed, lowercase, no " +
  "interior whitespace); the lane must already be DECLARED (remember " +
  "declare) in the segment of BOTH endpoint turns — a homeless endpoint is " +
  "refused naming the turn, and a cross-segment edge needs the declaration on " +
  "both sides; and every tag must already be on both this turn's and the " +
  "target's own tags. Two further refusals: a SELF edge never carries a tag " +
  "(a one-node loop is not a lane), and a second row for the same pair and " +
  "relation may not share a tag with one already stored — widen an edge's " +
  "lanes by retracting it and re-writing it once with the union. " +
  "An edge stands on its own: no prose citation, no " +
  "pre-existing link between the two turns, and one pair may carry several " +
  "relations at once; a structurally illegal call (wrong phase, an illegal " +
  "tag, an illegal self-citation) is rejected, naming what is missing. " +
  "Writing an edge also needs THIS run's own current read of the citing " +
  "turn's relations — a relation write states how that turn's edges stand, " +
  "so recall the turn with `filter={fields:[\"relations\"]}` first (Step 0's " +
  "own field list already delivers it) or the call is refused naming that " +
  "read; your own edge writes keep the set current afterwards. " +
  "RETRACTION is the other half and keeps the BARE form for legacy stock: " +
  "each relation has a retract… mirror (retractOverride …), plus " +
  "`retractSupersedes` for the frozen-legacy ninth word no assertion field " +
  "offers at all. An untagged entry deletes the bare row and a tagged one " +
  "deletes that exact tag-set row; an address carrying no such edge rejects " +
  "the call, naming it, and nothing is deleted. " +
  "Which relation, if any, is the Memory Rubric's own " +
  "vocabulary above — this call only enforces phase domains, tag legality " +
  "and the self-citation gate. " +
  "On `session`: `title`/`content` only — type/tags/edges are refused. " +
  "A field that already holds something needs `mode.<field>`: \"write\" " +
  "replaces it whole (supply the finished text), or the edit form " +
  "`{ mode: \"edit\", oldString, newString }` swaps one exactly-matched span " +
  "inside it (`oldString` must match exactly once; add to the end by " +
  "anchoring on the current last line and putting that line plus your new " +
  "text in `newString`). With the edit form the field's own value is not " +
  "also supplied — the new text belongs in `newString`.";

/**
 * The `remember` tool's settlement-side call contract — `propose` (ticket 05),
 * `reassign` (ticket 08), `create` (ticket 04, edge-mechanism-revision D6) and
 * the two lane verbs `declare`/`undeclare` (lane-declaration D4, ticket 02)
 * are the legal verbs; `assign` stays dead (ticket 05). Registered under the
 * SAME tool name the main agent's own `remember` uses, a settlement-specific
 * shape, the same relationship the `note` facade already has to the main
 * agent's `note` tool.
 */
const SETTLEMENT_REMEMBER_TOOL_DESCRIPTION =
  "WRITE a text-only task proposal, a membership correction, a new " +
  "segment, or a lane declaration — lands immediately, in this same call. " +
  "action: \"propose\", \"reassign\", \"create\", \"declare\" or " +
  "\"undeclare\". " +
  "propose: addresses (one or more \"S<session>/T<prompt>\" turn " +
  "addresses — a single homeless turn may open its own proposal, or name a " +
  "cluster forming ONE coherent task) + title (a short suggested name) — " +
  "stores a text-only suggestion for the user to confirm next session. " +
  "Idempotent on the address SET (order-independent): repeating the same " +
  "set (even after a retry) matches the earlier proposal instead of " +
  "storing a second one. NEVER creates a segment and is never auto-adopted " +
  "— do not propose an incoherent grab-bag. " +
  "reassign: turns (one or more \"S<session>/T<prompt>\" addresses to " +
  "correct) + id (any OPEN \"E<n>\", on this session's roster or not — a " +
  "turn's right home is often a segment this session never attached) or id " +
  "omitted to clear ownership (homeless). Correct a DISPLAYED mismatch; a " +
  "closed segment, or an id naming nothing, is refused. " +
  "create: title (the new segment's own name, written for the task's actual " +
  "shape) + optional turns to seed as its members. The segment is attached " +
  "to this session, so the next window sees it on the roster — check that " +
  "roster first: joining an existing segment beats minting a new one. " +
  "declare: id (an OPEN \"E<n>\") + tag (ONE lane tag) — mints the lane a " +
  "tagged edge may then name. Lanes are YOURS: a tagged edge is refused until " +
  "the lane is declared in the segment of BOTH its endpoints, so declare " +
  "first, then tag. The tag must already be canonical — NFC, trimmed, " +
  "lowercase, no interior whitespace — and a non-canonical value is refused " +
  "naming the exact problem rather than quietly normalized, so \"write-gate\" " +
  "and \"Write-Gate\" can never become two lanes. A tag already among that " +
  "segment's curated tags is refused: the two vocabularies never overlap. " +
  "Continue an EXISTING declared tag (the segment card lists them) before " +
  "declaring a fresh one. " +
  "undeclare: id + tag — removes a lane, refused while any edge in the " +
  "segment still carries the tag, naming how many. " +
  "Never required — this window may finish without ever calling this tool.";

/**
 * rubric-v10 ticket 06 (spec "settlement agent (v2 duty)"): the four-report
 * lane checker, wired through the SAME `shared/lane-checker.ts` core the CLI
 * renders (`scripts/lane-check.ts`) — no digraph, and no parameters: the
 * scope is always this dispatch's own IMMUTABLE WRITABLE SET
 * (`request.writableTurnIds`, peer round T1466 finding P1-1 — formerly the
 * job's prompt-number range, which is strictly narrower), never a scope the
 * model could name itself, so there is nothing for it to get wrong here.
 * Advisory only (spec: "findings
 * enter the agent's EXISTING supply/correct/propose judgment... never an
 * automatic write obligation") — this tool computes and reports, it never
 * writes.
 */
const SETTLEMENT_LANE_CHECK_TOOL_DESCRIPTION =
  "Run the lane checker over THIS window's own writable set (no parameters) and " +
  "return its findings as compact numbers and names — never a digraph, " +
  "never a write. The output splits in two. ERRORS come first: states the " +
  "grammar forbids, each naming the turn it is ANCHORED at — a relation word " +
  "outside the eight-word vocabulary (E2), an empty or out-of-vocabulary turn " +
  "type (E3), a tagged edge whose tags are missing from an endpoint turn's " +
  "own tags (E4), a lane with a second start or a second end (E5). An " +
  "untagged extends/narrows is NOT an error — no word requires a lane tag. " +
  "Commit refuses " +
  "while any error anchored inside your writable range remains, so repair " +
  "those (retag, retract and re-add, or re-type) and re-run. An error " +
  "anchored OUTSIDE your range is another window's work — leave it. " +
  "Everything after the ERRORS block is WARNINGS: aspirational facts, " +
  "never enforced. Report 1: per-lane statistics (members, edge counts, a " +
  "closed-valid/closed-invalid/open state, who cites a member from outside " +
  "— grounds, consume-class use, or testimony; a lane cited only by " +
  "consume is still ADOPTED, not unused). Report 2: whether " +
  "each lane's members sit in one connected component (severed if not). " +
  "Report 3: components several lanes' members share. Report 4, three " +
  "blocks: inter-lane interface counts with terminus-bypass edges; " +
  "start-to-terminus path counts, plain and folded across cross-phase " +
  "citations (facts, no target); time-order violations (an edge citing " +
  "the future). ATTRIBUTION, the two warnings that replaced the retired " +
  "tag mandate and the ones that are most often yours: an UNATTRIBUTED " +
  "CLUSTER is 4+ turns no lane claims, joined to each other by untagged " +
  "edges (membership is an EDGE fact — a turn's own tags never make it a " +
  "member; an untagged `indexes` excuses only the turns it actually " +
  "aggregates, and the rest still counts). LANE PROLIFERATION is a segment " +
  "declaring more lanes than max(1, 0.05 x its member turns). Both name " +
  "their numbers, both are debt rather than a defect: the repair is a " +
  "`declare` plus a tagged edge, or fewer lanes — never a rewrite of the " +
  "turns. Treat a WARNING as a CANDIDATE for the same supply/correct/ " +
  "propose judgment every other duty above uses — never call this more " +
  "than once, and never let its output alone justify a write without the " +
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
const SETTLEMENT_COMMIT_TOOL_DESCRIPTION =
  "Finish this window: verify your job lease is still valid, report what " +
  "this run actually wrote, and mark the job durably complete. Call this " +
  "once you believe the window is done — whether or not you wrote " +
  "anything; every `note`/`remember` call already landed the instant it " +
  "ran, so an empty-handed `commit` (nothing to propose or correct) is a " +
  "normal, clean finish, not a no-op to avoid. This is the ONLY way the " +
  "job itself is marked done — without it, the window is retried later " +
  "even though your writes already stand. " +
  "Commit REFUSES while any state the grammar forbids still anchors on a " +
  "turn inside your writable set — a relation word outside the eight (E2), " +
  "an empty or out-of-vocabulary turn type (E3), a tagged edge whose tags " +
  "are missing from an endpoint turn's own tags (E4), a lane with a second " +
  "start or a second end (E5). An untagged extends/narrows never blocks a " +
  "commit: no word requires a lane tag. " +
  "The refusal lists every one with its address and the move " +
  "that clears it; repair them and call `commit` again — a refusal costs " +
  "you nothing and is not a failed attempt. Errors anchored OUTSIDE your " +
  "writable set are another window's work and never block you. " +
  "If your job lease has been " +
  "reclaimed, commit refuses and no further commit from this run will " +
  "ever succeed — stop making tool calls.";

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

/** One error instance as a repair line: what is wrong, where, and the move that clears it. */
function describeCommitGateError(db: Database, error: LaneCheckerError): string {
  const anchor = turnAddressFor(db, error.anchorId);
  switch (error.class) {
    // E1 (an untagged extends/narrows) is RETIRED with the tag mandate
    // (lane-declaration ticket 02): the checker no longer computes it, so the
    // gate has nothing to refuse over and no repair line to hand back.
    case "E2":
      return (
        `[E2] ${anchor}: "${error.relation}" -> ${turnAddressFor(db, error.citedId)} is outside the eight-word ` +
        "relation vocabulary. Retract it; re-add a legal relation if the link still holds."
      );
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
    case "E5":
      // The repair is a CHOICE between two shapes, so the line names the
      // canonical node this one dangles beside — neither move is decidable
      // without knowing which node the lane already runs from/to
      // (`shared/lane-checker-render.ts` says the same thing for the same
      // reason). Tag-mandate ticket 06 gave this class its own case: it used
      // to fall through to the bare default below, which handed the agent an
      // anchor and no move at all — a refusal it could not act on.
      //
      // TWO T1466 REPAIRS TO THE COPY.
      //
      //   1. It names `error.nodeId` (finding P1-3's hand-off). The anchor is
      //      the EDGE-OWNING CITER now, which for an extra SOURCE is a
      //      DIFFERENT turn from the dangling node — so "this turn dangles"
      //      was simply false there, and the agent was sent to re-shape a
      //      turn the report never accused. The parenthetical says why the
      //      refusal is nonetheless the anchor's: it owns the only in-lane
      //      row touching the dangling node, which is the repair power the
      //      anchor field exists to guarantee.
      //   2. (RETIRED by lane-declaration spec Rev 2, D5, v11 — superset
      //      BRANCH no longer exists; the paragraph below described it.) A
      //      lane is now ONE tag, not a set, so "retag onto a superset" is no
      //      longer a repair move at all — an independent line of work
      //      simply takes a DIFFERENT tag, with no set relationship to the
      //      original; relating the two is narration's job, not the tag
      //      mechanism's.
      return (
        `[E5] ${anchor}: lane {${error.key.tag}} has a second ${error.role} — ` +
        `${turnAddressFor(db, error.nodeId)} dangles beside ${turnAddressFor(db, error.canonicalId)}, ` +
        "and a lane has exactly one start and one end" +
        (error.anchorId === error.nodeId
          ? ""
          : `; you own the edge into ${turnAddressFor(db, error.nodeId)}, which is why this one is yours to repair`) +
        ". Retag this chain onto a DIFFERENT tag of its own — a lane is a single tag, so an " +
        "independent line of work simply takes a different tag (there is no tag-SET relationship " +
        "between lanes any more; relate the two lines in narration, not in the tag) — or bridge it " +
        "to the lane's real start/end with an edge the content actually supports."
      );
    default: {
      // Exhaustive over `LaneErrorClass` today (E2-E5; E1 retired with the
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
 *     `writableTurnIds` is the ONLY question asked of it. An error anchored
 *     outside blocks its OWN window and never this one — without that
 *     scoping a single bad out-of-window edge pins a window on a
 *     permanently failing commit, the terminal-state trap (spec "Anchoring
 *     and repairability", the burned window_start precedent S15069/T1410).
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
): string | null {
  const { result } = checkWindowLanes(db, scope);
  const blocking = result.errors.filter((error) => scope.writableTurnIds.has(error.anchorId));
  if (blocking.length === 0) {
    return null;
  }
  const outOfScope = result.errors.length - blocking.length;
  return [
    `Commit refused — ${blocking.length} error(s) the grammar forbids still anchor inside your ` +
      "writable set. NOTHING was committed and this is NOT a failed attempt: repair these " +
      "and call `commit` again in this same run.",
    ...blocking.map((error) => `  ${describeCommitGateError(db, error)}`),
    outOfScope > 0
      ? `(${outOfScope} further error(s) anchor OUTSIDE your writable set — another window's work, not listed and not blocking.)`
      : null,
    "`lane_check` shows the same list, plus the warnings, without a commit attempt.",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
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
    const turnFacadeContext: SettlementTurnFacadeContext = {
      jobId: request.jobId,
      claimGeneration: request.claimGeneration,
      sessionId: request.sessionId,
      // ONE definition of the writable set (tag-mandate ticket 05): the
      // facade's range check reads the SAME `request.writableTurnIds` the
      // commit gate judges anchors against. The facade's field keeps its
      // older name (`reviewableTurnIds`) because the membership facade shares
      // that interface; what it CARRIES is this dispatch's declared writable
      // set, closure included — nothing recomputes "window ∪ rendered
      // lookback" independently any more.
      reviewableTurnIds: request.writableTurnIds,
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
    const settlementReaderId = claimWriterId(request.jobId, request.claimGeneration);
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
    const writes = createSettlementDirectWriteEngine({
      db: options.db,
      context: turnFacadeContext,
      now: options.now,
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
    const leasedTool = ((
      name: string,
      description: string,
      shape: unknown,
      handler: (...handlerArgs: never[]) => unknown,
    ) =>
      toolImpl(
        name as never,
        description as never,
        shape as never,
        (async (...handlerArgs: never[]) => {
          touchNoteSettlementJobLease(
            options.db,
            request.jobId,
            request.claimGeneration,
            nowEpoch(),
          );
          return handler(...handlerArgs);
        }) as never,
      )) as unknown as typeof toolImpl;

    const server = createSdkMcpServerImpl({
      name: "mnemo",
      version: "0.19.0",
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
          async (args: SettlementTurnWriteInput) => writes.writeNote(args),
        ),
        leasedTool(
          "remember",
          SETTLEMENT_REMEMBER_TOOL_DESCRIPTION,
          settlementMembershipWriteInputShape,
          async (args: SettlementMembershipWriteInput) => writes.writeMembership(args),
        ),
        leasedTool(
          "commit",
          SETTLEMENT_COMMIT_TOOL_DESCRIPTION,
          {},
          async () => {
            // THE COMMIT GATE (tag-mandate ticket 05). It runs BEFORE
            // `writes.commit()` and, on refusal, INSTEAD of it — which is
            // exactly what makes a refusal cost no attempt: nothing touches
            // the job row, so the job stays `claimed` with its attempt count
            // untouched and the agent may repair and call `commit` again in
            // this same run, like any other rejected tool call. Attempts are
            // consumed only where they always were — by the dispatch layer,
            // when a run ENDS without the job ever reaching `done`
            // (worker/note-settlement-dispatch.ts).
            //
            // Skipped once this run has already committed: `commit` is
            // idempotent within a run (the engine returns "Already
            // committed"), and re-judging a window whose job row is already
            // terminal would answer a question nothing can act on.
            if (writes.getLastCommitMetrics() === null) {
              const refusal = evaluateSettlementCommitGate(options.db, {
                writableTurnIds: request.writableTurnIds,
              });
              if (refusal !== null) {
                return textResult(refusal);
              }
            }
            return writes.commit();
          },
        ),
        leasedTool(
          "lane_check",
          SETTLEMENT_LANE_CHECK_TOOL_DESCRIPTION,
          {},
          async () => {
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
              writableTurnIds: request.writableTurnIds,
            });
            return textResult(
              renderLaneCheckerReports(result, buildLaneAnchorAddresses(turns)),
            );
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
      if (request.signal) {
        request.signal.removeEventListener("abort", forwardAbort);
      }
    }
  };
}
