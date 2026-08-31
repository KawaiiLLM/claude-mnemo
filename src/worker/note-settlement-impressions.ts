import type { Database } from "bun:sqlite";

import { resolveEraCutoff } from "../db/era";
import {
  ackClaimedImpressionDebts,
  readLaneImpression,
  replaceLaneImpression,
  type ImpressionDebtRecord,
  type StoredImpression,
} from "../db/impressions";
import { getLane } from "../db/lanes";
import {
  readNoteSettlementLaneMemberSnapshot,
  readNoteSettlementWorklistSnapshot,
} from "../db/note-settlement-snapshots";
import { readSegmentTaskImpression, replaceSegmentTaskImpression } from "../db/segments";
import { getSegmentMembershipForTurns } from "../db/segment-rank";
import { liveTurnSql } from "../db/turn-liveness";
import { settledMemberIdsForLane } from "../mcp/timeline";
import {
  impressionCapForLane,
  validateImpression,
  type ImpressionAnchor,
  type ImpressionAnchorResolver,
  TASK_IMPRESSION_TOKEN_CAP,
} from "../shared/lane-impressions";

/**
 * THE SETTLEMENT WRITE PATH FOR IMPRESSIONS (lane-impressions spec Rev 8,
 * "Settlement maintenance" both tiers; ticket 02).
 *
 * Settlement is the SOLE writer of an impression. This module owns the four
 * things that makes true:
 *
 *   1. the TOUCHED SET — which containers (lanes, and the task tier) this run
 *      owes a judgment on;
 *   2. the ADVISORY — each touched container's current text, its CAS base
 *      revision, and the token CAP it must fit, handed to the writer BEFORE it
 *      generates (the spec's own words: "the model must know its budget BEFORE
 *      generating, not discover at commit that 450 tokens face a 135 cap");
 *   3. the TERMINAL FENCE — inside the terminal transaction, re-derive every
 *      coordinate and reject the WHOLE commit on any impression-revision or
 *      membership drift, then run the deterministic validator and write;
 *   4. the PAYLOAD CAP — 256 KiB of UTF-8 serialized bytes, a deterministic
 *      rejection routed to compress-only regeneration.
 *
 * NOTHING here opens a transaction. `settleImpressions` runs inside the caller's
 * terminal write transaction (worker/note-settlement-direct-write.ts's
 * `commit`), which is what makes a rejection roll the edges' terminal mark back
 * with it: impressions and the commit that carries them land together or not at
 * all.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * THE PAYLOAD CAP (spec "Testing Decisions", peer rounds 2-3, pinned exact):
 * 256 KiB of UTF-8 SERIALIZED PAYLOAD BYTES — not JS chars, not a token
 * estimate, because CJK and JSON escaping diverge across all three. Provisional
 * at ≥4× today's largest real cross-task shape; the wire's own 16 MiB envelope
 * is a pathology bound, not a product bound.
 *
 * The measurement gate (spec acceptance (c)) may adjust this CONSTANT against
 * the real maximum JOB touched set. It may never adjust the MECHANISM: overflow
 * is a deterministic rejection, never a truncation and never a split commit.
 */
export const IMPRESSION_PAYLOAD_MAX_BYTES = 256 * 1024;

/**
 * How many times ONE run may be sent back to compress-only regeneration before
 * the overflow stops being a repairable refusal and becomes an operator-visible
 * failure (spec: "if every required replacement at its minimal legal form still
 * overflows, the job fails operator-visible — with split commits rejected,
 * there is no third path").
 *
 * Three, matching the settlement dispatch's own attempt cap — the same number
 * the rest of this subsystem uses for "you have had your chances". The budget
 * applies ONLY to regeneration: an overflow refusal costs no job attempt, so
 * without a bound of its own a stubborn writer could resend the same oversized
 * payload for as long as the run's turn budget lasts.
 */
export const IMPRESSION_REGENERATION_RETRY_BUDGET = 3;

/** `origin` written on every settlement replacement (spec "Storage"). */
const SETTLEMENT_ORIGIN = "settlement" as const;

// ---------------------------------------------------------------------------
// Containers and their coordinates
// ---------------------------------------------------------------------------

export type ImpressionContainerKind = "lane" | "task";

export interface ImpressionContainerRef {
  kind: ImpressionContainerKind;
  segmentId: number;
  /** `null` for the task tier. */
  laneTag: string | null;
  /** `E<n>/#<tag>` for a lane, `E<n>` for the task tier — the address the payload names. */
  address: string;
}

export function laneContainerAddress(segmentId: number, tag: string): string {
  return `E${segmentId}/#${tag}`;
}

export function taskContainerAddress(segmentId: number): string {
  return `E${segmentId}`;
}

/**
 * Everything the writer is shown about one container, and everything the
 * terminal transaction re-derives to fence it.
 */
export interface ImpressionAdvisory extends ImpressionContainerRef {
  /** The CAS fence the payload must carry back. */
  baseRevision: number;
  origin: StoredImpression["origin"];
  /** Merge-family staleness: while set, a `retain` is refused — the fused identity falsifies the old prose. */
  stale: boolean;
  currentText: string | null;
  /** `clamp(10 × settledMembers, 100, 500)` for a lane; flat 500 for the task tier. */
  cap: number;
  /** The POST-COMMIT PROJECTION's member count (lane tier); 0 and unused for the task tier. */
  settledMemberCount: number;
  /**
   * The cap's OTHER coordinate, fenced separately from the revision (spec
   * "Cap coordinates share the fence"): a digest of the exact member id set the
   * count was taken over. The impression revision alone cannot see membership
   * drift — a stage-1 or tag write that moved the lane's membership without
   * touching the impression row leaves the revision standing.
   *
   * `"flat"` for the task tier, whose cap has no membership coordinate to fence.
   */
  membershipGeneration: string;
  /** Anchors in the CURRENT text that this window's own `override` edges invalidated — a `retain` is refused while any stands. */
  overriddenAnchors: string[];
  /** Anchors this window's own `narrows` edges NUDGE (spec: never a mechanical deletion). */
  narrowedAnchors: string[];
}

// ---------------------------------------------------------------------------
// The touched set (spec "Touched-lane set" + the task tier's own conditions)
// ---------------------------------------------------------------------------

interface LaneTouchDbRow {
  touchKind: "turn-tag" | "lane";
  entityId: number;
  laneTag: string;
}

/**
 * THE TOUCHED SET, from durable rows only.
 *
 * The spec names four sources; three of them are already persisted by machinery
 * this ticket does not rebuild:
 *
 *   - "lanes with window members" — the transition's own frozen WORKLIST
 *     (`note_settlement_worklist`), which is stage 1's recorded judgment of
 *     which `(task, lane)` pairs this window's projection touched, synonym
 *     reuses included. Re-deriving it live would answer a different question
 *     than the one the run's own member snapshots were frozen against.
 *   - "tail lanes of edges written/retracted this run" AND "HEAD lanes of those
 *     edges" — the durable touch ledger (`lane_run_touches`), whose `turn-tag`
 *     rows are written for BOTH placed sides of every edge this run attached,
 *     restated or retracted (worker/note-settlement-turn-facade.ts), plus every
 *     tag a landed `tags` write named. Its `lane` rows carry the destructive
 *     twin: the lane a removed tag took a turn OUT of. Job-scoped, so a
 *     reclaimed attempt inherits its predecessor's touches.
 *   - "lanes named by consumed lifecycle debts" — `claimedDebts`, the injectable
 *     claimed-set seam (ticket 03 owns the claim machinery and the debt
 *     WRITERS; this ticket only consumes what it is handed).
 *
 * A `turn-tag` touch is qualified through the turn's OWNING segment, then kept
 * only if `(segment, tag)` is a DECLARED lane — which is also what drops the
 * `topic:` words and the task tag that share that ledger with real lane words.
 *
 * TASK TIER: touched when any of its lanes is touched (which subsumes "a
 * cross-lane edge lands between its lanes" — both endpoints' lanes are touch
 * sources), or when a task-scoped debt names it.
 */
export function computeTouchedImpressionContainers(
  db: Database,
  jobId: number,
  claimedDebts: readonly ImpressionDebtRecord[] = [],
): ImpressionContainerRef[] {
  const laneKeys = new Map<string, { segmentId: number; laneTag: string }>();
  const addLane = (segmentId: number, laneTag: string): void => {
    if (getLane(db, segmentId, laneTag) === null) {
      return;
    }
    laneKeys.set(`${segmentId} ${laneTag}`, { segmentId, laneTag });
  };

  for (const lane of readNoteSettlementWorklistSnapshot(db, jobId).lanes) {
    addLane(lane.segmentId, lane.laneTag);
  }

  const touches = db
    .query<LaneTouchDbRow, [number]>(
      `SELECT touch_kind AS touchKind, entity_id AS entityId, lane_tag AS laneTag
         FROM lane_run_touches WHERE job_id = ?`,
    )
    .all(jobId);
  const turnIds = touches
    .filter((row) => row.touchKind === "turn-tag")
    .map((row) => row.entityId);
  const owningByTurn = getSegmentMembershipForTurns(db, [...new Set(turnIds)]);
  for (const row of touches) {
    if (row.touchKind === "lane") {
      addLane(row.entityId, row.laneTag);
      continue;
    }
    const segmentId = owningByTurn.get(row.entityId);
    if (segmentId !== undefined) {
      addLane(segmentId, row.laneTag);
    }
  }

  const taskSegmentIds = new Set<number>();
  for (const debt of claimedDebts) {
    if (debt.laneTag === null) {
      taskSegmentIds.add(debt.segmentId);
      continue;
    }
    addLane(debt.segmentId, debt.laneTag);
  }

  const lanes = [...laneKeys.values()].sort(
    (a, b) => a.segmentId - b.segmentId || a.laneTag.localeCompare(b.laneTag),
  );
  for (const lane of lanes) {
    taskSegmentIds.add(lane.segmentId);
  }

  const containers: ImpressionContainerRef[] = lanes.map((lane) => ({
    kind: "lane" as const,
    segmentId: lane.segmentId,
    laneTag: lane.laneTag,
    address: laneContainerAddress(lane.segmentId, lane.laneTag),
  }));
  for (const segmentId of [...taskSegmentIds].sort((a, b) => a - b)) {
    if (readSegmentTaskImpression(db, segmentId) === null) {
      // The segment row is gone (a merge folded it away between the touch and
      // this read): there is no container to owe a judgment on.
      continue;
    }
    containers.push({
      kind: "task",
      segmentId,
      laneTag: null,
      address: taskContainerAddress(segmentId),
    });
  }
  return containers;
}

// ---------------------------------------------------------------------------
// Coordinates: the post-commit projection, its vouching check, and the digest
// ---------------------------------------------------------------------------

/**
 * TICKET 01's HANDOFF (b): `settledMemberCountForLane` does not verify that the
 * projected turn ids are members of THIS lane — it is caller-vouched, because
 * the terminal transaction knows its window and that reader does not. This is
 * the vouching, and it lives exactly where the projection is computed.
 *
 * A projected id qualifies iff it is LIVE, its OWNING segment is this lane's
 * segment, and its own `tags` still carry this lane's tag — the same three-part
 * membership predicate the snapshot writer and `db/lane-checker-load.ts` use
 * (membership is a node fact scoped to the owning task, lane-model-v12 D5).
 *
 * Offenders are returned rather than filtered away silently: at commit time a
 * non-empty list IS membership drift, and the caller turns it into the whole
 * commit's rejection.
 */
export function vouchProjectedLaneMembers(
  db: Database,
  segmentId: number,
  tag: string,
  projectedTurnIds: readonly number[],
): { vouched: number[]; offenders: number[] } {
  const vouched: number[] = [];
  const offenders: number[] = [];
  if (projectedTurnIds.length === 0) {
    return { vouched, offenders };
  }
  const statement = db.query<{ ok: number }, [number, number, string]>(
    `SELECT 1 AS ok
       FROM turns t
      WHERE t.id = ?
        AND ${liveTurnSql("t")}
        AND (SELECT MIN(sm.segment_id) FROM segment_members sm
              WHERE sm.turn_id = t.id) = ?
        AND CASE
              WHEN json_valid(t.tags) AND json_type(t.tags) = 'array'
                THEN EXISTS (SELECT 1 FROM json_each(t.tags) j WHERE j.value = ?)
              ELSE 0
            END`,
  );
  for (const turnId of [...new Set(projectedTurnIds)].sort((a, b) => a - b)) {
    if (statement.get(turnId, segmentId, tag)) {
      vouched.push(turnId);
    } else {
      offenders.push(turnId);
    }
  }
  return { vouched, offenders };
}

/**
 * A stable digest of an exact member id set. FNV-1a over the ascending id list,
 * prefixed with the count so the two coordinates the spec names — "membership
 * generation (and member count)" — read off one string.
 *
 * Never a timestamp and never a row counter: the fence has to answer "is this
 * the SAME member set my cap was computed over", and only the set itself
 * answers that.
 */
export function membershipGenerationOf(memberIds: readonly number[]): string {
  const ascending = [...memberIds].sort((a, b) => a - b);
  let hash = 0x811c9dc5;
  for (const id of ascending) {
    for (const char of String(id)) {
      hash ^= char.charCodeAt(0);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    hash ^= 0x2c;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `m${ascending.length}-${hash.toString(16).padStart(8, "0")}`;
}

// ---------------------------------------------------------------------------
// Anchor invalidation (spec "Touched-lane set", last clause)
// ---------------------------------------------------------------------------

const ANCHOR_SCAN_RE = /\bS(\d+)\/T(\d+)\b|\bT(\d+)\b/g;

/** Every well-formed anchor in a stored impression, unfolded — the same grammar the validator parses. */
function scanStoredAnchors(text: string): ImpressionAnchor[] {
  const anchors: ImpressionAnchor[] = [];
  text.split("\n").forEach((line, index) => {
    let foldSessionId: number | null = null;
    ANCHOR_SCAN_RE.lastIndex = 0;
    for (const match of line.matchAll(ANCHOR_SCAN_RE)) {
      if (match[1] !== undefined && match[2] !== undefined) {
        foldSessionId = Number.parseInt(match[1], 10);
        anchors.push({
          sessionId: foldSessionId,
          promptNumber: Number.parseInt(match[2], 10),
          line: index + 1,
          raw: match[0],
        });
      } else if (match[3] !== undefined && foldSessionId !== null) {
        anchors.push({
          sessionId: foldSessionId,
          promptNumber: Number.parseInt(match[3], 10),
          line: index + 1,
          raw: match[0],
        });
      }
    }
  });
  return anchors;
}

/**
 * THE UNCONDITIONAL ANCHOR-INVALIDATION CHECK (spec: it "runs UNCONDITIONALLY
 * for every touched lane"). An anchor OVERRIDDEN by one of this window's own
 * edges forces revise-or-delete of its sentence, so a `retain` over it is
 * refused; a `narrows` hit NUDGES and is reported as a warning, never a
 * mechanical deletion.
 *
 * "This window's own edges" is read off the EDGE TABLE against the run's frozen
 * writable set — a live `override` row whose CITED side is the anchor and whose
 * CITING side is a turn this window owns — rather than off an in-memory list of
 * what the current attempt happened to write. The obligation belongs to the
 * WINDOW: an override an earlier, crashed attempt already landed is exactly as
 * invalidating as one written a moment ago, and an in-memory list would forget
 * it (the touch ledger's own durability lesson).
 *
 * Both directions are covered by one query. The head-lane case — the edge's
 * CITED turn lives in another lane, so THAT lane is touched as a head — is the
 * same row read from the other end; nothing about this predicate is tail-side.
 */
function computeAnchorInvalidations(
  db: Database,
  currentText: string | null,
  writableTurnIds: ReadonlySet<number>,
): { overridden: string[]; narrowed: string[] } {
  const overridden: string[] = [];
  const narrowed: string[] = [];
  if (currentText === null || writableTurnIds.size === 0) {
    return { overridden, narrowed };
  }
  const anchors = scanStoredAnchors(currentText);
  if (anchors.length === 0) {
    return { overridden, narrowed };
  }
  const turnLookup = db.query<{ id: number }, [number, number]>(
    "SELECT id FROM turns WHERE session_id = ? AND prompt_number = ?",
  );
  const relationLookup = db.query<{ citingId: number }, [number, string]>(
    `SELECT citing_id AS citingId FROM memory_edges
      WHERE cited_kind = 'turn' AND cited_id = ? AND relation = ?
        AND citing_kind = 'turn'`,
  );
  const seenOverridden = new Set<string>();
  const seenNarrowed = new Set<string>();
  for (const anchor of anchors) {
    const row = turnLookup.get(anchor.sessionId, anchor.promptNumber);
    if (!row) {
      continue;
    }
    const address = `S${anchor.sessionId}/T${anchor.promptNumber}`;
    const hitsWindow = (relation: string): boolean =>
      relationLookup
        .all(row.id, relation)
        .some((edge) => writableTurnIds.has(edge.citingId));
    if (!seenOverridden.has(address) && hitsWindow("override")) {
      seenOverridden.add(address);
      overridden.push(address);
    }
    if (!seenNarrowed.has(address) && hitsWindow("narrows")) {
      seenNarrowed.add(address);
      narrowed.push(address);
    }
  }
  return { overridden, narrowed };
}

// ---------------------------------------------------------------------------
// Advisories
// ---------------------------------------------------------------------------

export interface LoadImpressionAdvisoriesOptions {
  /**
   * THE ERA CUTOFF, RESOLVED BY THE CALLER (ticket 01's handoff (a)).
   * `settledMemberCountForLane` treats `null` as ALL-ERA, matching every other
   * frontier consumer — which is correct for the legacy world and wrong as an
   * accident. This parameter is REQUIRED rather than defaulted precisely so a
   * `null` here is a resolution someone performed, never an argument someone
   * forgot; `resolveEraCutoffForImpressions` below is the one resolution both
   * the advisory and the terminal fence call.
   */
  eraCutoffEpoch: number | null;
  /** The frozen per-lane member snapshot — the committing window's own members, keyed by `laneSnapshotKey`. */
  projectedByLane: ReadonlyMap<string, number[]>;
  /** This run's frozen writable set, for the anchor-invalidation check. */
  writableTurnIds: ReadonlySet<number>;
}

/**
 * The one era resolution the impression path performs, at both of its moments.
 *
 * TICKET 01's HANDOFF (a), answered: the cutoff is resolved HERE, from the
 * database, at the advisory and again inside the terminal transaction — never
 * captured once and carried, never defaulted by an omitted argument. A `null`
 * therefore means "this install records no era boundary", which is the same
 * all-era answer the frontier section, the lane-adjacency view and the
 * transition's own member snapshot already give; it can no longer mean "nobody
 * passed one".
 *
 * The ticket-07 bootstrap shape — an era recorded BETWEEN the advisory and the
 * commit, turning an all-era count into a scoped one — is not silently absorbed
 * either: the membership generation is a digest of the exact member id SET the
 * cap was taken over, so a cutoff arriving mid-run changes that set, the digests
 * disagree, and the terminal transaction rejects the whole commit for
 * re-read-re-decide. `resolveEraCutoff` caches only NON-null answers
 * (`db/era.ts`), so this is the one direction the transition can take.
 */
export function resolveEraCutoffForImpressions(db: Database): number | null {
  return resolveEraCutoff(db);
}

/**
 * One container's coordinates. `null` when the container has vanished (its lane
 * or segment row is gone) — the caller drops it from the touched set rather
 * than demanding a judgment on nothing.
 */
export function loadImpressionAdvisory(
  db: Database,
  container: ImpressionContainerRef,
  options: LoadImpressionAdvisoriesOptions,
): { advisory: ImpressionAdvisory; projectionOffenders: number[] } | null {
  if (container.kind === "task") {
    const stored = readSegmentTaskImpression(db, container.segmentId);
    if (stored === null) {
      return null;
    }
    const invalidations = computeAnchorInvalidations(
      db,
      stored.text,
      options.writableTurnIds,
    );
    return {
      advisory: {
        ...container,
        baseRevision: stored.revision,
        origin: stored.origin,
        stale: stored.stale,
        currentText: stored.text,
        cap: TASK_IMPRESSION_TOKEN_CAP,
        settledMemberCount: 0,
        membershipGeneration: "flat",
        overriddenAnchors: invalidations.overridden,
        narrowedAnchors: invalidations.narrowed,
      },
      projectionOffenders: [],
    };
  }

  const tag = container.laneTag!;
  const stored = readLaneImpression(db, container.segmentId, tag);
  if (stored === null) {
    return null;
  }
  const projected =
    options.projectedByLane.get(`E${container.segmentId}/#${tag}`) ?? [];
  const { vouched, offenders } = vouchProjectedLaneMembers(
    db,
    container.segmentId,
    tag,
    projected,
  );
  // The POST-COMMIT PROJECTION, in the exact two halves the spec names: the
  // settled/canonical/era-scoped universe shared with the frontier section,
  // UNIONED with the committing window's own vouched members. `…Ids` and
  // `…Count` are one read, so the digest and the cap can never describe
  // different sets.
  const memberIds = settledMemberIdsForLane(
    db,
    container.segmentId,
    tag,
    options.eraCutoffEpoch,
    vouched,
  );
  const invalidations = computeAnchorInvalidations(
    db,
    stored.text,
    options.writableTurnIds,
  );
  return {
    advisory: {
      ...container,
      baseRevision: stored.revision,
      origin: stored.origin,
      stale: stored.stale,
      currentText: stored.text,
      cap: impressionCapForLane(memberIds.length),
      settledMemberCount: memberIds.length,
      membershipGeneration: membershipGenerationOf(memberIds),
      overriddenAnchors: invalidations.overridden,
      narrowedAnchors: invalidations.narrowed,
    },
    projectionOffenders: offenders,
  };
}

export interface LoadedImpressionAdvisories {
  advisories: ImpressionAdvisory[];
  /** Per container address, the projected ids that are NOT members of that lane — membership drift, named. */
  projectionOffendersByAddress: Map<string, number[]>;
}

export function loadImpressionAdvisories(
  db: Database,
  containers: readonly ImpressionContainerRef[],
  options: LoadImpressionAdvisoriesOptions,
): LoadedImpressionAdvisories {
  const advisories: ImpressionAdvisory[] = [];
  const projectionOffendersByAddress = new Map<string, number[]>();
  for (const container of containers) {
    const loaded = loadImpressionAdvisory(db, container, options);
    if (loaded === null) {
      continue;
    }
    advisories.push(loaded.advisory);
    if (loaded.projectionOffenders.length > 0) {
      projectionOffendersByAddress.set(
        container.address,
        loaded.projectionOffenders,
      );
    }
  }
  return { advisories, projectionOffendersByAddress };
}

/**
 * The advisory block, as the writer reads it. DATA ONLY on the `finalize`
 * surface (whose result carries no instructions by contract) — the writing law
 * itself lives in the prompt, the one channel this run is told to trust.
 */
export function renderImpressionAdvisories(
  advisories: readonly ImpressionAdvisory[],
): string {
  const lines: string[] = [`impression containers you owe a judgment on (${advisories.length}):`];
  if (advisories.length === 0) {
    lines.push("  (none)");
    return lines.join("\n");
  }
  for (const advisory of advisories) {
    const tier = advisory.kind === "lane" ? "lane" : "task tier";
    const budget =
      advisory.kind === "lane"
        ? `cap ${advisory.cap} tokens (${advisory.settledMemberCount} settled member(s), post-commit)`
        : `cap ${advisory.cap} tokens (flat)`;
    lines.push(`  ${advisory.address} — ${tier}, baseRevision ${advisory.baseRevision}, ${budget}`);
    if (advisory.stale) {
      lines.push(
        "    STALE: a merge fused two identities into this one. The stored prose no longer " +
          "describes it and no reader is being shown it. A retain is refused here.",
      );
    }
    if (advisory.overriddenAnchors.length > 0) {
      lines.push(
        `    OVERRIDDEN anchors: ${advisory.overriddenAnchors.join(", ")} — this window's own ` +
          "edges overturned what they proved. A retain is refused here.",
      );
    }
    if (advisory.narrowedAnchors.length > 0) {
      lines.push(
        // DATA, not duty: this block rides `finalize`'s own result, whose
        // contract is facts only (the needle test in
        // tests/worker/staged-settlement-unified-run.test.ts pins it). What a
        // narrowed anchor OBLIGES is in the prompt; what is true about it is
        // here.
        `    NARROWED anchors: ${advisory.narrowedAnchors.join(", ")} — this window narrowed ` +
          "what they proved. Nothing is mechanically required of a narrowed anchor.",
      );
    }
    if (advisory.currentText === null) {
      lines.push("    current: (none — this container has no impression yet)");
      continue;
    }
    lines.push(
      `    current (origin ${advisory.origin ?? "none"}):`,
      ...advisory.currentText.split("\n").map((line) => `      ${line}`),
    );
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// The payload
// ---------------------------------------------------------------------------

export interface ImpressionDecision {
  id: string;
  baseRevision: number;
  decision: "retain" | "replace";
  text?: string;
}

export type ParsedImpressionPayload =
  | { ok: true; decisions: ImpressionDecision[]; bytes: number }
  | { ok: false; message: string; bytes: number };

/**
 * Parse and MEASURE the payload. The measurement is of the UTF-8 serialized
 * bytes of what the writer actually sent, taken before anything is interpreted,
 * so the cap means the same thing whatever the payload's internal shape turns
 * out to be.
 */
export function parseImpressionPayload(raw: unknown): ParsedImpressionPayload {
  const bytes =
    raw === undefined ? 0 : Buffer.byteLength(JSON.stringify(raw) ?? "", "utf8");
  if (raw === undefined || raw === null) {
    return { ok: true, decisions: [], bytes };
  }
  if (!Array.isArray(raw)) {
    return {
      ok: false,
      bytes,
      message: '"impressions" must be an array of {id, baseRevision, decision, text?} entries.',
    };
  }
  const decisions: ImpressionDecision[] = [];
  for (const entry of raw as unknown[]) {
    if (typeof entry !== "object" || entry === null) {
      return { ok: false, bytes, message: "every impressions entry must be an object." };
    }
    const record = entry as Record<string, unknown>;
    const id = record.id;
    const decision = record.decision;
    const baseRevision = record.baseRevision;
    if (typeof id !== "string" || id.trim() === "") {
      return {
        ok: false,
        bytes,
        message: 'every impressions entry needs "id" — the container address, "E<n>/#<tag>" for a lane or "E<n>" for the task tier.',
      };
    }
    if (decision !== "retain" && decision !== "replace") {
      return {
        ok: false,
        bytes,
        message: `impressions entry "${id}" needs "decision": "retain" or "replace".`,
      };
    }
    if (!Number.isSafeInteger(baseRevision) || (baseRevision as number) < 0) {
      return {
        ok: false,
        bytes,
        message: `impressions entry "${id}" needs "baseRevision" — the revision you were shown, as an integer.`,
      };
    }
    if (decision === "replace" && (typeof record.text !== "string" || record.text.trim() === "")) {
      return {
        ok: false,
        bytes,
        message: `impressions entry "${id}" is a replace and needs "text" — the WHOLE new impression, never a patch.`,
      };
    }
    if (decision === "retain" && record.text !== undefined) {
      return {
        ok: false,
        bytes,
        message: `impressions entry "${id}" is a retain and must carry no "text" — a retain keeps the stored bytes exactly.`,
      };
    }
    decisions.push({
      id: id.trim(),
      baseRevision: baseRevision as number,
      decision,
      ...(decision === "replace" ? { text: record.text as string } : {}),
    });
  }
  return { ok: true, decisions, bytes };
}

/**
 * TICKET 01's HANDOFF (d): the validator rejects a trailing newline under
 * `structure`, and the write path takes the tolerance rather than the
 * strictness — here, in one line, at the boundary instead of in the validator.
 *
 * The validator's rule is right about STORAGE: the stored form is exact, and a
 * blank last line would render as one. But a trailing newline in a JSON string
 * is a serialization artifact, not a claim, and spending a whole regeneration
 * round-trip on it would be the most expensive way this system could enforce a
 * formatting nicety. Trimmed here, so the text that is VALIDATED is byte-for-byte
 * the text that is STORED — which is the invariant the validator's strictness
 * actually exists to protect. Trailing only: leading whitespace is inside the
 * first line's own budget and is the writer's to answer for.
 */
export function normalizeImpressionText(text: string): string {
  return text.replace(/\n+$/, "");
}

// ---------------------------------------------------------------------------
// The terminal settlement
// ---------------------------------------------------------------------------

/**
 * The refusal sentinel. Thrown INSIDE the caller's terminal transaction so
 * SQLite rolls the whole commit back — the terminal mark, the era grant, the
 * edges' completion and any impression already written in this pass go together.
 * Caught at the `commit` boundary and returned as the refusal text verbatim.
 */
export type ImpressionRefusalKind =
  | "payload-cap"
  | "malformed"
  | "coverage"
  | "fence"
  | "validator"
  | "lost-row";

export class ImpressionSettlementRefused extends Error {
  constructor(
    readonly kind: ImpressionRefusalKind,
    message: string,
  ) {
    super(message);
  }
}

export interface SettleImpressionsInput {
  jobId: number;
  writableTurnIds: ReadonlySet<number>;
  claimedDebts: readonly ImpressionDebtRecord[];
  /** The `impressions` argument exactly as the tool received it. */
  rawPayload: unknown;
  nowEpoch: number;
  /**
   * The advisories this run was SHOWN, keyed by address — the ledger the
   * membership fence compares against. See `createSettlementImpressionMaintainer`.
   */
  shownAdvisories: ReadonlyMap<string, ImpressionAdvisory>;
}

export interface SettleImpressionsOutcome {
  replaced: number;
  retained: number;
  ackedDebts: number;
  /** Re-rendered coordinates for whatever the run must now decide against — empty on success. */
  advisories: ImpressionAdvisory[];
}

function refuse(
  kind: ImpressionRefusalKind,
  header: string,
  body: readonly string[],
  advisories: readonly ImpressionAdvisory[],
): never {
  const lines = [
    `Commit refused — ${header} NOTHING was committed and this is NOT a failed attempt: ` +
      "repair the `impressions` payload and call `commit` again in this same run.",
    ...body.map((line) => `  ${line}`),
  ];
  if (advisories.length > 0) {
    lines.push("", renderImpressionAdvisories(advisories));
  }
  throw new ImpressionSettlementRefused(kind, lines.join("\n"));
}

/**
 * THE TERMINAL TRANSACTION'S IMPRESSION HALF. Runs inside `commit`'s own write
 * transaction, after the lease fence and before the completion CAS.
 *
 * Order is the spec's, and it is load-bearing: "The transaction CAS-checks the
 * FULL touched set first; any mismatch (a concurrent job or a manual lifecycle
 * write moved any row) rejects the WHOLE commit for re-read-re-decide." So every
 * coordinate is re-derived and every fence is checked over the whole set BEFORE
 * the first byte is written. Replacements update text+revision; retains touch
 * nothing but must pass the same fence — an unfenced retain would falsely ACK
 * debts and mark containers checked over text it never saw.
 *
 * WHY BEFORE THE COMPLETION CAS. The cap and its digest are taken over the
 * settled universe UNIONED with this window's own projection. `loadSettlement
 * CoveredTurnIds` reads `status = 'done'` job rows, so once the CAS has run,
 * this job's own window is already inside the settled half — the same members
 * would be counted from a different side of the union and the digest would
 * differ from the advisory's by construction, making the membership fence fire
 * on every single commit. Run before the CAS, both moments see the identical
 * universe and the fence means what it says.
 */
export function settleImpressions(
  db: Database,
  input: SettleImpressionsInput,
): SettleImpressionsOutcome {
  const parsed = parseImpressionPayload(input.rawPayload);

  const eraCutoffEpoch = resolveEraCutoffForImpressions(db);
  const containers = computeTouchedImpressionContainers(
    db,
    input.jobId,
    input.claimedDebts,
  );
  const { advisories, projectionOffendersByAddress } = loadImpressionAdvisories(
    db,
    containers,
    {
      eraCutoffEpoch,
      projectedByLane: readNoteSettlementLaneMemberSnapshot(db, input.jobId),
      writableTurnIds: input.writableTurnIds,
    },
  );

  // 1. THE PAYLOAD CAP — a deterministic rejection, never a truncation and
  //    never a split commit (spec). Checked before the payload's SHAPE, because
  //    an oversized payload's shape is not the thing that needs fixing.
  if (parsed.bytes > IMPRESSION_PAYLOAD_MAX_BYTES) {
    refuse(
      "payload-cap",
      `the \`impressions\` payload is ${parsed.bytes} UTF-8 bytes, over the ` +
        `${IMPRESSION_PAYLOAD_MAX_BYTES}-byte cap.`,
      [
        "Regenerate it SHORTER. You may compress prose and drop non-essential claims.",
        "You may NOT omit a touched container's judgment, and you may NOT demote a",
        "required replace (a STALE container, or one whose anchors this window",
        "overrode) to a retain — those are required whatever the payload pressure.",
      ],
      advisories,
    );
  }
  if (!parsed.ok) {
    refuse("malformed", `the \`impressions\` payload is malformed: ${parsed.message}`, [], advisories);
  }

  // 2. COVERAGE — every touched container carries a judgment, and nothing else
  //    does. "A touched container with no judgment is a rejected payload, not a
  //    silent skip" (spec's durable-obligation ruling, made mechanical).
  const byAddress = new Map<string, ImpressionAdvisory>(
    advisories.map((advisory) => [advisory.address, advisory]),
  );
  const decisionsByAddress = new Map<string, ImpressionDecision>();
  const duplicates: string[] = [];
  const strangers: string[] = [];
  for (const decision of parsed.decisions) {
    if (decisionsByAddress.has(decision.id)) {
      duplicates.push(decision.id);
      continue;
    }
    decisionsByAddress.set(decision.id, decision);
    if (!byAddress.has(decision.id)) {
      strangers.push(decision.id);
    }
  }
  const missing = advisories
    .filter((advisory) => !decisionsByAddress.has(advisory.address))
    .map((advisory) => advisory.address);
  if (missing.length > 0 || strangers.length > 0 || duplicates.length > 0) {
    const body: string[] = [];
    if (missing.length > 0) {
      body.push(`no judgment for: ${missing.join(", ")}`);
    }
    if (strangers.length > 0) {
      body.push(
        `judged, but not touched by this run: ${strangers.join(", ")} — an untouched ` +
          "container is not yours to rewrite",
      );
    }
    if (duplicates.length > 0) {
      body.push(`judged more than once: ${duplicates.join(", ")}`);
    }
    refuse(
      "coverage",
      "the `impressions` payload does not match this run's touched set.",
      body,
      advisories,
    );
  }

  // 3. THE FENCES, over the FULL set, before any write.
  const fenceFailures: string[] = [];
  for (const advisory of advisories) {
    const decision = decisionsByAddress.get(advisory.address)!;
    // A container this run was NEVER SHOWN has no earlier generation to
    // compare, and that is not a fence failure — it is the absence of one. The
    // advisory covers the worklist lanes (the overwhelming majority) at the run's
    // one delivery moment; a foreign task's HEAD lane discovered mid-run through
    // a crossing edge can appear after it. For that container the REVISION CAS
    // below still holds fully, and its cap is the one recomputed here, enforced
    // by the validator with the number named in the refusal. Demanding a prior
    // sighting instead would cost every such run a guaranteed extra round trip
    // to be told coordinates it could not have had.
    const shown = input.shownAdvisories.get(advisory.address);
    if (decision.baseRevision !== advisory.baseRevision) {
      fenceFailures.push(
        `${advisory.address}: baseRevision ${decision.baseRevision} is not the stored ` +
          `revision ${advisory.baseRevision} — another writer moved this row after you read it`,
      );
      continue;
    }
    const offenders = projectionOffendersByAddress.get(advisory.address);
    if (offenders && offenders.length > 0) {
      fenceFailures.push(
        `${advisory.address}: ${offenders.length} of this window's own projected member(s) ` +
          "no longer belong to this lane — its membership moved under you",
      );
      continue;
    }
    if (shown !== undefined && shown.membershipGeneration !== advisory.membershipGeneration) {
      fenceFailures.push(
        `${advisory.address}: this lane's settled membership moved since you were shown it ` +
          `(${shown.membershipGeneration} → ${advisory.membershipGeneration}); its budget is ` +
          `now ${advisory.cap} tokens`,
      );
      continue;
    }
    if (decision.decision === "retain" && advisory.stale) {
      fenceFailures.push(
        `${advisory.address}: retained, but this container is STALE — a merge fused two ` +
          "identities and the stored prose no longer describes the result. It must be replaced",
      );
      continue;
    }
    if (decision.decision === "retain" && advisory.overriddenAnchors.length > 0) {
      fenceFailures.push(
        `${advisory.address}: retained, but this window's own edges overrode the anchor(s) ` +
          `${advisory.overriddenAnchors.join(", ")} its text rests on. Revise or delete those ` +
          "sentences and replace",
      );
    }
  }
  if (fenceFailures.length > 0) {
    refuse(
      "fence",
      "one or more impression fences did not hold; the WHOLE commit is rejected so nothing " +
        "lands against a version you never read.",
      fenceFailures,
      advisories,
    );
  }

  // 4. THE DETERMINISTIC VALIDATOR, on the replacements only, against the cap
  //    recomputed on the post-commit projection with the SAME integer formula
  //    the advisory used (`impressionCapForLane`). Retains are never re-validated
  //    — grandfathered text is never force-trimmed (spec: "The cap binds
  //    REPLACEMENTS only").
  const resolveAnchor: ImpressionAnchorResolver = (sessionId, promptNumber) =>
    db
      .query<{ id: number }, [number, number]>(
        "SELECT id FROM turns WHERE session_id = ? AND prompt_number = ?",
      )
      .get(sessionId, promptNumber) !== null;
  const replacements: Array<{ advisory: ImpressionAdvisory; text: string }> = [];
  const validationFailures: string[] = [];
  for (const advisory of advisories) {
    const decision = decisionsByAddress.get(advisory.address)!;
    if (decision.decision !== "replace") {
      continue;
    }
    const text = normalizeImpressionText(decision.text!);
    const result = validateImpression({ text, cap: advisory.cap, resolveAnchor });
    if (!result.accepted) {
      for (const rejection of result.rejections) {
        validationFailures.push(
          `${advisory.address}${rejection.line === null ? "" : ` line ${rejection.line}`}: ` +
            `${rejection.message} [${rejection.rule}]`,
        );
      }
      continue;
    }
    replacements.push({ advisory, text });
  }
  if (validationFailures.length > 0) {
    refuse(
      "validator",
      "one or more impression replacements failed the write-time validator.",
      validationFailures,
      advisories,
    );
  }

  // 5. THE WRITES. Every one CASes again on the revision the fence just
  //    checked — the fence and the UPDATE are in one transaction, so this can
  //    only fail if the fence read a row this write cannot address at all, and
  //    that is a rejection, never a retry.
  for (const { advisory, text } of replacements) {
    const landed =
      advisory.kind === "lane"
        ? replaceLaneImpression(db, {
            segmentId: advisory.segmentId,
            tag: advisory.laneTag!,
            baseRevision: advisory.baseRevision,
            text,
            origin: SETTLEMENT_ORIGIN,
          })
        : replaceSegmentTaskImpression(db, {
            segmentId: advisory.segmentId,
            baseRevision: advisory.baseRevision,
            text,
            origin: SETTLEMENT_ORIGIN,
            nowEpoch: input.nowEpoch,
          });
    if (!landed) {
      refuse(
        "lost-row",
        `${advisory.address}: its row moved between this commit's fence and its own write.`,
        [],
        advisories,
      );
    }
  }

  // 6. THE DEBT ACK — only now, in the SAME transaction (spec: "ACKS them only
  //    in its successful terminal commit"; a failed run's claims release for
  //    retry, which is ticket 03's release path, not this one's).
  const ackedDebts =
    input.claimedDebts.length > 0
      ? ackClaimedImpressionDebts(db, input.jobId, input.nowEpoch)
      : 0;

  return {
    replaced: replacements.length,
    retained: advisories.length - replacements.length,
    ackedDebts,
    advisories: [],
  };
}

// ---------------------------------------------------------------------------
// The run-scoped maintainer — the ledger, the retry budget, and the two seams
// ---------------------------------------------------------------------------

/**
 * The advisory block for one job, computed from durable rows and remembering
 * nothing — the RESUME dispatch's own delivery.
 *
 * The unified run receives its advisory as DATA, on `finalize`'s result, because
 * the worklist and its member snapshots come into existence in that very
 * transaction. A resume dispatch has no `finalize` of its own: it reclaims a job
 * whose transition already landed, so the snapshots exist before its prompt is
 * built and the prompt is where the coordinates belong. Same computation, same
 * durable inputs, rendered at whichever of the two moments that run actually has.
 */
export function renderSettlementImpressionAdvisoryBlock(
  db: Database,
  jobId: number,
  writableTurnIds: ReadonlySet<number>,
  claimedDebts: readonly ImpressionDebtRecord[] = [],
): string {
  const { advisories } = loadImpressionAdvisories(
    db,
    computeTouchedImpressionContainers(db, jobId, claimedDebts),
    {
      eraCutoffEpoch: resolveEraCutoffForImpressions(db),
      projectedByLane: readNoteSettlementLaneMemberSnapshot(db, jobId),
      writableTurnIds,
    },
  );
  return renderImpressionAdvisories(advisories);
}

export interface SettlementImpressionMaintainerOptions {
  db: Database;
  jobId: number;
  /** Live at construction; read through a getter so the frozen edge-pass set replaces it in place. */
  readWritableTurnIds: () => ReadonlySet<number>;
  /**
   * THE CLAIMED-SET SEAM (ticket 02's own boundary: "the claim machinery itself
   * is ticket 03; this ticket consumes an injectable claimed-set seam"). Called
   * once per advisory render and once inside the terminal transaction. The
   * default claims nothing, so production behaviour is unchanged until ticket 03
   * wires the real claim — and the ack below is a no-op against an empty claim.
   */
  claimImpressionDebts?: (db: Database) => readonly ImpressionDebtRecord[];
  now?: () => number;
  /** Operator channel for the exhausted-regeneration failure. */
  logger?: Pick<Console, "error">;
}

export interface SettlementImpressionMaintainer {
  /**
   * The advisory block, computed and REMEMBERED. Every address it prints enters
   * the ledger the terminal fence compares against, which is what makes "you
   * were never shown this container's coordinates" a real answer rather than a
   * theoretical one.
   */
  renderAdvisories(): string;
  /** Runs inside the terminal transaction; throws `ImpressionSettlementRefused` on any rejection. */
  settle(db: Database, rawPayload: unknown): SettleImpressionsOutcome;
  /** Test/report visibility: what this run has been shown so far. */
  shown(): ReadonlyMap<string, ImpressionAdvisory>;
}

export function createSettlementImpressionMaintainer(
  options: SettlementImpressionMaintainerOptions,
): SettlementImpressionMaintainer {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const logger = options.logger ?? console;
  const claimDebts = options.claimImpressionDebts ?? (() => []);
  const shownAdvisories = new Map<string, ImpressionAdvisory>();
  let regenerationRefusals = 0;

  function computeAdvisories(db: Database): ImpressionAdvisory[] {
    const { advisories } = loadImpressionAdvisories(
      db,
      computeTouchedImpressionContainers(db, options.jobId, claimDebts(db)),
      {
        eraCutoffEpoch: resolveEraCutoffForImpressions(db),
        projectedByLane: readNoteSettlementLaneMemberSnapshot(db, options.jobId),
        writableTurnIds: options.readWritableTurnIds(),
      },
    );
    return advisories;
  }

  function remember(advisories: readonly ImpressionAdvisory[]): void {
    for (const advisory of advisories) {
      shownAdvisories.set(advisory.address, advisory);
    }
  }

  return {
    renderAdvisories() {
      const advisories = computeAdvisories(options.db);
      remember(advisories);
      return renderImpressionAdvisories(advisories);
    },
    settle(db, rawPayload) {
      try {
        return settleImpressions(db, {
          jobId: options.jobId,
          writableTurnIds: options.readWritableTurnIds(),
          claimedDebts: claimDebts(db),
          rawPayload,
          nowEpoch: now(),
          shownAdvisories,
        });
      } catch (error) {
        if (!(error instanceof ImpressionSettlementRefused)) {
          throw error;
        }
        // EVERY refusal re-renders the coordinates, and every re-render enters
        // the ledger: the next `commit` in this same run decides against what
        // it was just shown, which is the whole point of re-read-re-decide.
        // Reading them here (rather than inside `settleImpressions`) keeps that
        // module free of the ledger it is fenced by.
        remember(computeAdvisories(db));
        if (error.kind !== "payload-cap") {
          throw error;
        }
        regenerationRefusals += 1;
        if (regenerationRefusals < IMPRESSION_REGENERATION_RETRY_BUDGET) {
          throw error;
        }
        // THE EXHAUSTED BUDGET (spec: "if every required replacement at its
        // minimal legal form still overflows, the job fails operator-visible —
        // with split commits rejected, there is no third path"). The refusal
        // stays a refusal — nothing here can mark a job failed from inside its
        // own terminal transaction — but it says so, and it says so on the
        // operator's channel too.
        const message =
          `[claude-mnemo] note-settlement job ${options.jobId}: impression payload exceeded ` +
          `${IMPRESSION_PAYLOAD_MAX_BYTES} bytes on ${regenerationRefusals} successive ` +
          "regeneration attempts — this window cannot commit its impression obligations.";
        logger.error(message);
        throw new ImpressionSettlementRefused(
          "payload-cap",
          `${error.message}\n\n  REGENERATION BUDGET EXHAUSTED (${regenerationRefusals} of ` +
            `${IMPRESSION_REGENERATION_RETRY_BUDGET}). This is now an operator-visible failure: ` +
            "this run cannot commit. Stop making tool calls and end your reply.",
        );
      }
    },
    shown: () => shownAdvisories,
  };
}
