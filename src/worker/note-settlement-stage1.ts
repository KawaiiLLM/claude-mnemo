import {
  createSdkMcpServer,
  query,
  tool,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { z } from "zod";

import {
  MNEMO_TOOL_DESCRIPTIONS,
  timelineInputShape,
  workerRecallInputShape,
} from "../mcp/definitions";
import { createDatabaseBackedHandlers } from "../mcp/handlers";
import { parseTurnAddress } from "../mcp/note";
import { RELATION_FIELD_ENTRIES, RETRACTION_FIELD_ENTRIES } from "../db/citations";
import { loadDeclaredLaneTags } from "../db/turn-tag-gate";
import { loadLaneCheckScope } from "../db/lane-checker-load";
import { checkCanonicalLaneTag } from "../db/lanes";
import {
  computeSettlementWritableTurnIds,
  getNoteSettlementJob,
  transitionNoteSettlementJobToEdges,
  type NoteSettlementJob,
  type NoteSettlementStage,
} from "../db/note-settlement";
import { TASKLESS_TASK_SCOPE_ID } from "../db/homeless-record";
import type { NoteSettlementWorklistLane } from "../db/note-settlement-snapshots";
import { getTurnById } from "../db/turns";
import { claimWriterId } from "../db/write-gate";
import { touchNoteSettlementJobLease } from "../db/note-settlement";
import { buildIsolatedEnv } from "../mnemosyne/env";
import { checkLanes } from "../shared/lane-checker";
import { DEFAULT_CONFIG, DEFAULT_NOTE_SETTLEMENT_MODEL, type MnemoConfig } from "../shared/config";
import { findPhaseToken, ORTHOGONALITY_LAW, topicTagsOf } from "../shared/topic-tag";
import { resolveClaudeCodeExecutablePath } from "./claude-executable";
import { classifySettlementFailure } from "./note-settlement-dispatch";
import {
  buildNoteSettlementContext,
  resolveSettlementScopeProvenance,
  resolveSettlementWritableSet,
  type NoteSettlementContext,
  type SettlementScopeProvenance,
} from "./note-settlement-context";
import { createSettlementDirectWriteEngine } from "./note-settlement-direct-write";
import {
  settlementMembershipWriteInputShape,
  type SettlementMembershipWriteInput,
} from "./note-settlement-membership-facade";
import { createSettlementStopHook } from "./note-settlement-stop-hook";
import {
  settlementTurnWriteInputShape,
  type SettlementTurnFacadeContext,
  type SettlementTurnWriteInput,
} from "./note-settlement-turn-facade";
import type {
  NoteSettlementDispatch,
  NoteSettlementDispatchOutcome,
} from "./note-settlement";
import {
  NOTE_SETTLEMENT_STAGE_ONE_SYSTEM_PROMPT,
  renderNoteSettlementStageOnePrompt,
} from "./note-settlement-stage1-prompt";

/**
 * STAGE 1 — THE TOPIC PASS (staged-settlement spec Rev 5, §Solution stage 1;
 * ticket 06). This module is the pass's whole machinery: the tool surface it
 * runs against, the projection facts it collects as the run writes them, the
 * gate its terminal call is judged by, and the dispatch that drives it.
 *
 * ## Why the toolset is here rather than in `note-settlement-sdk-query.ts`
 *
 * COMMIT-UNREACHABILITY BY TOOLSET (ticket 03's accepted deviation). Stage 1
 * must be unable to reach `commit` — not discouraged from it, unable — and the
 * CAS stays stage-agnostic, so the mechanism cannot be a check inside `commit`
 * itself. The only remaining mechanism is a toolset that does not contain the
 * tool, and a toolset is a property of a registration site. Stage 2's
 * registration site registers `commit`; therefore stage 1 needs its own. That
 * is the whole reason this file exists beside the other one rather than as a
 * flag on it.
 *
 * Two more absences ride the same mechanism, both spec requirements rather
 * than teaching: the `note` face refuses every RELATION field (edges are stage
 * 2's), and the `remember` face refuses `merge` and `justify` (consolidation
 * is "a later, explicit, user-ruled merge"; a justification is a commit-gate
 * artifact stage 1 has no commit to face).
 *
 * ## What `finalize` is, and why it is not `commit`
 *
 * `finalize` lands the STAGE TRANSITION: one fenced, NON-terminal transaction
 * that writes stage-1 metrics, the three snapshots, the per-member homeless
 * records and `stage='edges'`. The job stays `claimed`; nothing is marked
 * done, no cursor moves, no era is granted. It is the opposite end of the
 * spectrum from `commit` in exactly the dimension that matters — it publishes
 * nothing.
 *
 * ## The hard input contract this module exists to honour
 *
 * `snapshots.removedLanes` cannot be derived after the projection lands: the
 * final projection has already written the post-removal `tags` by the time the
 * transition runs, so what was taken away exists nowhere to be read back
 * (ticket 04's own words). An empty array means "no debts", never "unknown" —
 * miss one lane word and the removed-side-citer closure silently under-builds,
 * leaving an edge pointing at a lane its endpoint has left with nobody
 * authorized to repair it.
 *
 * So this module does NOT ask the model what it removed. It snapshots every
 * writable turn's `tags` BEFORE the run starts and diffs against the stored
 * value at `finalize` time. The diff is mechanical, it cannot be forgotten,
 * and it cannot be lied about. It deliberately OVER-reports rather than under:
 * every removed non-`topic:` word is offered, whether or not it was a declared
 * lane, because `head_tag` only ever holds lane tags anyway — a word that was
 * never a lane matches no edge and produces no debt, while a word wrongly
 * filtered out would produce a debt nobody discharges.
 */

// ---------------------------------------------------------------------------
// Tool surface
// ---------------------------------------------------------------------------

/**
 * The stage-1 child's WHOLE tool surface. `commit` is absent, and its absence
 * is the enforcement (see the module header). `lane_check` is absent too: its
 * report is about edges, drafts and severed connectivity, none of which this
 * pass may write, and a checker that names E4/E6 at a pass that cannot repair
 * them teaches a duty it does not have.
 */
export const NOTE_SETTLEMENT_STAGE_ONE_ALLOWED_TOOLS = [
  "mcp__mnemo__recall",
  "mcp__mnemo__timeline",
  "mcp__mnemo__note",
  "mcp__mnemo__remember",
  "mcp__mnemo__finalize",
] as const;

export const STAGE_ONE_NOTE_TOOL_DESCRIPTION =
  "WRITE a turn's note, type or tags — lands immediately, in this same call. " +
  "Hindsight work: supply what is missing, correct what is wrong, judged by " +
  "the Memory Rubric in your prompt. `turn` is an \"S<session>/T<prompt>\" " +
  "address from the writable set your prompt declares. " +
  "title/content/insight, type and tags; omit a field to leave it alone. A " +
  "first note needs title and content together. A field that already holds " +
  "something needs `mode.<field>: \"write\"` (the full replacement value) or " +
  "the edit form `{ mode: \"edit\", oldString, newString }` for one " +
  "exactly-matched span. Each field is checked and applied INDEPENDENTLY: a " +
  "field another writer touched since you read it yields and is reported, " +
  "while the others still land. " +
  "TAGS ARE THE PROJECTION. A whole-set `tags` write states the turn's task " +
  "tag, every lane it belongs to, and every `topic:` word it carries — a lane " +
  "word you leave out is REMOVED. A `topic:` word you leave out is REFUSED " +
  "instead: topic words are permanent, so restate them all. To correct one, " +
  "name it in `retireTopic` and put its replacement in the same `tags` write. " +
  "RELATIONS ARE NOT YOURS: the seven relation fields and their retract " +
  "mirrors are refused on this pass, naming stage 2, which reads the lanes " +
  "you draw and traces the edges inside them.";

export const STAGE_ONE_REMEMBER_TOOL_DESCRIPTION =
  "DECLARE a lane — lands immediately, in this same call. action: \"create\" " +
  "or \"delete\". A lane is (task, ONE tag): the same word in two tasks is two " +
  "different lanes. Tasks are NOT yours — you never open one, and a turn " +
  "belongs to the task whose tag it carries, so membership changes through " +
  "that turn's `note` tags, not through this tool. " +
  "create: id (an \"E<n>\" task) + tag (ONE lane tag) — mints a lane in that " +
  "task. The tag must be canonical (lowercase letters, digits and \"-\" only, " +
  "never leading or trailing, no \":\" prefix) and it must carry NO PHASE " +
  "WORD: research/design/implement/fix/review/verification and their families " +
  "are refused naming the offending word, because " + ORTHOGONALITY_LAW + ". " +
  "delete: id + tag — removes a lane, refused while any member turn still " +
  "carries the tag. " +
  "merge and justify are refused on this pass: folding two lanes into one is " +
  "the user's explicit call, made later, and a justification answers a commit " +
  "gate you never reach.";

export const STAGE_ONE_FINALIZE_TOOL_DESCRIPTION =
  "END this pass and hand the window to stage 2. Call it once the whole " +
  "writable set is audited, every window turn carries a `topic:` word, and " +
  "the final projection is written. It freezes what stage 2 may read — your " +
  "writable set, the (task, lane) worklist your projection touched, each of " +
  "those lanes' members, and the lane words your projection REMOVED — and " +
  "records any homeless group per member. It marks nothing done, publishes " +
  "nothing and grants nothing. " +
  "Takes `summary` (string, REQUIRED, max 1000 characters): the lines you " +
  "found, which were existing lanes and which are new, and where this window " +
  "forced a guess. " +
  "Takes `homeless` (optional): one entry per group of turns whose subject " +
  "has no legal task to live in — `label` (what the group is about), " +
  "`reason` (why nothing houses it) and `turns` (its member addresses). " +
  "Never open a task or mint a lane to avoid this list. " +
  "REFUSES while a turn in your writable set has an empty or " +
  "out-of-vocabulary `type`, or a window turn carries no `topic:` word. It " +
  "judges nothing else — an edge with an unplaced side is stage 2's work and " +
  "never blocks you. A refusal costs nothing and is not a failed attempt: " +
  "repair and call it again in this same run.";

const homelessGroupShape = z.object({
  label: z
    .string()
    .min(1)
    .max(120)
    .describe("What this group of turns is about — the name the line would have had, if a task could have held it."),
  reason: z
    .string()
    .min(1)
    .max(500)
    .describe("Why no task houses it — stated so a later window can tell whether its own task now covers these turns."),
  turns: z
    .array(z.string().min(1))
    .min(1)
    .describe('Its member turns, "S<session>/T<prompt>" addresses from your writable set.'),
});

export const STAGE_ONE_FINALIZE_INPUT_SHAPE = {
  summary: z
    .string()
    .describe("Required, max 1000 characters: the lines you found, existing versus new, and any guess this window forced."),
  homeless: z
    .array(homelessGroupShape)
    .optional()
    .describe("Groups with no legal task container, one entry each. Omit when every line found a task."),
};

/** `summary`'s ceiling — the same 1000-character contract `commit`'s own report carries. */
const STAGE_ONE_SUMMARY_MAX_CHARS = 1000;

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

// ---------------------------------------------------------------------------
// The lane-name predicate — SHARED with the `topic:` face
// ---------------------------------------------------------------------------

/**
 * The lane face of the PHASE-TOKEN PREDICATE (spec Rev 5, reviewer guardrail
 * 3). One implementation, two faces: `shared/topic-tag.ts`'s `findPhaseToken`
 * answers the question for both, and each face writes its own refusal because
 * each is refusing a different kind of word.
 *
 * Applied to lane CREATION only. Existing lanes stay grandfathered (spec, Out
 * of Scope: "retroactive renaming of existing lanes that would fail the
 * phase-token predicate … the predicate governs new writes"), which is also
 * why `delete` is not checked — refusing to delete a phase-bearing legacy lane
 * would lock in the very names the predicate exists to stop.
 */
export function checkStageOneLaneTag(tag: string): string | null {
  const canonical = checkCanonicalLaneTag(tag);
  if (!canonical.ok) {
    return `Refused: ${canonical.message} Nothing was written.`;
  }
  const phaseToken = findPhaseToken(tag);
  if (phaseToken === null) {
    return null;
  }
  return (
    `Refused: lane name ${JSON.stringify(tag)} contains the phase word ` +
    `${JSON.stringify(phaseToken)} — ${ORTHOGONALITY_LAW}. Name the subject the line is ` +
    "about and let each member's own type carry its phase. Nothing was written."
  );
}

// ---------------------------------------------------------------------------
// The stage-1 transition gate — FIELD SHAPE AND VOCABULARY, nothing else
// ---------------------------------------------------------------------------

export interface StageOneGateScope {
  writableTurnIds: ReadonlySet<number>;
  /** This job's OWN window ids — the only turns owing a `topic:` word. */
  windowTurnIds: ReadonlySet<number>;
}

/**
 * THE STAGE-1 GATE (ticket 06 acceptance 5). Its whole vocabulary is FIELD
 * SHAPE: a turn's `type` and a turn's `topic:` words, both of which are this
 * pass's own duties 1 and 2.
 *
 * WHAT IT DELIBERATELY DOES NOT JUDGE, and why the omission is the point: an
 * edge with an unplaced side (E6) or a side tag missing from its endpoint
 * (E4). Those anchor on relation grammar this pass cannot write — the `note`
 * face refuses every relation field — so a stage-1 gate that blocked on them
 * would manufacture an unresolvable terminal state, the same shape the round-4
 * per-provenance filter was written to close one level down. A window full of
 * pre-existing bare drafts transitions cleanly, and stage 2 meets them with
 * the authority to settle them.
 *
 * E3 is judged through the SAME `loadLaneCheckScope` -> `checkLanes` pass the
 * stage-2 gate runs, filtered to that one class: a second implementation of
 * "is this type legal" would be a second vocabulary, and the two would drift.
 * The topic half has no checker equivalent and is asked directly.
 *
 * Returns the refusal payload, or `null` when the pass may transition.
 */
export function evaluateStageOneTransitionGate(
  db: Database,
  scope: StageOneGateScope,
): string | null {
  const projection = loadLaneCheckScope(db, {
    kind: "turns",
    turnIds: [...scope.writableTurnIds],
  });
  const result = checkLanes(
    projection.turns,
    projection.edges,
    projection.outOfVocabularyEdges,
    projection.segmentFacts,
  );

  const typeDebts = result.errors.filter(
    (error) => error.class === "E3" && scope.writableTurnIds.has(error.anchorId),
  );

  // The topic debt is asked of the LIVE turns the projection already resolved
  // — `loadLaneCheckScope` applies the liveness predicate and the compact skip,
  // so a rolled-back turn or a compact marker never appears here and is never
  // asked for a subject word it could not have.
  const topicDebts: number[] = [];
  for (const turn of projection.turns) {
    if (!scope.windowTurnIds.has(turn.id)) {
      continue;
    }
    const stored = getTurnById(db, turn.id);
    if (!stored) {
      continue;
    }
    if (topicTagsOf(stored.tags).length === 0) {
      topicDebts.push(turn.id);
    }
  }

  if (typeDebts.length === 0 && topicDebts.length === 0) {
    return null;
  }

  const lines: string[] = [
    `finalize refused — ${typeDebts.length + topicDebts.length} turn(s) in this window still owe ` +
      "stage-1 work. NOTHING was transitioned and this is NOT a failed attempt: repair these and " +
      "call `finalize` again in this same run.",
  ];
  if (typeDebts.length > 0) {
    lines.push(`TYPE (${typeDebts.length}) — empty or outside the vocabulary:`);
    for (const error of typeDebts) {
      lines.push(`  ${turnAddressFor(db, error.anchorId)}: set a legal type on this turn.`);
    }
  }
  if (topicDebts.length > 0) {
    lines.push(`TOPIC WORD (${topicDebts.length}) — no \`topic:\` word on a window turn:`);
    for (const turnId of topicDebts) {
      lines.push(
        `  ${turnAddressFor(db, turnId)}: write what this turn was about, as one \`topic:\` word ` +
          "in its tags.",
      );
    }
  }
  lines.push(
    "Edges are not judged here: a bare or half-placed edge is stage 2's work and never blocks " +
      "this transition.",
  );
  return lines.join("\n");
}

/** A turn id in the address vocabulary every repair call actually takes. */
function turnAddressFor(db: Database, turnId: number): string {
  const turn = getTurnById(db, turnId);
  return turn ? `S${turn.sessionId}/T${turn.promptNumber}` : `turn #${turnId}`;
}

// ---------------------------------------------------------------------------
// The projection facts — collected from the database, never from the model
// ---------------------------------------------------------------------------

export interface StageOneProjection {
  /** Every `(turn, lane word)` pair the projection took away, under replacement semantics. */
  removedLanes: { turnId: number; laneTag: string }[];
  /** The ordered `(task, lane)` worklist, ascending by turn then by tag. */
  worklist: NoteSettlementWorklistLane[];
}

/**
 * Diff the frozen pre-run tag snapshot against what the turns now store, and
 * read the worklist off the post-run state.
 *
 * REMOVED LANES over-report by construction — see the module header. WORKLIST
 * entries are the `(owning segment, declared lane)` pairs the writable set's
 * turns now carry: a lane the projection created, a lane it assigned a member
 * to, and a lane it reused for a synonym with zero mutations all appear the
 * same way, which is exactly what "including synonym-reused lanes with zero
 * stage-1 mutations" asks for. A lane whose only members sit outside the
 * writable set is not this job's to work and does not appear.
 */
export function collectStageOneProjection(
  db: Database,
  priorTagsByTurn: ReadonlyMap<number, readonly string[]>,
  writableTurnIds: ReadonlySet<number>,
): StageOneProjection {
  const removedLanes: { turnId: number; laneTag: string }[] = [];
  const worklist: NoteSettlementWorklistLane[] = [];
  const seenLane = new Set<string>();
  const declaredBySegment = new Map<number, Set<string>>();

  for (const turnId of [...writableTurnIds].sort((a, b) => a - b)) {
    const turn = getTurnById(db, turnId);
    const nextTags = new Set(turn?.tags ?? []);

    for (const tag of priorTagsByTurn.get(turnId) ?? []) {
      // `topic:` words are never lane words and their removal has its own
      // (refused) path through the tag gate, so they can never appear here.
      if (tag.startsWith("topic:") || nextTags.has(tag)) {
        continue;
      }
      removedLanes.push({ turnId, laneTag: tag });
    }

    if (!turn) {
      continue;
    }
    const segmentId = owningSegmentId(db, turnId);
    if (segmentId === null) {
      continue;
    }
    let declared = declaredBySegment.get(segmentId);
    if (!declared) {
      declared = loadDeclaredLaneTags(db, segmentId);
      declaredBySegment.set(segmentId, declared);
    }
    for (const tag of [...nextTags].sort()) {
      if (!declared.has(tag)) {
        continue;
      }
      const key = `${segmentId}:${tag}`;
      if (seenLane.has(key)) {
        continue;
      }
      seenLane.add(key);
      worklist.push({ segmentId, laneTag: tag });
    }
  }

  return { removedLanes, worklist };
}

/**
 * A turn's OWNING task, by the same rule membership itself uses — the lowest
 * segment id among its membership rows (`db/note-settlement-snapshots.ts`'s
 * own lane-member read takes the identical `MIN(segment_id)`), so the worklist
 * and the member snapshot cannot disagree about which task a lane belongs to.
 */
function owningSegmentId(db: Database, turnId: number): number | null {
  const row = db
    .query<{ segmentId: number | null }, [number]>(
      `SELECT MIN(segment_id) AS segmentId FROM segment_members WHERE turn_id = ?`,
    )
    .get(turnId);
  return row?.segmentId ?? null;
}

/** A homeless group's member identity — a hash of its sorted turn ids, per the layer's caller-computed contract. */
export function homelessMemberFingerprint(turnIds: readonly number[]): string {
  return createHash("sha256")
    .update([...turnIds].sort((a, b) => a - b).join(","), "utf8")
    .digest("hex")
    .slice(0, 16);
}

// ---------------------------------------------------------------------------
// The query seam
// ---------------------------------------------------------------------------

export interface NoteSettlementStageOneQueryRequest {
  prompt: string;
  systemPrompt: string;
  model: string;
  maxThinkingTokens?: number | null;
  signal?: AbortSignal;
  jobId: number;
  claimGeneration: number;
  /** Always `"topics"` — carried rather than assumed, so the writer identity is built from the row. */
  stage: NoteSettlementStage;
  sessionId: number;
  writableTurnIds: ReadonlySet<number>;
  /** The three frozen buckets the transition's writable snapshot is written from. */
  scopeProvenance: SettlementScopeProvenance;
  contextBuiltAtEpoch: number;
  windowStart: number;
  windowEnd: number;
}

export interface NoteSettlementStageOneQueryResult {
  text: string;
  /** Did THIS run's own `finalize` land the transition? Advisory — the row is the authority. */
  finalized: boolean;
}

export type NoteSettlementStageOneQuery = (
  request: NoteSettlementStageOneQueryRequest,
) => Promise<NoteSettlementStageOneQueryResult>;

export interface CreateNoteSettlementStageOneSdkQueryOptions {
  db: Database;
  dataRoot: string;
  defaultProject?: string;
  queryImpl?: typeof query;
  createSdkMcpServerImpl?: typeof createSdkMcpServer;
  toolImpl?: typeof tool;
  agentEnv?: NodeJS.ProcessEnv;
  /** Epoch seconds at the moment of each individual tool write; injectable for tests. */
  now?: () => number;
}

export function createNoteSettlementStageOneSdkQuery(
  options: CreateNoteSettlementStageOneSdkQueryOptions,
): NoteSettlementStageOneQuery {
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
    request: NoteSettlementStageOneQueryRequest,
  ): Promise<NoteSettlementStageOneQueryResult> => {
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

    // THE PRE-RUN TAG SNAPSHOT — the one input to `removedLanes` that cannot
    // be reconstructed later (module header). Taken here, before a single tool
    // is registered, so nothing this run does can be missing from the diff.
    const priorTagsByTurn = new Map<number, readonly string[]>();
    for (const turnId of request.writableTurnIds) {
      priorTagsByTurn.set(turnId, getTurnById(options.db, turnId)?.tags ?? []);
    }

    // Stage 1 holds no provenance snapshot of its own: the writable snapshot is
    // written BY this pass's transition, so during the run every writable turn
    // carries full authority — which is the correct reading, since the
    // removed-side-citer class does not exist until the closure runs.
    const turnFacadeContext: SettlementTurnFacadeContext = {
      jobId: request.jobId,
      claimGeneration: request.claimGeneration,
      stage: request.stage,
      sessionId: request.sessionId,
      reviewableTurnIds: request.writableTurnIds,
      contextBuiltAtEpoch: request.contextBuiltAtEpoch,
    };
    const settlementReaderId = claimWriterId(
      request.jobId,
      request.claimGeneration,
      request.stage,
    );
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
      windowStart: request.windowStart,
      windowEnd: request.windowEnd,
    });
    const stopHook = createSettlementStopHook({
      db: options.db,
      jobId: request.jobId,
      claimGeneration: request.claimGeneration,
    });

    let finalized = false;

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
      version: "0.25.0",
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
              (await handlers.timeline?.(args))?.content[0]?.text ??
                "timeline unavailable",
            ),
        ),
        leasedTool(
          "note",
          STAGE_ONE_NOTE_TOOL_DESCRIPTION,
          settlementTurnWriteInputShape,
          async (args: SettlementTurnWriteInput) => {
            // EDGES ARE NOT STAGE 1'S (spec: stage 2 is the edge pass). The
            // shape is shared with stage 2's `note`, so the refusal is here
            // rather than in the schema — a settlement-only field list would
            // fork the two surfaces' vocabularies for one pass's sake.
            const reached = [...RELATION_FIELD_ENTRIES, ...RETRACTION_FIELD_ENTRIES]
              .map(([key]) => key)
              .filter((key) => (args as Record<string, unknown>)[key] !== undefined);
            if (reached.length > 0) {
              return textResult(
                `Parameter error: ${reached.join(", ")} ${
                  reached.length === 1 ? "is" : "are"
                } refused on the topic pass — edges belong to stage 2, which runs after you and ` +
                  "reads the lanes you draw. Nothing was written.",
              );
            }
            return writes.writeNote(args);
          },
        ),
        leasedTool(
          "remember",
          STAGE_ONE_REMEMBER_TOOL_DESCRIPTION,
          settlementMembershipWriteInputShape,
          async (args: SettlementMembershipWriteInput) => {
            const action = (args as { action?: string }).action;
            if (action === "merge") {
              return textResult(
                "Parameter error: merge is refused on the topic pass. Folding two lanes into one " +
                  "is the user's own explicit call, made later — when two of your lines turn out " +
                  "to be one subject, declare them both and let the merge be proposed. Nothing " +
                  "was written.",
              );
            }
            if (action === "justify") {
              return textResult(
                "Parameter error: justify is refused on the topic pass. A justification answers a " +
                  "commit gate about a severed lane's edges, and this pass writes no edges and " +
                  "reaches no commit. Nothing was written.",
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
          },
        ),
        leasedTool(
          "finalize",
          STAGE_ONE_FINALIZE_TOOL_DESCRIPTION,
          STAGE_ONE_FINALIZE_INPUT_SHAPE,
          async (args: { summary?: unknown; homeless?: unknown }) => {
            if (finalized) {
              return textResult(
                "Already finalized — this window has moved to stage 2. Stop making tool calls.",
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

            // THE GATE, BEFORE the transition and on refusal INSTEAD of it —
            // which is what makes a refusal cost no attempt: nothing touches
            // the job row, so the run repairs and calls again.
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
                // ALWAYS taskless (0, never NULL — the layer's own sentinel).
                // A homeless group is by definition one no task contains, and
                // stage 1 may not open a task, so there is no other value this
                // could legitimately take.
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
                  // The HARD INPUT CONTRACT: supplied for every lane word the
                  // projection removed, and an empty array here means "no
                  // debts", never "unknown" (ticket 04).
                  removedLanes: projection.removedLanes,
                },
                homelessGroups,
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
            return textResult(
              [
                `Finalized: job ${request.jobId} is now stage 2's, at transition ` +
                  `${transitioned.transitionSeq}.`,
                `  worklist lanes: ${projection.worklist.length}`,
                `  lane words removed: ${projection.removedLanes.length}`,
                `  homeless groups: ${homelessGroups.length}`,
                "The window is not settled and nothing is published — stage 2 writes the edges " +
                  "and owns the terminal commit. Stop making tool calls.",
              ].join("\n"),
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
          pathToClaudeCodeExecutable: resolveClaudeCodeExecutablePath(),
          env: {
            ...(options.agentEnv ?? buildIsolatedEnv(process.env, {})),
            FORCE_PROMPT_CACHING_5M: "1",
          },
          tools: [],
          allowedTools: [...NOTE_SETTLEMENT_STAGE_ONE_ALLOWED_TOOLS],
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
        if (message.type !== "result") {
          continue;
        }
        if (message.subtype !== "success" || message.is_error) {
          throw new Error(`note settlement stage 1 query failed (${message.subtype})`);
        }
        envelope = message.result;
      }
      if (envelope === null) {
        throw new Error("note settlement stage 1 query returned no result envelope");
      }
      return { text: envelope, finalized };
    } finally {
      if (request.signal) {
        request.signal.removeEventListener("abort", forwardAbort);
      }
    }
  };
}

/** A `S<n>/T<m>` address resolved to a writable turn id, or `null` when it is neither. */
function resolveWritableTurn(
  db: Database,
  sessionId: number,
  promptNumber: number,
  writableTurnIds: ReadonlySet<number>,
): number | null {
  const row = db
    .query<{ id: number }, [number, number]>(
      `SELECT id FROM turns WHERE session_id = ? AND prompt_number = ?`,
    )
    .get(sessionId, promptNumber);
  if (!row || !writableTurnIds.has(row.id)) {
    return null;
  }
  return row.id;
}

// ---------------------------------------------------------------------------
// The dispatch
// ---------------------------------------------------------------------------

export interface CreateNoteSettlementStageOneDispatchOptions {
  db: Database;
  runQuery: NoteSettlementStageOneQuery;
  config?: MnemoConfig;
  /** Epoch seconds. */
  now?: () => number;
  model?: string;
  logger?: Pick<Console, "warn" | "error">;
}

/**
 * THE REAL STAGE 1, replacing ticket 03's stub. Same seam the stage-2 dispatch
 * plugs into — `(job) => verdict` — so every scheduling property (lease,
 * generation fence, backoff, chaining, the post-hoc truth rule) stays exactly
 * where it was proved.
 *
 * The verdict is ADVISORY and this function knows it: it re-reads the row and
 * reports `transition: "edges"` only when the row itself says the transition
 * landed. A run whose `finalize` committed and then lost its verdict to a
 * crash is indistinguishable from out here — which is precisely why the
 * scheduler asks the row again anyway.
 */
export function createNoteSettlementStageOneDispatch(
  options: CreateNoteSettlementStageOneDispatchOptions,
): NoteSettlementDispatch {
  const db = options.db;
  const config = options.config ?? DEFAULT_CONFIG;
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const model = options.model ?? DEFAULT_NOTE_SETTLEMENT_MODEL;

  return async ({ job }): Promise<NoteSettlementDispatchOutcome> => {
    if (!config.settlementEnabled) {
      return {
        ok: false,
        reason: "note settlement is disabled",
        failureClass: "deterministic",
      };
    }

    const nowEpoch = now();
    const context: NoteSettlementContext | null = buildNoteSettlementContext(db, job, {
      nowEpoch,
    });
    if (!context) {
      return {
        ok: false,
        reason: `note settlement window has no session ${job.sessionId}`,
        failureClass: "deterministic",
      };
    }
    if (context.windowTurns.length === 0) {
      // Nothing to judge. The transition still has to land, or the job would
      // sit on stage 1 forever with no turns to give it anything to do — and
      // an empty snapshot is the honest record of an empty window.
      const empty = transitionNoteSettlementJobToEdges(
        db,
        job.id,
        job.claimGeneration,
        nowEpoch,
        { stage1Metrics: JSON.stringify({ summary: "empty window", worklistLanes: 0 }) },
      );
      return empty
        ? { ok: true, transition: "edges" }
        : {
            ok: false,
            reason: `note settlement stage 1 could not transition empty job ${job.id} (the row moved)`,
            failureClass: "deterministic",
          };
    }

    const writableTurnIds = computeSettlementWritableTurnIds(
      db,
      context.reviewableTurnIds,
    );
    const writableSet = resolveSettlementWritableSet(db, context, writableTurnIds);
    const scopeProvenance = resolveSettlementScopeProvenance(context, writableTurnIds);

    try {
      await options.runQuery({
        prompt: renderNoteSettlementStageOnePrompt(context, writableSet),
        systemPrompt: NOTE_SETTLEMENT_STAGE_ONE_SYSTEM_PROMPT,
        model,
        maxThinkingTokens: config.noteSettlementMaxThinkingTokens,
        jobId: job.id,
        claimGeneration: job.claimGeneration,
        stage: job.stage,
        sessionId: job.sessionId,
        writableTurnIds,
        scopeProvenance,
        contextBuiltAtEpoch: context.builtAtEpoch,
        windowStart: job.windowStart,
        windowEnd: job.windowEnd,
      });
    } catch (error) {
      // The row is asked even after a throw: `finalize` may have committed and
      // the failure may have landed on a later step, in which case stage 1 is
      // genuinely finished and reporting a failure would license a re-run of
      // judgment work that already stands.
      const afterThrow = getNoteSettlementJob(db, job.id);
      if (afterThrow?.stage === "edges") {
        return { ok: true, transition: "edges" };
      }
      return {
        ok: false,
        reason: `note settlement stage 1 call failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        failureClass: classifySettlementFailure(error),
      };
    }

    const settled: NoteSettlementJob | null = getNoteSettlementJob(db, job.id);
    if (settled?.stage === "edges") {
      return { ok: true, transition: "edges" };
    }
    return {
      ok: false,
      reason: `note settlement stage 1 ended without a transition (job ${job.id} is still on stage ${
        settled?.stage ?? "missing"
      })`,
      failureClass: "deterministic",
    };
  };
}
