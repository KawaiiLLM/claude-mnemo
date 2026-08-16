import { z } from "zod";
import type { Database } from "bun:sqlite";

import { parseBareAddressReference, validateReferences } from "../db/references";
import {
  addSegmentMembers,
  applySegmentWrites,
  createSegment,
  findTopic,
  getSegment,
  upsertTopic,
  SEGMENT_STATUSES,
  type SegmentStatus,
} from "../db/segments";
import { MEMORY_TYPES, normalizeTypeValues } from "../shared/type-vocabulary";
import type { SettlementTurnFacadeContext } from "./note-settlement-turn-facade";

/**
 * The settlement segment-write facade (ticket 10b, spec A7/A3-amended).
 *
 * A3's amended tool list is three: `note` (ticket 10a, turn-facade.ts),
 * `segment` (this file, new), and `commit` (note-settlement-staging.ts).
 * There was no segment tool before this ticket — settlement's only segment
 * writes lived in the now-dead `note-settlement-writeback.ts`, driven off
 * the parsed JSON envelope. This facade grants the identical AUTHORITY that
 * write-back proved out (create/extend through `db/segments.ts`'s own
 * compare-and-set, members, type, tags, body) through a live tool call
 * instead, under the SAME job-identity fence 10a built for the turn facade
 * (this module shares `SettlementTurnFacadeContext`, not a copy of it — one
 * job identity, one set of scoping fields, for both write surfaces).
 *
 * Like the turn facade, this is a staged write (spec A7): `evaluateSettlementSegmentWrite`
 * runs every read unconditionally and every mutating call only when
 * `apply: true`. Reads that would need a REAL id — a citation inside the
 * body, a member address — are validated for real at both stage and commit
 * (`validateReferences`); an address that fails to resolve is DROPPED, not a
 * reason to refuse the whole call — the same "never a reason to fail the
 * window it arrived with" discipline the retiring write-back's own
 * `resolveTokens`/`writeAnchorEdges` already applied to members and anchors
 * (as opposed to a RELATION field on the turn facade, which fails the whole
 * call on a bad address — a relation is one targeted claim, a member list is
 * a many-item batch, and the write-back's own precedent already drew that
 * line at the segments layer specifically).
 *
 * ANCHOR EDGES ARE AUTOMATIC. `db/segments.ts`'s `createSegment` and
 * `applySegmentWrites` already call `reconcileSegmentCitedPairs` internally
 * on every landed write (spec C6) — every `[S<session>/T<prompt>]`/`[E<n>]`
 * in the segment's title/content becomes a bare, unattributed edge with no
 * code in this file. This facade's own job is narrower than the retired
 * write-back's `writeAnchorEdges`: resolve handles, decide create vs extend,
 * and land membership.
 */

// ---------------------------------------------------------------------------
// Run-scoped handles (spec A7 requirement 4)
// ---------------------------------------------------------------------------

/**
 * A staged segment has no id. The agent addresses it within this run as
 * `E#<n>` (assigned by the staging engine, in staging order, as each
 * `action: "create"` call is staged) so a LATER call — another segment's
 * body citing it as an anchor — can name it before it exists. This is a
 * small interpreter, not the parser A1 removed: that one carried
 * authorization and was wrong three times in ways that destroyed data; this
 * one replays intents authorization has already passed (every staged write
 * already ran its own full validation when it was staged) and re-checks
 * them against real ids inside the commit transaction, immediately before
 * the write that uses them.
 */
const HANDLE_TOKEN_PATTERN = /^E#(\d+)$/;
const HANDLE_IN_TEXT_PATTERN = /E#(\d+)/g;

export function isSettlementHandleToken(token: string): boolean {
  return HANDLE_TOKEN_PATTERN.test(token.trim());
}

/**
 * `null` = a handle this run has assigned but not yet resolved to a real id
 * (stage time — nothing has a real id until commit lands it). A number =
 * resolved (commit time, filled in as each staged `create` actually lands).
 * One map shape for both modes is what lets `scanUnknownHandles` below run
 * identically at stage and at commit — only `substituteHandles`'s ability to
 * produce a real replacement differs.
 */
export type SettlementHandleMap = ReadonlyMap<string, number | null>;

/** Every `E#<n>` token in `text` that `handleMap` has never heard of — a typo or a forward reference past what this run has staged. */
function scanUnknownHandles(text: string, handleMap: SettlementHandleMap): string[] {
  const unknown: string[] = [];
  for (const match of text.matchAll(HANDLE_IN_TEXT_PATTERN)) {
    const key = `E#${match[1]}`;
    if (!handleMap.has(key)) {
      unknown.push(key);
    }
  }
  return unknown;
}

/** Replace every resolvable `E#<n>` in `text` with its real `E<id>` form. Commit-only — at stage every value in the map is still `null`. */
function substituteHandles(text: string, handleMap: SettlementHandleMap): string {
  return text.replace(HANDLE_IN_TEXT_PATTERN, (whole, digits: string) => {
    const real = handleMap.get(`E#${digits}`);
    return typeof real === "number" ? `E${real}` : whole;
  });
}

// ---------------------------------------------------------------------------
// Input shape
// ---------------------------------------------------------------------------

export const settlementSegmentWriteInputShape = {
  action: z.enum(["create", "extend"]),
  /** extend only — a REAL, already-existing segment id. Never a handle: the schema's number type makes that unrepresentable, so `extend` can only ever target a segment that existed before this run (see the module doc comment). */
  segmentId: z.number().int().positive().optional(),
  /** extend only. */
  expectedRevision: z.number().int().min(0).optional(),
  /** create only: exact registry name if reusing, or a new name to mint. */
  topic: z.string().optional(),
  topicAliases: z.array(z.string()).optional(),
  /** create only, required: D9's anti-fragmentation discipline — why no open segment and no registered topic fits. */
  noCandidateReason: z.string().optional(),
  /** Required (non-empty) for create; optional for extend — omit to leave the stored title alone (spec D5a). */
  title: z.string().optional(),
  /** Optional for both. `null` explicitly clears (extend only); omit leaves alone. */
  content: z.string().nullable().optional(),
  type: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  status: z.enum(SEGMENT_STATUSES).optional(),
  /** `S<session>/T<prompt>` turn addresses, or `E#<n>` handles naming a segment this SAME run creates — but see the module doc comment: a handle here is always rejected, because a member is always a turn. */
  members: z.array(z.string()).optional(),
};

export const settlementSegmentWriteInputSchema = z
  .object(settlementSegmentWriteInputShape)
  .strict();

export type SettlementSegmentWriteInput = z.infer<
  typeof settlementSegmentWriteInputSchema
>;

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

export interface SettlementSegmentWriteOutcome {
  action: "create" | "extend";
  /** The real id once landed (commit, `apply: true`); null at stage time — nothing has one yet. */
  segmentId: number | null;
  /** The handle this write's OWN staged entry will be addressable as, when `action === "create"`. Assigned by the staging engine, not this function. */
  membersAdded: number;
  membersDropped: number;
  topicMinted: boolean;
  topicReused: boolean;
}

export type SettlementSegmentWriteEvaluation =
  | { ok: true; outcome: SettlementSegmentWriteOutcome }
  | { ok: false; message: string };

export interface EvaluateSettlementSegmentWriteOptions {
  /** See `evaluateSettlementTurnWrite` — false is a dry run (reads only), true performs the mutations. */
  apply: boolean;
  /**
   * Handles known so far in THIS run, in staging order. At stage time every
   * value is `null` (assigned, not yet real); at commit time each value is
   * filled in immediately after its own `create` lands, before the next
   * staged entry is evaluated — so by the time entry N is replayed, every
   * handle entries 1..N-1 assigned is resolvable.
   */
  handleMap: SettlementHandleMap;
}

/**
 * The settlement segment-write facade's whole decision, mirroring
 * `evaluateSettlementTurnWrite`'s shape: every read runs unconditionally,
 * every write is gated on `options.apply`. `db/segments.ts`'s own
 * `createSegment`/`applySegmentWrites` already do the real anchor-edge
 * reconciliation (spec C6) — this function's own writes are limited to the
 * segment row itself and its membership.
 */
export function evaluateSettlementSegmentWrite(
  db: Database,
  context: SettlementTurnFacadeContext,
  rawInput: SettlementSegmentWriteInput,
  nowEpoch: number,
  options: EvaluateSettlementSegmentWriteOptions,
): SettlementSegmentWriteEvaluation {
  const handleIssues = [
    ...scanUnknownHandles(rawInput.title ?? "", options.handleMap),
    ...scanUnknownHandles(rawInput.content ?? "", options.handleMap),
  ];
  for (const member of rawInput.members ?? []) {
    if (isSettlementHandleToken(member)) {
      return {
        ok: false,
        message: `members entry "${member}" names a segment, not a turn — a member must be a "S<session>/T<prompt>" address.`,
      };
    }
  }
  if (handleIssues.length > 0) {
    return {
      ok: false,
      message: `references an unknown handle: ${[...new Set(handleIssues)].join(", ")} — a handle must have been assigned by an earlier "create" call in this same run.`,
    };
  }

  let normalizedType: string[] | undefined;
  if (rawInput.type !== undefined) {
    try {
      normalizedType = normalizeTypeValues(rawInput.type);
    } catch (error) {
      return {
        ok: false,
        message: `${error instanceof Error ? error.message : String(error)}. Allowed: ${MEMORY_TYPES.join(", ")}.`,
      };
    }
  }

  const resolvedTitle = substituteHandles(rawInput.title ?? "", options.handleMap);
  const resolvedContent =
    rawInput.content === undefined
      ? undefined
      : rawInput.content === null
        ? null
        : substituteHandles(rawInput.content, options.handleMap);

  if (rawInput.action === "create") {
    if (rawInput.title === undefined || rawInput.title.trim() === "") {
      return { ok: false, message: "title is required and must not be empty for a create." };
    }
    if (!rawInput.noCandidateReason || rawInput.noCandidateReason.trim() === "") {
      return {
        ok: false,
        message:
          "no_candidate_reason is required for a create — name what you searched " +
          "in the topic registry and open segments, and why nothing fit.",
      };
    }

    let topicMinted = false;
    let topicReused = false;
    let topicId: number | null = null;
    if (rawInput.topic) {
      const existing = findTopic(db, rawInput.topic);
      topicReused = existing !== null;
      topicMinted = !topicReused;
      if (options.apply) {
        const topic = upsertTopic(db, {
          name: rawInput.topic,
          aliases: rawInput.topicAliases,
          nowEpoch,
        });
        topicId = topic.id;
      }
    }

    const memberResolution = resolveMemberTokens(
      db,
      rawInput.members ?? [],
      context,
    );

    let segmentId: number | null = null;
    if (options.apply) {
      const created = createSegment(db, {
        title: resolvedTitle,
        topicId,
        content: resolvedContent ?? null,
        type: normalizedType ?? [],
        tags: rawInput.tags ?? [],
        nowEpoch,
      });
      segmentId = created.id;
      addSegmentMembers(db, created.id, memberResolution.turnIds, nowEpoch);
    }

    return {
      ok: true,
      outcome: {
        action: "create",
        segmentId,
        membersAdded: memberResolution.turnIds.length,
        membersDropped: memberResolution.dropped,
        topicMinted,
        topicReused,
      },
    };
  }

  // --- extend ---------------------------------------------------------
  if (rawInput.segmentId === undefined || rawInput.expectedRevision === undefined) {
    return {
      ok: false,
      message: "extend requires segmentId and expectedRevision, both naming an already-existing segment.",
    };
  }
  if (!context.exposedSegmentIds.has(rawInput.segmentId)) {
    return {
      ok: false,
      message: `E${rawInput.segmentId} was not shown to this dispatch as an open segment — extend may only target a segment this run's prompt actually listed.`,
    };
  }
  const current = getSegment(db, rawInput.segmentId);
  if (!current) {
    return { ok: false, message: `no segment E${rawInput.segmentId}.` };
  }
  if (current.status !== "open") {
    return {
      ok: false,
      message: `E${rawInput.segmentId} is ${current.status}, not open — spec D6 overturns a closed segment with an edge, never by rewriting it.`,
    };
  }

  const memberResolution = resolveMemberTokens(db, rawInput.members ?? [], context);

  if (!options.apply) {
    // Stage-time feedback only: the revision this call was composed against
    // vs. what is on file right now. NOT a hard failure — spec A7 requirement
    // 5 makes the world moving between stage and commit an expected case,
    // and the real compare-and-set (`applySegmentWrites`) is what enforces
    // it as truth, at commit, against whatever the row says at THAT instant.
    return {
      ok: true,
      outcome: {
        action: "extend",
        segmentId: rawInput.segmentId,
        membersAdded: memberResolution.turnIds.length,
        membersDropped: memberResolution.dropped,
        topicMinted: false,
        topicReused: false,
      },
    };
  }

  const { applied, excluded } = applySegmentWrites(
    db,
    [
      {
        segmentId: rawInput.segmentId,
        expectedRevision: rawInput.expectedRevision,
        title: rawInput.title === undefined ? undefined : resolvedTitle,
        content: resolvedContent,
        type: normalizedType,
        tags: rawInput.tags,
        status: rawInput.status as SegmentStatus | undefined,
      },
    ],
    { nowEpoch },
  );
  const landed = applied[0];
  if (!landed) {
    const rejection = excluded[0];
    const latest = rejection?.latest;
    return {
      ok: false,
      message:
        `E${rawInput.segmentId} extend refused (${rejection?.reason ?? "unknown"})` +
        (latest ? ` — current revision on file is ${latest.revision}.` : "."),
    };
  }
  addSegmentMembers(db, landed.id, memberResolution.turnIds, nowEpoch);

  return {
    ok: true,
    outcome: {
      action: "extend",
      segmentId: landed.id,
      membersAdded: memberResolution.turnIds.length,
      membersDropped: memberResolution.dropped,
      topicMinted: false,
      topicReused: false,
    },
  };
}

/**
 * Resolve `members` to real turn ids, DROPPING (never failing the call on) a
 * token that does not resolve — the retiring write-back's own discipline for
 * this specific field (see the module doc comment for why this differs from
 * the turn facade's relation fields, which fail the whole call instead).
 */
function resolveMemberTokens(
  db: Database,
  tokens: readonly string[],
  context: SettlementTurnFacadeContext,
): { turnIds: number[]; dropped: number } {
  const turnIds: number[] = [];
  let dropped = 0;
  for (const token of tokens) {
    const reference = parseBareAddressReference(token);
    if (!reference || reference.kind !== "turn") {
      dropped += 1;
      context.logger?.warn?.(
        `[claude-mnemo] settlement job ${context.jobId}: member "${token}" is not a turn address`,
      );
      continue;
    }
    const { accepted } = validateReferences(db, [reference], {
      writerSessionId: context.sessionId,
      logger: context.logger,
    });
    const node = accepted[0]?.node;
    if (!node) {
      dropped += 1;
      continue;
    }
    turnIds.push(node.id);
  }
  return { turnIds, dropped };
}

/**
 * Render one segment-write outcome as tool-result text (stage or commit-time
 * replay bookkeeping — same `staged` convention as
 * `renderSettlementTurnWriteReceipt`).
 */
export function renderSettlementSegmentWriteReceipt(
  outcome: SettlementSegmentWriteOutcome,
  options: { staged: boolean; handle: string | null },
): string {
  const verb = options.staged ? "Staged" : "Landed";
  const address =
    outcome.action === "create"
      ? (options.handle ?? (outcome.segmentId !== null ? `E${outcome.segmentId}` : "a new segment"))
      : `E${outcome.segmentId}`;
  const parts: string[] = [
    `${verb} ${outcome.action} of ${address}${options.staged ? " (pending commit)" : ""}.`,
  ];
  if (outcome.topicMinted) {
    parts.push("New topic minted.");
  } else if (outcome.topicReused) {
    parts.push("Reused an existing topic.");
  }
  if (outcome.membersAdded > 0) {
    parts.push(`${outcome.membersAdded} member(s).`);
  }
  if (outcome.membersDropped > 0) {
    parts.push(`${outcome.membersDropped} member address(es) dropped (did not resolve to a turn).`);
  }
  return parts.join(" ");
}
