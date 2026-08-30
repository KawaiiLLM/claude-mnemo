import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { z } from "zod";

import { parseTurnAddress } from "../mcp/note";
import { RELATION_FIELD_ENTRIES, RETRACTION_FIELD_ENTRIES } from "../db/citations";
import { isMachineTag, loadDeclaredLaneTags } from "../db/turn-tag-gate";
import { loadLaneCheckScope } from "../db/lane-checker-load";
import { checkCanonicalLaneTag, resolveTurnAddress } from "../db/lanes";
import { TASKLESS_TASK_SCOPE_ID } from "../db/homeless-record";
import type { NoteSettlementWorklistLane } from "../db/note-settlement-snapshots";
import { getSegment } from "../db/segments";
import { getTurnById } from "../db/turns";
import { checkLanes } from "../shared/lane-checker";
import {
  ORTHOGONALITY_LAW,
  isTopicTag,
  phaseBearingNameRefusal,
  topicTagsOf,
} from "../shared/topic-tag";

/**
 * STAGE 1 — THE TOPIC PASS's SHARED LOGIC (staged-settlement spec Rev 5,
 * §Solution stage 1; ticket 06). Ticket 04 retired the standalone SDK query
 * and dispatch this module used to also host — the unified run
 * (`note-settlement-sdk-query.ts`'s `createUnifiedNoteSettlementSdkQuery`) is
 * now the sole registration site for the topic pass's tool surface, and it
 * imports every rule below rather than duplicating it. What survives here is
 * the pure, model-independent machinery that surface needs: the tool
 * description text, the phase-token/lane-name predicate, the transition GATE,
 * and the projection/supersession logic `finalize`'s handler runs.
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

/**
 * `summary`'s ceiling — the same 1000-character contract `commit`'s own
 * report carries. Exported (ticket 03) so the unified run's `finalize`
 * handler validates against the SAME number rather than a second literal.
 */
export const STAGE_ONE_SUMMARY_MAX_CHARS = 1000;

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
 *
 * Ticket 08 lifted the refusal SENTENCE into `shared/topic-tag.ts`'s
 * `phaseBearingNameRefusal`, unchanged in substance, so the main agent's own
 * `remember(retag)` prints the same one; the "Refused:"/"Nothing was written."
 * framing stays here because it is this surface's convention, not the
 * predicate's.
 */
export function checkStageOneLaneTag(tag: string): string | null {
  const canonical = checkCanonicalLaneTag(tag);
  if (!canonical.ok) {
    return `Refused: ${canonical.message} Nothing was written.`;
  }
  const phaseRefusal = phaseBearingNameRefusal("lane name", tag);
  if (phaseRefusal === null) {
    return null;
  }
  return `Refused: ${phaseRefusal} Nothing was written.`;
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

  // The topic debt is asked of the LIVE turns the projection already resolved.
  // `loadLaneCheckScope` applies the liveness predicate, so a rolled-back turn
  // never appears here — but a COMPACT MARKER does (the loader has no compact
  // skip), and both write faces categorically refuse it ("is a compact marker,
  // not a turn"), so a debt raised on one is a debt no tool can discharge:
  // that exact deadlock abandoned the first live windows (S18993 T41, job
  // 140). The gate skips what the write path refuses, on the same predicate
  // the facade judges by.
  const topicDebts: number[] = [];
  for (const turn of projection.turns) {
    if (!scope.windowTurnIds.has(turn.id)) {
      continue;
    }
    const stored = getTurnById(db, turn.id);
    if (!stored || stored.type.includes("compact")) {
      continue;
    }
    if (topicTagsOf(stored.tags).length === 0) {
      topicDebts.push(turn.id);
    }
  }

  // THE EXACT PROJECTION SET (final review, finding 5). A member's final
  // `tags` are its task tag + the lanes assigned + every `topic:` word, and
  // the projection is REPLACEMENT semantics — a word the projection does not
  // assign is removed. Nothing enforced that at the transition, so a turn
  // could carry a legacy free-form word out of stage 1 untouched: it is not a
  // lane, so no snapshot lists it and no debt is ever raised for it; it is not
  // a topic word, so nothing preserves it on purpose; and it sits in `tags`
  // beside the real vocabulary as a decoy for every later reader — which is
  // exactly the vocabulary-decoy disease this whole redesign exists to end.
  // Refused by NAME, because "some tag is wrong" is not a repair instruction.
  const strayTags: { turnId: number; tag: string }[] = [];
  const declaredBySegment = new Map<number, Set<string>>();
  for (const turn of projection.turns) {
    if (!scope.writableTurnIds.has(turn.id)) {
      continue;
    }
    const stored = getTurnById(db, turn.id);
    // The compact skip, same reason as the topic loop's: a marker's tags are
    // unreachable by any write face, so a debt on them cannot be repaired.
    if (!stored || stored.type.includes("compact")) {
      continue;
    }
    const segmentId = owningSegmentId(db, turn.id);
    let legal = segmentId === null ? undefined : declaredBySegment.get(segmentId);
    if (segmentId !== null && !legal) {
      // The TASK's own tag(s) plus the lanes DECLARED in that task — the two
      // closed vocabularies a turn's `tags` may draw from, read from the same
      // tables the write gate reads so the gate and the checker cannot drift.
      legal = new Set(getSegment(db, segmentId)?.tags ?? []);
      for (const lane of loadDeclaredLaneTags(db, segmentId)) {
        legal.add(lane);
      }
      declaredBySegment.set(segmentId, legal);
    }
    for (const tag of stored.tags) {
      // Machine tags (`compact:` / `invalidated:` / `delivery:`) are
      // hook-owned: the write gate refuses introducing one and silently
      // preserves the stored ones, so flagging one here would demand a
      // removal the write path is built to prevent (spec D3b's own law —
      // machine tags never reach the agent vocabularies).
      if (isTopicTag(tag) || isMachineTag(tag) || legal?.has(tag)) {
        continue;
      }
      strayTags.push({ turnId: turn.id, tag });
    }
  }

  if (typeDebts.length === 0 && topicDebts.length === 0 && strayTags.length === 0) {
    return null;
  }

  const lines: string[] = [
    `finalize refused — ${typeDebts.length + topicDebts.length + strayTags.length} turn(s) in this window still owe ` +
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
  if (strayTags.length > 0) {
    lines.push(
      `TAGS (${strayTags.length}) — a word that is neither the turn's own task tag, nor a lane ` +
        "declared in that task, nor a `topic:` word:",
    );
    for (const stray of strayTags) {
      lines.push(
        `  ${turnAddressFor(db, stray.turnId)}: ${JSON.stringify(stray.tag)} — write this turn's ` +
          "`tags` again without it, or declare it as a lane in its own task if that is what it is.",
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
  /**
   * Every writable turn this projection HOMED: it belongs to a task and
   * carries at least one lane declared in that task (final review, finding 2).
   *
   * A turn that has a home cannot still be homeless, and its old disposition
   * says otherwise until something ends it — which is what the transition's
   * supersession mappings do. Ascending, and derived from the SAME per-turn
   * read the worklist is derived from, so "this turn is in lane L" and "this
   * turn is homed" can never disagree.
   */
  homedTurnIds: number[];
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
  const homedTurnIds: number[] = [];
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
    let homed = false;
    for (const tag of [...nextTags].sort()) {
      if (!declared.has(tag)) {
        continue;
      }
      // A lane declared in the turn's OWN owning task: the turn has a task and
      // a line inside it, which is exactly what "homed" means.
      homed = true;
      const key = `${segmentId}:${tag}`;
      if (seenLane.has(key)) {
        continue;
      }
      seenLane.add(key);
      worklist.push({ segmentId, laneTag: tag });
    }
    if (homed) {
      homedTurnIds.push(turnId);
    }
  }

  return { removedLanes, worklist, homedTurnIds };
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

/**
 * A `S<n>/T<m>` address resolved to a writable turn id, or `null` when it is
 * neither. Exported (settlement-execution-repair ticket 03) so the unified
 * run's `finalize` handler (`note-settlement-sdk-query.ts`) resolves homeless
 * addresses through this one function — the "no duplicated tool definitions"
 * discipline the ticket asks for. Ticket 04 retired the stage-1-only SDK
 * query and dispatch that used to call this too (the unified query is now
 * the sole registration site for the topic pass's own tool surface); this
 * function survives because it is not a tool() call site, only a shared
 * pure lookup.
 */
export function resolveWritableTurn(
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
