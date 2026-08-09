import type { Database } from "bun:sqlite";

import type { CitationRelation } from "../db/citations";
import { runWriteTransaction } from "../db/database";
import {
  writeMemoryEdges,
  type EdgeNode,
  type EdgeProvenance,
} from "../db/memory-edges";
import {
  advanceNoteSettlementCursor,
  completeNoteSettlementJob,
  getNoteSettlementJob,
  NOTE_SETTLEMENT_MAX_ATTEMPTS,
  type NoteSettlementJob,
} from "../db/note-settlement";
import {
  parseQualifiedReferences,
  validateReferences,
  type ParsedReference,
} from "../db/references";
import {
  addSegmentMembers,
  applySegmentWrites,
  createSegment,
  findTopic,
  upsertTopic,
  type ExcludedSegmentWrite,
  type SegmentRecord,
  type SegmentWrite,
} from "../db/segments";
import { updateSessionSummaryRewrite } from "../db/sessions";
import { upsertShadowNote } from "../db/shadow-notes";
import type {
  NoteSettlementResponse,
  SettlementSegmentDirective,
} from "./note-settlement-response";

/**
 * Settlement write-back (spec D9, ticket 07).
 *
 * ONE transaction holds every per-session effect of a window — segments and
 * their members, the anchor and judged edges, the type/tag revision, the session
 * summary, the interior-hole reconstructions — together with the job completion
 * and the cursor advance. That grouping is the whole point: the cursor is what
 * says "this window is settled", so a cursor that moved without the writes, or
 * writes that landed without the cursor, both produce a window nobody will ever
 * settle correctly again.
 *
 * The generation check runs FIRST and inside the same transaction. A dispatch
 * whose lease expired lost the window to a newer attempt, and the correct
 * handling of its (possibly excellent) result is to throw it away whole.
 *
 * The single exception is an open segment another settlement rewrote while this
 * one was thinking. Its write is excluded by the revision CAS and returned to
 * the caller with the latest body, so the judgement for THAT segment replays in
 * a small supplemental transaction — the committed partition writes are not
 * rolled back for it (裁决 14).
 */

/** Relation an anchor citation in a segment body records. */
const ANCHOR_RELATION: CitationRelation = "builds-on";

/**
 * Anchors come from the segment's own text, so they are `text-ref`; the edges
 * the model classified explicitly are `judged` and outrank them on the
 * provenance lattice when both name the same pair.
 */
const ANCHOR_PROVENANCE: EdgeProvenance = "text-ref";
const JUDGED_PROVENANCE: EdgeProvenance = "judged";

export interface NoteSettlementWriteBackOptions {
  job: NoteSettlementJob;
  response: NoteSettlementResponse;
  nowEpoch: number;
  /** Turn ids this window may write a reconstruction note for (interior holes). */
  reconstructableTurnIds: ReadonlySet<number>;
  /** Segment ids the writer was shown — the exposure gate for `[E<n>]`. */
  exposedSegmentIds: ReadonlySet<number>;
  /** Ride turn recorded on reconstruction notes; the window's last turn. */
  rideTurnId: number | null;
  writerModel?: string | null;
  maxAttempts?: number;
  logger?: Pick<Console, "warn">;
}

export interface NoteSettlementSegmentConflict {
  directive: SettlementSegmentDirective;
  excluded: ExcludedSegmentWrite;
}

export interface NoteSettlementWriteBackCounts {
  segmentsCreated: number;
  segmentsExtended: number;
  /** New rows in the topic registry — spec D9's naming-drift alarm. */
  topicsMinted: number;
  topicsReused: number;
  membersAdded: number;
  anchorEdges: number;
  judgedEdges: number;
  rejectedReferences: number;
  notesReconstructed: number;
  notesRejected: number;
  summaryUpdated: boolean;
}

export interface NoteSettlementWriteBackResult
  extends NoteSettlementWriteBackCounts {
  committed: boolean;
  reason: string | null;
  conflicts: NoteSettlementSegmentConflict[];
}

const EMPTY_COUNTS: NoteSettlementWriteBackCounts = {
  segmentsCreated: 0,
  segmentsExtended: 0,
  topicsMinted: 0,
  topicsReused: 0,
  membersAdded: 0,
  anchorEdges: 0,
  judgedEdges: 0,
  rejectedReferences: 0,
  notesReconstructed: 0,
  notesRejected: 0,
  summaryUpdated: false,
};

/**
 * Parse one address token — `S12/T30`, `[S12/T30]`, `E47`, `[E47]`.
 *
 * The edge and member fields carry a bare token rather than an inline citation,
 * so they are bracketed here and handed to the SAME parser that reads a body.
 * One grammar, one place it is implemented (D7).
 */
export function parseAddressToken(token: string): ParsedReference | null {
  const trimmed = token.trim();
  const bracketed = trimmed.startsWith("[") ? trimmed : `[${trimmed}]`;
  const parsed = parseQualifiedReferences(bracketed);
  return parsed.length === 1 ? parsed[0]! : null;
}

interface ResolveResult {
  nodes: Map<string, EdgeNode>;
  rejected: number;
}

/**
 * Resolve address tokens to edge nodes through the production validator: the id
 * must exist AND must have been shown to this writer. An id that fails either
 * gate is logged and dropped — never stored, and never a reason to fail the
 * window it arrived with.
 */
function resolveTokens(
  db: Database,
  tokens: readonly string[],
  options: NoteSettlementWriteBackOptions,
): ResolveResult {
  const nodes = new Map<string, EdgeNode>();
  const references: ParsedReference[] = [];
  const tokenByRaw = new Map<string, string>();
  let rejected = 0;

  for (const token of tokens) {
    const parsed = parseAddressToken(token);
    if (!parsed) {
      rejected += 1;
      options.logger?.warn?.(
        `[claude-mnemo] settlement job ${options.job.id}: unparseable address "${token}"`,
      );
      continue;
    }
    tokenByRaw.set(parsed.raw, token);
    references.push(parsed);
  }

  const result = validateReferences(db, references, {
    writerSessionId: options.job.sessionId,
    exposedSegmentIds: options.exposedSegmentIds,
    logger: options.logger,
  });
  rejected += result.rejected.length;
  for (const accepted of result.accepted) {
    const token = tokenByRaw.get(accepted.reference.raw);
    if (token !== undefined) {
      nodes.set(token.trim(), accepted.node);
    }
  }

  return { nodes, rejected };
}

/** Anchor edges: every legal citation in a segment's body, segment → node. */
function writeAnchorEdges(
  db: Database,
  segment: SegmentRecord,
  options: NoteSettlementWriteBackOptions,
): { written: number; rejected: number } {
  const references = parseQualifiedReferences(segment.content);
  if (references.length === 0) {
    return { written: 0, rejected: 0 };
  }
  const { accepted, rejected } = validateReferences(db, references, {
    writerSessionId: options.job.sessionId,
    exposedSegmentIds: options.exposedSegmentIds,
    logger: options.logger,
  });
  const { written } = writeMemoryEdges(
    db,
    accepted.map((entry) => ({
      citing: { kind: "segment" as const, id: segment.id },
      cited: entry.node,
      relation: ANCHOR_RELATION,
      provenance: ANCHOR_PROVENANCE,
    })),
    options.nowEpoch,
  );
  return { written: written.length, rejected: rejected.length };
}

export function applyNoteSettlementWriteBack(
  db: Database,
  options: NoteSettlementWriteBackOptions,
): NoteSettlementWriteBackResult {
  const { job, response } = options;

  return runWriteTransaction(db, () => {
    const current = getNoteSettlementJob(db, job.id);
    if (
      !current ||
      current.claimGeneration !== job.claimGeneration ||
      current.status !== "claimed"
    ) {
      return {
        ...EMPTY_COUNTS,
        committed: false,
        reason:
          "settlement result discarded: the job was reclaimed under a new generation",
        conflicts: [],
      };
    }

    const counts: NoteSettlementWriteBackCounts = { ...EMPTY_COUNTS };
    const conflicts: NoteSettlementSegmentConflict[] = [];
    const landed: Array<{
      segment: SegmentRecord;
      directive: SettlementSegmentDirective;
    }> = [];

    // --- created segments -------------------------------------------------
    for (const directive of response.segments) {
      if (directive.action !== "create") {
        continue;
      }
      let topicId: number | null = null;
      if (directive.topic) {
        const existing = findTopic(db, directive.topic);
        const topic = upsertTopic(db, {
          name: directive.topic,
          aliases: directive.topicAliases,
          nowEpoch: options.nowEpoch,
        });
        topicId = topic.id;
        if (existing) {
          counts.topicsReused += 1;
        } else {
          counts.topicsMinted += 1;
        }
      }
      const segment = createSegment(db, {
        title: directive.title,
        topicId,
        content: directive.content,
        type: directive.type,
        tags: directive.tags,
        status: directive.status,
        // Settlement is the only writer allowed to say a conclusion was
        // overturned (`rolled-back`), because that value is hindsight.
        typeSource: "settlement",
        nowEpoch: options.nowEpoch,
      });
      counts.segmentsCreated += 1;
      landed.push({ segment, directive });
    }

    // --- extended segments, through the revision CAS ----------------------
    const extendDirectives = response.segments.filter(
      (directive) => directive.action === "extend",
    );
    if (extendDirectives.length > 0) {
      const writes: SegmentWrite[] = extendDirectives.map((directive) => ({
        segmentId: directive.segmentId!,
        expectedRevision: directive.expectedRevision!,
        title: directive.title,
        content: directive.content,
        type: directive.type,
        tags: directive.tags,
        status: directive.status,
      }));
      const { applied, excluded } = applySegmentWrites(db, writes, {
        nowEpoch: options.nowEpoch,
        source: "settlement",
      });
      for (const segment of applied) {
        const directive = extendDirectives.find(
          (candidate) => candidate.segmentId === segment.id,
        );
        if (directive) {
          counts.segmentsExtended += 1;
          landed.push({ segment, directive });
        }
      }
      for (const entry of excluded) {
        const directive = extendDirectives.find(
          (candidate) => candidate.segmentId === entry.write.segmentId,
        );
        if (directive) {
          // Members are held back with the body: the segment's whole judgement
          // is what replays, and half of it landing would attach turns to a
          // chapter whose text never mentions them.
          conflicts.push({ directive, excluded: entry });
        }
      }
    }

    // --- membership + anchors --------------------------------------------
    for (const entry of landed) {
      const { nodes, rejected } = resolveTokens(
        db,
        entry.directive.members,
        options,
      );
      counts.rejectedReferences += rejected;
      const turnIds = [...nodes.values()]
        .filter((node) => node.kind === "turn")
        .map((node) => node.id);
      counts.membersAdded += addSegmentMembers(
        db,
        entry.segment.id,
        turnIds,
        options.nowEpoch,
      ).length;

      const anchors = writeAnchorEdges(db, entry.segment, options);
      counts.anchorEdges += anchors.written;
      counts.rejectedReferences += anchors.rejected;
    }

    // --- judged edges -----------------------------------------------------
    if (response.edges.length > 0) {
      const tokens = response.edges.flatMap((edge) => [edge.citing, edge.cited]);
      const { nodes, rejected } = resolveTokens(db, tokens, options);
      counts.rejectedReferences += rejected;
      const inputs = response.edges
        .map((edge) => {
          const citing = nodes.get(edge.citing.trim());
          const cited = nodes.get(edge.cited.trim());
          return citing && cited
            ? {
                citing,
                cited,
                relation: edge.relation,
                provenance: JUDGED_PROVENANCE,
              }
            : null;
        })
        .filter((input): input is NonNullable<typeof input> => input !== null);
      counts.judgedEdges += writeMemoryEdges(
        db,
        inputs,
        options.nowEpoch,
      ).written.length;
    }

    // --- interior-hole reconstructions ------------------------------------
    for (const note of response.reconstructedNotes) {
      const parsed = parseAddressToken(note.turn);
      const turnId =
        parsed && parsed.kind === "turn"
          ? (db
              .query<{ id: number }, [number, number]>(
                "SELECT id FROM turns WHERE session_id = ? AND prompt_number = ?",
              )
              .get(parsed.sessionId, parsed.promptNumber)?.id ?? null)
          : null;
      // Only an interior hole may be reconstructed. A trailing hole has nothing
      // after it that depends on it, and a turn the agent skipped or aged out is
      // the reminder protocol's business — writing either here would manufacture
      // compliance the trial is measuring.
      if (turnId === null || !options.reconstructableTurnIds.has(turnId)) {
        counts.notesRejected += 1;
        options.logger?.warn?.(
          `[claude-mnemo] settlement job ${job.id}: refused reconstruction for ${note.turn} (not an interior hole of this window)`,
        );
        continue;
      }
      upsertShadowNote(db, {
        turnId,
        title: note.title,
        content: note.content,
        insight: note.insight,
        writerModel: options.writerModel ?? null,
        writerOrigin: "settlement",
        rideTurnId: options.rideTurnId,
        nowEpoch: options.nowEpoch,
      });
      counts.notesReconstructed += 1;
    }

    // --- session summary ---------------------------------------------------
    if (response.sessionSummary) {
      const updated = updateSessionSummaryRewrite(
        db,
        job.sessionId,
        {
          title: response.sessionSummary.title,
          content: response.sessionSummary.content,
          decision: response.sessionSummary.decision,
          done: response.sessionSummary.done,
          current: response.sessionSummary.current,
          nextSteps: response.sessionSummary.nextSteps,
          reference: response.sessionSummary.reference,
        },
        options.nowEpoch,
      );
      counts.summaryUpdated = updated !== null;
    }

    // --- completion + cursor, same transaction -----------------------------
    completeNoteSettlementJob(db, job.id, options.nowEpoch, job.claimGeneration);
    advanceNoteSettlementCursor(
      db,
      job.sessionId,
      options.nowEpoch,
      options.maxAttempts ?? NOTE_SETTLEMENT_MAX_ATTEMPTS,
    );

    return { ...counts, committed: true, reason: null, conflicts };
  });
}

export interface NoteSettlementSegmentReplayOptions {
  job: NoteSettlementJob;
  segmentId: number;
  /** The revision read back from the conflict — what this write CASes on. */
  expectedRevision: number;
  title?: string;
  content?: string;
  type?: string[];
  tags?: string[];
  status?: SegmentRecord["status"];
  memberTokens?: readonly string[];
  exposedSegmentIds: ReadonlySet<number>;
  nowEpoch: number;
  logger?: Pick<Console, "warn">;
}

export interface NoteSettlementSegmentReplayResult {
  applied: boolean;
  reason: string | null;
  membersAdded: number;
  anchorEdges: number;
  rejectedReferences: number;
}

/**
 * Re-apply ONE segment's judgement after a revision conflict, in its own small
 * transaction. Deliberately not a retry of the window: the committed partition
 * writes stand, and only the contested document is written again.
 */
export function applyNoteSettlementSegmentReplay(
  db: Database,
  options: NoteSettlementSegmentReplayOptions,
): NoteSettlementSegmentReplayResult {
  return runWriteTransaction(db, () => {
    const { applied, excluded } = applySegmentWrites(
      db,
      [
        {
          segmentId: options.segmentId,
          expectedRevision: options.expectedRevision,
          title: options.title,
          content: options.content,
          type: options.type,
          tags: options.tags,
          status: options.status,
        },
      ],
      { nowEpoch: options.nowEpoch, source: "settlement" },
    );

    const segment = applied[0];
    if (!segment) {
      return {
        applied: false,
        reason: excluded[0]?.reason ?? "segment write rejected",
        membersAdded: 0,
        anchorEdges: 0,
        rejectedReferences: 0,
      };
    }

    const writeBackOptions: NoteSettlementWriteBackOptions = {
      job: options.job,
      response: {
        segments: [],
        edges: [],
        reconstructedNotes: [],
        sessionSummary: null,
      },
      nowEpoch: options.nowEpoch,
      reconstructableTurnIds: new Set<number>(),
      exposedSegmentIds: options.exposedSegmentIds,
      rideTurnId: null,
      logger: options.logger,
    };

    const { nodes, rejected } = resolveTokens(
      db,
      options.memberTokens ?? [],
      writeBackOptions,
    );
    const membersAdded = addSegmentMembers(
      db,
      segment.id,
      [...nodes.values()]
        .filter((node) => node.kind === "turn")
        .map((node) => node.id),
      options.nowEpoch,
    ).length;
    const anchors = writeAnchorEdges(db, segment, writeBackOptions);

    return {
      applied: true,
      reason: null,
      membersAdded,
      anchorEdges: anchors.written,
      rejectedReferences: rejected + anchors.rejected,
    };
  });
}
