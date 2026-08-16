import { z } from "zod";
import type { Database } from "bun:sqlite";

import { recordNoteSettlementSegmentExclusion } from "../db/note-settlement-completion";
import {
  parseBareAddressReference,
  parseQualifiedReferences,
  topLevelBracketGroups,
  validateReferences,
} from "../db/references";
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
import { getTurn } from "../db/turns";
import { parseTurnAddress } from "../mcp/note";
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
 *
 * TICKET 10D'S REPAIRS, on top of the above:
 *
 *   - `action` gains `"exclude"` (spec A7a): the job-scoped verdict "this
 *     turn was reviewed and belongs to no segment"
 *     (`recordNoteSettlementSegmentExclusion`, db/note-settlement-completion.ts)
 *     had no model-facing path before this — only `create`/`extend` existed,
 *     so a window holding one legitimately unsegmented turn could not
 *     complete. `exclude` writes exactly that row and nothing else.
 *   - a body citation (`[S<session>/T<prompt>]`/`[E<n>]` in title/content) is
 *     now validated at STAGE time too, not only when `createSegment`/
 *     `applySegmentWrites` reconcile it at apply time — the same "the agent
 *     learns of an error while it can still act on it" promise every other
 *     field already keeps. Still DROPPED, never a reason to fail the call
 *     (same discipline as `members`), just no longer SILENT.
 *   - `create`'s handle is now MODEL-NAMED, not server-issued (spec A7a) —
 *
 * TICKET 14'S CHANGE (spec K5/K5a/K7):
 *
 *   - the tool gains `insight` — the segment's most reusable conclusion — and
 *     it is a citation-bearing prose field like `title`/`content`: handle
 *     substitution, stage-time citation validation and `reconcileSegmentCitedPairs`
 *     all cover it, in the same change that added it (K7's explicit
 *     requirement — a citation the author can see and the graph cannot is
 *     worse than no field at all);
 *   - the tool LOSES `type` and `tags` (K5a). Both are derived from the
 *     members by `recomputeSegmentFacets` (db/segments.ts) the moment
 *     membership lands, so the facade states neither on create or extend, and
 *     the strict schema refuses a call that still names one.
 *     see `HANDLE_NAME_PATTERN` below — and every place that read or wrote
 *     `E#<n>` in free text now requires the bracketed `[E#<n>]` CITATION
 *     form, matching the bracket-qualified grammar `db/references.ts` already
 *     requires for every other reference. The old bare, unbracketed
 *     `/E#(\d+)/g` scan rewrote ordinary prose that happened to contain the
 *     substring ("the error code E#1 was observed" silently became "...E#42
 *     ...") and refused an unrelated "E#2024" that was never meant as a
 *     citation — both fixed by requiring the same `[...]` wrapper every
 *     other address needs.
 */

// ---------------------------------------------------------------------------
// Run-scoped handles (spec A7 requirement 4)
// ---------------------------------------------------------------------------

/**
 * A staged segment has no id. The agent addresses it within this run as
 * `E#<handle>` — MODEL-NAMED (spec A7a), not server-issued — so a LATER call
 * (another segment's body citing it as an anchor) can name it before it
 * exists, AND so a lost-receipt retry restates the identical handle and
 * replaces its own stale staged entry instead of minting a second one. This
 * is a small interpreter, not the parser A1 removed: that one carried
 * authorization and was wrong three times in ways that destroyed data; this
 * one replays intents authorization has already passed (every staged write
 * already ran its own full validation when it was staged) and re-checks
 * them against real ids inside the commit transaction, immediately before
 * the write that uses them.
 *
 * The handle NAME grammar is deliberately permissive text the model chooses
 * (not a server-generated shape): printable ASCII word characters and
 * hyphens, first character alphanumeric — enough to keep it safely
 * embeddable inside a `[E#<handle>]` bracket group without needing its own
 * escaping rules.
 */
const HANDLE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** A BARE handle token — `E#<handle>`, no brackets — the shape ONE ALREADY-ISOLATED `members` array entry takes (matching `parseBareAddressReference`'s own bracket-optional convention for that field). Anchored to the whole string: never scanned across prose. */
const HANDLE_TOKEN_PATTERN = /^E#([A-Za-z0-9][A-Za-z0-9_-]*)$/;

/** A handle CITATION inside one already-isolated top-level bracket group — `[E#<handle>]`. */
const HANDLE_GROUP_PATTERN = /^\[[ \t]*E#([A-Za-z0-9][A-Za-z0-9_-]*)[ \t]*\][ \t]*$/;

export function isSettlementHandleToken(token: string): boolean {
  return HANDLE_TOKEN_PATTERN.test(token.trim());
}

export function isValidSettlementHandleName(name: string): boolean {
  return HANDLE_NAME_PATTERN.test(name.trim());
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

/**
 * Every `[E#<handle>]` CITATION in `text`, each with its exact bracketed raw
 * form and the bare `E#<handle>` key `handleMap` is keyed by. Ticket 10d:
 * confined to a top-level bracket group via `topLevelBracketGroups` (the
 * SAME bracket scanner `db/references.ts` uses for `[S<n>/T<n>]`/`[E<n>]`),
 * not a bare substring scan — a handle is a segment reference that merely
 * lacks a real id yet, so it must follow the identical bracket-qualified
 * grammar every other reference does, not a looser one while it doesn't.
 */
function findHandleCitations(text: string): Array<{ raw: string; key: string }> {
  const found: Array<{ raw: string; key: string }> = [];
  for (const group of topLevelBracketGroups(text)) {
    const match = HANDLE_GROUP_PATTERN.exec(group);
    if (match) {
      found.push({ raw: group, key: `E#${match[1]}` });
    }
  }
  return found;
}

/** Every `[E#<handle>]` citation in `text` that `handleMap` has never heard of — a typo or a forward reference past what this run has staged. */
function scanUnknownHandles(text: string, handleMap: SettlementHandleMap): string[] {
  const unknown: string[] = [];
  for (const { key } of findHandleCitations(text)) {
    if (!handleMap.has(key)) {
      unknown.push(key);
    }
  }
  return unknown;
}

/** Replace every resolvable `[E#<handle>]` in `text` with its real `[E<id>]` form. Commit-only — at stage every value in the map is still `null`, so every citation is left exactly as written. */
function substituteHandles(text: string, handleMap: SettlementHandleMap): string {
  let result = text;
  for (const { raw, key } of findHandleCitations(text)) {
    const real = handleMap.get(key);
    if (typeof real === "number") {
      // Replace the exact bracketed group text, not a bare substring — the
      // same reason `findHandleCitations` scans bracket groups rather than
      // matching anywhere: a coincidental "E#1" inside unrelated prose
      // elsewhere in the same body must never be touched.
      result = result.split(raw).join(`[E${real}]`);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Input shape
// ---------------------------------------------------------------------------

export const settlementSegmentWriteInputShape = {
  action: z.enum(["create", "extend", "exclude"]),
  /**
   * create only, required (spec A7a) — a short id the MODEL chooses and can
   * restate identically on a retry (e.g. "lease-fencing"), never server-
   * issued. This is what a later call cites as `[E#<handle>]`, and it is
   * this create's own STAGING KEY: re-staging the same handle REPLACES the
   * earlier staged entry rather than appending a second one — the point of
   * a model-named handle, since a server-issued one would differ on every
   * call and a retry could never be recognised as one.
   */
  handle: z.string().optional(),
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
  /**
   * Ticket 14 (spec K5): the most reusable conclusion this segment holds,
   * including the routes ruled out and why. Same null/omit rule as `content`,
   * and the same citation grammar — an `[S<n>/T<m>]`/`[E<n>]` written here is
   * a real anchor (spec K7, `reconcileSegmentCitedPairs`).
   */
  insight: z.string().nullable().optional(),
  // NO `type`, NO `tags` (spec K5a, ticket 14). Both are DERIVED from the
  // members by `recomputeSegmentFacets` (db/segments.ts) — type is the union
  // of the members' reviewed activities, tags are the members' tags ordered by
  // frequency. The schema is `.strict()`, so a call that still states either
  // is REFUSED by name rather than silently ignored: A6 asserted the union as
  // fact from the day it was written while the tool went on accepting a stated
  // type that could contradict every member, and an ignored field would leave
  // exactly that gap open one more layer down.
  /** create: honoured, defaults to "open" same as a bare insert would. extend: the compare-and-set's own status change (spec D6). */
  status: z.enum(SEGMENT_STATUSES).optional(),
  /** `S<session>/T<prompt>` turn addresses, or `E#<n>` handles naming a segment this SAME run creates — but see the module doc comment: a handle here is always rejected, because a member is always a turn. */
  members: z.array(z.string()).optional(),
  /** exclude only, required — the turn address this verdict covers, and this exclude call's own staging key (spec A7a). */
  turn: z.string().optional(),
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
  action: "create" | "extend" | "exclude";
  /** The real id once landed (commit, `apply: true`); null at stage time — nothing has one yet. Always null for `exclude`, which mints no segment. */
  segmentId: number | null;
  /** exclude only — the resolved turn ref (`S<session>/T<prompt>`), also this call's own staging key (spec A7a). */
  excludedTurnRef: string | null;
  membersAdded: number;
  membersDropped: number;
  /** A `[S<session>/T<prompt>]`/`[E<n>]` citation in title/content that did not resolve — dropped, same discipline as `membersDropped`, but previously silent until commit (ticket 10d). */
  citationsDropped: number;
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
 * Body citations at BOTH stage and commit (ticket 10d: "a stage-time dry run
 * promises a real receipt, and today an unresolvable [S999/T1] stages clean
 * and is silently dropped at commit"). Mirrors what `reconcileSegmentCitedPairs`
 * (db/segments.ts) does internally at APPLY time, WITHOUT writing — the same
 * "small, deliberate duplication" the turn facade's `evaluateRelationCandidates`
 * already uses for the identical reason. `E#<handle>` citations are excluded
 * on purpose: at stage time they are still pending (no real id, so
 * `parseQualifiedReferences`' `E(\d+)` grammar does not even match the `#`)
 * and are validated separately by `scanUnknownHandles`; by commit time
 * `substituteHandles` has already turned every KNOWN handle into a real
 * `[E<id>]` before this ever runs, so a resolved handle is checked here like
 * any other citation, and one that never got created was already caught
 * earlier, by `scanUnknownHandles`, not here.
 */
function scanBodyCitationIssues(
  db: Database,
  texts: ReadonlyArray<string | null | undefined>,
): number {
  const references = texts.flatMap((text) => parseQualifiedReferences(text));
  if (references.length === 0) {
    return 0;
  }
  return validateReferences(db, references).rejected.length;
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
    ...scanUnknownHandles(rawInput.insight ?? "", options.handleMap),
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

  const resolvedTitle = substituteHandles(rawInput.title ?? "", options.handleMap);
  const resolvedContent =
    rawInput.content === undefined
      ? undefined
      : rawInput.content === null
        ? null
        : substituteHandles(rawInput.content, options.handleMap);
  const resolvedInsight =
    rawInput.insight === undefined
      ? undefined
      : rawInput.insight === null
        ? null
        : substituteHandles(rawInput.insight, options.handleMap);

  if (rawInput.action === "exclude") {
    if (!rawInput.turn || rawInput.turn.trim() === "") {
      return {
        ok: false,
        message: "exclude requires turn, a \"S<session>/T<prompt>\" address.",
      };
    }
    const address = parseTurnAddress(rawInput.turn);
    if (!address) {
      return {
        ok: false,
        message: `turn must be a fully qualified "S<session>/T<prompt>" address; got "${rawInput.turn}".`,
      };
    }
    const ref = `S${address.sessionId}/T${address.promptNumber}`;
    const turn = getTurn(db, address.sessionId, address.promptNumber);
    if (!turn) {
      return { ok: false, message: `no turn at ${ref}.` };
    }
    if (options.apply) {
      // The job-scoped negative verdict (spec G7) — the ONLY thing an
      // exclude call writes. No fence check here: like
      // `addSegmentMembers`/`recordNoteSettlementSegmentExclusion`'s own doc
      // comment says, that belongs to the CALLER's transaction (`commit`,
      // which runs `assertNoteSettlementJobClaimed` as its own first
      // statement), not to this plain write.
      recordNoteSettlementSegmentExclusion(db, context.jobId, turn.id, nowEpoch);
    }
    return {
      ok: true,
      outcome: {
        action: "exclude",
        segmentId: null,
        excludedTurnRef: ref,
        membersAdded: 0,
        membersDropped: 0,
        citationsDropped: 0,
        topicMinted: false,
        topicReused: false,
      },
    };
  }

  if (rawInput.action === "create") {
    if (rawInput.title === undefined || rawInput.title.trim() === "") {
      return { ok: false, message: "title is required and must not be empty for a create." };
    }
    if (!rawInput.noCandidateReason || rawInput.noCandidateReason.trim() === "") {
      return {
        ok: false,
        message:
          "noCandidateReason is required for a create — name what you searched " +
          "in the topic registry and open segments, and why nothing fit.",
      };
    }
    if (!rawInput.handle || !isValidSettlementHandleName(rawInput.handle)) {
      return {
        ok: false,
        message:
          "handle is required for a create — a short id YOU choose and can " +
          'restate identically on a retry (e.g. "lease-fencing"; letters, ' +
          "digits, hyphens, underscores only). It becomes the [E#<handle>] " +
          "address other calls in this run cite before this segment has a " +
          "real id, and re-staging the same handle replaces this call rather " +
          "than duplicating it.",
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
    const citationsDropped = scanBodyCitationIssues(db, [
      resolvedTitle,
      resolvedContent,
      resolvedInsight,
    ]);

    let segmentId: number | null = null;
    if (options.apply) {
      const created = createSegment(db, {
        title: resolvedTitle,
        topicId,
        content: resolvedContent ?? null,
        insight: resolvedInsight ?? null,
        // type/tags are not passed and cannot be: `addSegmentMembers` below
        // derives both from the members (spec K5a), and a segment with no
        // members yet has no activity and no subject matter to state.
        // Ticket 10d: honoured, not silently dropped. `createSegment` already
        // accepted a `status` param and defaulted it to "open" when absent —
        // this facade simply never passed the model's value through, so a
        // model-stated status was accepted by the schema and then ignored.
        // No new eligibility invented: it is the SAME
        // `SEGMENT_STATUSES`/default `createSegment` already enforced.
        status: rawInput.status as SegmentStatus | undefined,
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
        excludedTurnRef: null,
        membersAdded: memberResolution.turnIds.length,
        membersDropped: memberResolution.dropped,
        citationsDropped,
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
  // No "was this segment shown to the dispatch" check, deliberately (user
  // ruling, S15069/T728). An implementation of this ticket added one, gating
  // `extend` on the open segments the prompt listed; it was removed rather
  // than kept. The retiring write-back declared `exposedSegmentIds` and never
  // read it — extend was gated only by the compare-and-set below (exists,
  // open, revision matches) — so the gate was new authority arriving under
  // the appearance of a carry-over. And the durable reason: whether a model
  // saw something is not auditable, which is the same ruling that retired the
  // note-id exposure ledger. Existence and openness are facts storage answers
  // exactly; "was it listed" approximates in both directions.
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
  // Only fields THIS call is actually rewriting — an omitted field leaves
  // the stored value alone (spec D5a), so its EXISTING citations are not
  // this call's concern to re-validate.
  const citationsDropped = scanBodyCitationIssues(db, [
    rawInput.title !== undefined ? resolvedTitle : undefined,
    rawInput.content !== undefined ? resolvedContent : undefined,
    rawInput.insight !== undefined ? resolvedInsight : undefined,
  ]);

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
        excludedTurnRef: null,
        membersAdded: memberResolution.turnIds.length,
        membersDropped: memberResolution.dropped,
        citationsDropped,
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
        insight: resolvedInsight,
        // No type/tags, for the same reason as the create above (spec K5a).
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
      excludedTurnRef: null,
      membersAdded: memberResolution.turnIds.length,
      membersDropped: memberResolution.dropped,
      citationsDropped,
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
  options: { staged: boolean; handle: string | null; replaced?: boolean },
): string {
  const verb = options.staged ? "Staged" : "Landed";
  const address =
    outcome.action === "create"
      ? (options.handle ?? (outcome.segmentId !== null ? `E${outcome.segmentId}` : "a new segment"))
      : outcome.action === "exclude"
        ? (outcome.excludedTurnRef ?? "a turn")
        : `E${outcome.segmentId}`;
  const replacedSuffix = options.replaced
    ? " — replaces the earlier staged call for this same key"
    : "";
  const parts: string[] = [
    `${verb} ${outcome.action} of ${address}${options.staged ? " (pending commit)" : ""}${replacedSuffix}.`,
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
  if (outcome.citationsDropped > 0) {
    parts.push(
      `${outcome.citationsDropped} citation(s) in title/content did not resolve and will not become an anchor.`,
    );
  }
  return parts.join(" ");
}
