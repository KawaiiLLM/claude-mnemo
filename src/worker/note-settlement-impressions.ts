import type { Database } from "bun:sqlite";

import { resolveEraCutoff } from "../db/era";
import { edgeRelationClass } from "../shared/relation-class";
import {
  ackClaimedImpressionDebts,
  claimOpenImpressionDebtsForSegments,
  dbImpressionAnchorResolver,
  listClaimedImpressionDebtsForJob,
  readLaneImpression,
  replaceLaneImpression,
  type ImpressionDebtRecord,
  type StoredImpression,
} from "../db/impressions";
import { getLane } from "../db/lanes";
import {
  assertNoteSettlementJobClaimed,
  NoteSettlementJobFenceError,
} from "../db/note-settlement-completion";
import type { NoteSettlementStage } from "../db/note-settlement";
import {
  readNoteSettlementLaneMemberSnapshot,
  readNoteSettlementWorklistSnapshot,
} from "../db/note-settlement-snapshots";
import {
  getAttachedSegmentIds,
  readSegmentTaskImpression,
  replaceSegmentTaskImpression,
} from "../db/segments";
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
 *   3. the WRITE — one container at a time, through `remember`, validated in
 *      full AT THE CALL and refused THERE, recorded into this job's PENDING
 *      ledger and written nowhere yet;
 *   4. the TERMINAL CHECK — inside the terminal transaction, re-derive every
 *      coordinate, refuse the commit unless every touched container carries a
 *      valid pending decision, then promote, ack the debts and clear STALE.
 *
 * TICKET 10 MOVED THE WRITE OFF `commit`. It used to arrive as an `impressions`
 * array on the terminal gate, where ONE malformed entry refused the ENTIRE
 * commit — the same family as the livelock that burned job 166. The failure is
 * LOCAL now: a bad impression fails its own `remember`, is reported to the
 * writer with its violations, and everything already decided stands. The
 * terminal obligation was not weakened to buy that; it was made unreachable in
 * the normal case, because nothing invalid can become pending.
 *
 * THE PAYLOAD CAP RETIRED WITH THE PAYLOAD. 256 KiB of serialized bytes was a
 * bound on a BATCH; there is no batch any more. What binds one container's text
 * is its own token cap (≤500 for a lane, ≤500 flat for the task tier), enforced
 * by the deterministic validator at the `remember` call — a strictly tighter
 * bound reached a strictly earlier moment. The compress-only regeneration
 * budget went with it: it existed to stop a stubborn writer resending the same
 * oversized BATCH forever, and a writer that cannot fit one container inside
 * its own cap is refused per call and simply never reaches a commit, which the
 * dispatch's own attempt accounting already answers.
 *
 * NOTHING here opens a transaction. `settleImpressions` runs inside the caller's
 * terminal write transaction (worker/note-settlement-direct-write.ts's
 * `commit`), which is what makes a rejection roll the edges' terminal mark back
 * with it: impressions and the commit that carries them land together or not at
 * all. `recordImpressionDecision` opens none either — it WRITES nothing.
 */

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
  /**
   * Merge-family staleness: while set, a `retain` is refused. Since ticket 07
   * the flag means "this container must be REWRITTEN" and nothing more — the
   * fold concatenated both sides' impressions into `currentText`, which readers
   * see; what is missing is the single model that replaces the join.
   */
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
  /** Anchors in the CURRENT text that this window's own FULL corrections invalidated (stored as `override`, the interim word for `correct`+`full` — see `shared/relation-class.ts`) — a `retain` is refused while any stands. */
  overriddenAnchors: string[];
  /** Anchors this window's own PARTIAL corrections NUDGE (stored as `narrows`, the interim word for `correct`+`partial`; spec: never a mechanical deletion). */
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
    laneKeys.set(`${segmentId}\u0000${laneTag}`, { segmentId, laneTag });
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
  // BY CLASS AND COVERAGE (main-agent-edges pinned decision P4), keyed off the
  // ONE accessor so a row written under either vocabulary answers the same.
  //
  // THE TWO LISTS STAY APART, and that is the whole care this rewrite needs:
  // `overridden` drives a HARD refusal of a `retain` decision, `narrowed` is an
  // advisory warning. `override` and `narrows` are `correct/full` and
  // `correct/partial` exactly — one source word each — so collapsing them into
  // one "class is correct" predicate would silently promote every PARTIAL
  // correction into the hard refusal. Each list keeps precisely its old
  // membership.
  //
  // One scan per anchor, partitioned in memory, where it used to run the
  // lookup twice.
  const relationLookup = db.query<
    { citingId: number; relation: string | null; relationClass: string | null; relationCoverage: string | null },
    [number]
  >(
    `SELECT citing_id AS citingId, relation AS relation,
            relation_class AS relationClass, relation_coverage AS relationCoverage
       FROM memory_edges
      WHERE cited_kind = 'turn' AND cited_id = ?
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
    let hitsFull = false;
    let hitsPartial = false;
    for (const edge of relationLookup.all(row.id)) {
      if (!writableTurnIds.has(edge.citingId)) {
        continue;
      }
      const resolved = edgeRelationClass({
        relation: edge.relation,
        relationClass: (edge.relationClass ?? "") as never,
        relationCoverage: (edge.relationCoverage ?? "") as never,
      });
      if (resolved === null || resolved.relationClass !== "correct") {
        continue;
      }
      if (resolved.relationCoverage === "full") {
        hitsFull = true;
      } else if (resolved.relationCoverage === "partial") {
        hitsPartial = true;
      }
    }
    if (!seenOverridden.has(address) && hitsFull) {
      seenOverridden.add(address);
      overridden.push(address);
    }
    if (!seenNarrowed.has(address) && hitsPartial) {
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
        "    STALE: a merge fused two identities into this one, and the text above is the two " +
          "sides' impressions CONCATENATED — readers are being shown that join right now. " +
          "Rewrite it into ONE model within the cap. A retain is refused here.",
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
      "    current:",
      ...advisory.currentText.split("\n").map((line) => `      ${line}`),
    );
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// The decision — one container, written through `remember`
// ---------------------------------------------------------------------------

/** One container's judgment, as the `remember` call carries it. */
export interface ImpressionDecision {
  id: string;
  baseRevision: number;
  decision: "retain" | "replace";
  text?: string;
}

/**
 * A decision that has PASSED every check and is waiting for the terminal
 * transaction. It carries its own coordinates rather than pointing at the
 * advisory it was made against — a pending decision is a claim about a
 * VERSION, and the commit re-derives that version to see whether it still
 * holds. Nothing here is written anywhere until `settleImpressions` promotes
 * it.
 */
export interface PendingImpressionDecision extends ImpressionContainerRef {
  decision: "retain" | "replace";
  /** The validated, normalized bytes of a `replace`; `null` for a `retain`. */
  text: string | null;
  /** The revision this judgment was made against — re-checked at commit. */
  baseRevision: number;
  /** The membership digest this judgment's cap was taken over — re-checked at commit. */
  membershipGeneration: string;
  /** The cap in force when it was decided; the commit recomputes its own. */
  cap: number;
  decidedAtEpoch: number;
}

export type ImpressionDecisionResult =
  | { ok: true; pending: PendingImpressionDecision; receipt: string }
  | { ok: false; message: string };

function decisionRefusal(header: string, body: readonly string[] = []): string {
  return [
    `Impression refused — ${header} NOTHING was written and no other decision ` +
      "you have already recorded is affected: repair THIS one and call " +
      "`remember` again.",
    ...body.map((line) => `  ${line}`),
  ].join("\n");
}

/**
 * THE SHAPE CHECK. Separate from everything below because it needs no database
 * at all: a caller that cannot name a container, a revision and a verdict has
 * not made a judgment yet.
 */
function parseImpressionDecision(
  raw: Record<string, unknown>,
): { ok: true; decision: ImpressionDecision } | { ok: false; message: string } {
  const id = raw.id;
  if (typeof id !== "string" || id.trim() === "") {
    return {
      ok: false,
      message:
        '`id` is required — the container address exactly as your advisory printed it, ' +
        '"E<n>/#<tag>" for a lane or "E<n>" for the task tier.',
    };
  }
  const decision = raw.decision;
  if (decision !== "retain" && decision !== "replace") {
    return {
      ok: false,
      message: `\`decision\` is required for ${id.trim()} — "retain" or "replace".`,
    };
  }
  const baseRevision = raw.baseRevision;
  if (!Number.isSafeInteger(baseRevision) || (baseRevision as number) < 0) {
    return {
      ok: false,
      message:
        `\`baseRevision\` is required for ${id.trim()} — the revision you were shown for ` +
        "it, as an integer.",
    };
  }
  if (decision === "replace" && (typeof raw.text !== "string" || raw.text.trim() === "")) {
    return {
      ok: false,
      message: `${id.trim()} is a replace and needs \`text\` — the WHOLE new impression, never a patch.`,
    };
  }
  if (decision === "retain" && raw.text !== undefined) {
    return {
      ok: false,
      message: `${id.trim()} is a retain and must carry no \`text\` — a retain keeps the stored bytes exactly.`,
    };
  }
  return {
    ok: true,
    decision: {
      id: id.trim(),
      baseRevision: baseRevision as number,
      decision,
      ...(decision === "replace" ? { text: raw.text as string } : {}),
    },
  };
}

export interface RecordImpressionDecisionInput {
  jobId: number;
  writableTurnIds: ReadonlySet<number>;
  claimedDebts: readonly ImpressionDebtRecord[];
  /** The `remember` call's own arguments. */
  raw: Record<string, unknown>;
  nowEpoch: number;
  /** Addresses this run has already decided — printed on the receipt as what is still owed. */
  alreadyDecided: ReadonlySet<string>;
}

/**
 * ONE CONTAINER'S DECISION, VALIDATED IN FULL AND REFUSED HERE.
 *
 * This is ticket 10's whole point (its finding 3): the isolation a per-call
 * write buys must not be paid for with a weaker terminal gate, so EVERYTHING
 * the terminal transaction would have checked about this one container is
 * checked right here — its membership in the touched set, its CAS revision, the
 * STALE and overridden-anchor obligations that forbid a retain, and the
 * deterministic validator against the cap recomputed on the post-commit
 * projection. A decision that survives all of it becomes PENDING; nothing
 * invalid ever does.
 *
 * IT WRITES NOTHING. Not the text, and — the finding this ticket names fourth —
 * not the STALE flag: `impression_stale` means "this container must be
 * rewritten", so clearing it here would let a run that produced nothing durable
 * discharge the obligation and leave the next run blind to what is owed. The
 * flag clears with the promotion, inside the terminal transaction.
 */
export function recordImpressionDecision(
  db: Database,
  input: RecordImpressionDecisionInput,
): ImpressionDecisionResult {
  const parsed = parseImpressionDecision(input.raw);
  if (!parsed.ok) {
    return { ok: false, message: decisionRefusal(parsed.message) };
  }
  const decision = parsed.decision;

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
  const advisory = advisories.find((entry) => entry.address === decision.id);
  if (advisory === undefined) {
    return {
      ok: false,
      message: decisionRefusal(
        `${decision.id} is not a container this run touched — an untouched container ` +
          "is not yours to rewrite.",
        [
          advisories.length === 0
            ? "This run owes a judgment on nothing at all."
            : `You owe a judgment on: ${advisories.map((entry) => entry.address).join(", ")}`,
        ],
      ),
    };
  }

  if (decision.baseRevision !== advisory.baseRevision) {
    return {
      ok: false,
      message: decisionRefusal(
        `${advisory.address}: baseRevision ${decision.baseRevision} is not the stored ` +
          `revision ${advisory.baseRevision} — another writer moved this row after you read it.`,
        ["Read the coordinates below and decide again.", "", renderImpressionAdvisories([advisory])],
      ),
    };
  }
  const offenders = projectionOffendersByAddress.get(advisory.address);
  if (offenders && offenders.length > 0) {
    return {
      ok: false,
      message: decisionRefusal(
        `${advisory.address}: ${offenders.length} of this window's own projected member(s) ` +
          "no longer belong to this lane — its membership moved under you.",
      ),
    };
  }
  if (decision.decision === "retain" && advisory.stale) {
    return {
      ok: false,
      message: decisionRefusal(
        `${advisory.address}: retained, but this container is STALE — a merge fused two ` +
          "identities and the stored text is their two impressions concatenated, not one " +
          "model. It must be replaced.",
        ["", renderImpressionAdvisories([advisory])],
      ),
    };
  }
  if (decision.decision === "retain" && advisory.overriddenAnchors.length > 0) {
    return {
      ok: false,
      message: decisionRefusal(
        `${advisory.address}: retained, but this window's own edges overrode the anchor(s) ` +
          `${advisory.overriddenAnchors.join(", ")} its text rests on. Revise or delete those ` +
          "sentences and replace.",
        ["", renderImpressionAdvisories([advisory])],
      ),
    };
  }

  let text: string | null = null;
  if (decision.decision === "replace") {
    text = normalizeImpressionText(decision.text!);
    const result = validateImpression({
      text,
      cap: advisory.cap,
      resolveAnchor: dbImpressionAnchorResolver(db, { logger: { warn: () => {} } }),
    });
    if (!result.accepted) {
      return {
        ok: false,
        message: decisionRefusal(
          `${advisory.address} failed the write-time validator (cap ${advisory.cap} tokens).`,
          result.rejections.map(
            (rejection) =>
              `${rejection.line === null ? "" : `line ${rejection.line}: `}` +
              `${rejection.message} [${rejection.rule}]`,
          ),
        ),
      };
    }
  }

  const pending: PendingImpressionDecision = {
    kind: advisory.kind,
    segmentId: advisory.segmentId,
    laneTag: advisory.laneTag,
    address: advisory.address,
    decision: decision.decision,
    text,
    baseRevision: advisory.baseRevision,
    membershipGeneration: advisory.membershipGeneration,
    cap: advisory.cap,
    decidedAtEpoch: input.nowEpoch,
  };
  const owed = advisories
    .map((entry) => entry.address)
    .filter(
      (address) =>
        address !== advisory.address && !input.alreadyDecided.has(address),
    );
  const receipt = [
    `Impression recorded — ${advisory.address}: ${decision.decision} against revision ` +
      `${advisory.baseRevision}. PENDING: nothing is written, and no flag is cleared, until ` +
      "your own `commit` promotes it.",
    owed.length === 0
      ? "  Every container this run touched now carries a decision."
      : `  Still owed: ${owed.join(", ")}`,
  ].join("\n");
  return { ok: true, pending, receipt };
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
  /**
   * THE PENDING LEDGER — this job's recorded decisions, keyed by container
   * address. Job-scoped and held by the run that made them: a decision is a
   * claim about a version, and a run that dies before its commit leaves no
   * claim behind for a successor to inherit blind.
   */
  pending: ReadonlyMap<string, PendingImpressionDecision>;
  nowEpoch: number;
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
      "record the decision each container below is owed with " +
      '`remember(action: "impression", …)` and call `commit` again in this same run.',
    ...body.map((line) => `  ${line}`),
  ];
  if (advisories.length > 0) {
    lines.push("", renderImpressionAdvisories(advisories));
  }
  throw new ImpressionSettlementRefused(kind, lines.join("\n"));
}

/**
 * THE TERMINAL TRANSACTION'S IMPRESSION HALF — now a CHECK and a PROMOTION.
 * Runs inside `commit`'s own write transaction, after the lease fence and
 * before the completion CAS.
 *
 * TICKET 10 CHANGED THE OBJECT OF THIS CHECK, not its strength. It used to
 * judge a PAYLOAD; it judges the DUTY: every container this run touched carries
 * a current, valid decision. The four things that happen here, in this order,
 * all inside the one transaction:
 *
 *   1. COVERAGE — the pending ledger covers the touched set exactly. A touched
 *      container with no decision refuses the commit BY NAME (the whole reason
 *      "write it when you decide it" cannot quietly become "write some of it").
 *   2. THE COORDINATES — every pending decision's base revision and membership
 *      generation are re-derived and re-compared. This is what a durable write
 *      plus a lazy commit would have lost: the ledger records what the writer
 *      decided against, and only this moment can say whether it still holds.
 *   3. THE VALIDATOR, AGAIN, on every pending replacement. Nothing invalid can
 *      become pending, so this is unreachable in the normal case — and it is
 *      kept precisely so the duty check has content even if it were not: a cap
 *      recomputed on the post-commit projection can be TIGHTER than the one the
 *      decision was validated against.
 *   4. THE PROMOTION — the writes land, the lifecycle debts are acked, and
 *      STALE clears with the replacement that discharges it. A commit that
 *      fails leaves no promoted impression and no cleared flag, because all of
 *      it rides this one transaction.
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

  // 1. COVERAGE — every touched container carries a decision, and nothing else
  //    does. "A touched container with no judgment is a rejected payload, not a
  //    silent skip" (spec's durable-obligation ruling); ticket 10 keeps the
  //    rule and moves only where the judgment was written.
  const byAddress = new Map<string, ImpressionAdvisory>(
    advisories.map((advisory) => [advisory.address, advisory]),
  );
  const missing = advisories
    .filter((advisory) => !input.pending.has(advisory.address))
    .map((advisory) => advisory.address);
  const strangers = [...input.pending.keys()].filter(
    (address) => !byAddress.has(address),
  );
  if (missing.length > 0 || strangers.length > 0) {
    const body: string[] = [];
    if (missing.length > 0) {
      body.push(`no decision recorded for: ${missing.join(", ")}`);
    }
    if (strangers.length > 0) {
      body.push(
        `decided, but no longer touched by this run: ${strangers.join(", ")} — the ` +
          "container moved out of your set after you decided it",
      );
    }
    refuse(
      "coverage",
      "this run does not carry a current decision for every container it touched.",
      body,
      advisories,
    );
  }

  // 2. THE COORDINATES, over the FULL set, before any write.
  const fenceFailures: string[] = [];
  for (const advisory of advisories) {
    const decision = input.pending.get(advisory.address)!;
    if (decision.baseRevision !== advisory.baseRevision) {
      fenceFailures.push(
        `${advisory.address}: you decided against revision ${decision.baseRevision}, and the ` +
          `stored revision is now ${advisory.baseRevision} — another writer moved this row ` +
          "after you decided",
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
    // THE MEMBERSHIP COORDINATE, compared against the decision's OWN digest.
    // Every pending decision was necessarily made against a loaded advisory, so
    // unlike the retired payload — which could name a container the run had
    // never been shown — there is no "no earlier generation to compare" case
    // left here, and no exemption to carry.
    if (decision.membershipGeneration !== advisory.membershipGeneration) {
      fenceFailures.push(
        `${advisory.address}: this lane's settled membership moved since you decided it ` +
          `(${decision.membershipGeneration} → ${advisory.membershipGeneration}); its budget ` +
          `is now ${advisory.cap} tokens`,
      );
      continue;
    }
    if (decision.decision === "retain" && advisory.stale) {
      fenceFailures.push(
        `${advisory.address}: retained, but this container is STALE — a merge fused two ` +
          "identities and the stored text is their two impressions concatenated, not one " +
          "model. It must be replaced",
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

  // 3. THE DETERMINISTIC VALIDATOR, again, on the pending replacements only,
  //    against the cap recomputed on the post-commit projection with the SAME
  //    integer formula the decision used (`impressionCapForLane`). Retains are
  //    never re-validated — grandfathered text is never force-trimmed (spec:
  //    "The cap binds REPLACEMENTS only").
  //    Resolvability goes through ticket 01's ONE resolver, not a second copy of
  //    its lookup: two predicates answering "does this anchor resolve" are two
  //    predicates that can drift, and the frontier batch already paid for that
  //    lesson once. The silent logger is the only local adaptation — the shared
  //    citation path warns about "dropped illegal references", which is exactly
  //    what does NOT happen here (a bad anchor rejects the whole commit).
  const resolveAnchor: ImpressionAnchorResolver = dbImpressionAnchorResolver(db, {
    logger: { warn: () => {} },
  });
  const replacements: Array<{ advisory: ImpressionAdvisory; text: string }> = [];
  const validationFailures: string[] = [];
  for (const advisory of advisories) {
    const decision = input.pending.get(advisory.address)!;
    if (decision.decision !== "replace") {
      continue;
    }
    const text = decision.text!;
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
      "one or more pending impression replacements no longer pass the write-time validator.",
      validationFailures,
      advisories,
    );
  }

  // 4. THE PROMOTION. Every write CASes again on the revision the fence just
  //    checked — the fence and the UPDATE are in one transaction, so this can
  //    only fail if the fence read a row this write cannot address at all, and
  //    that is a rejection, never a retry. STALE clears HERE, as part of the
  //    replacement itself (`replaceLaneImpression`), which is what makes "the
  //    flag clears only when a qualified run CAS-rewrites" true of the COMMIT
  //    rather than of the write that proposed it.
  for (const { advisory, text } of replacements) {
    const landed =
      advisory.kind === "lane"
        ? replaceLaneImpression(db, {
            segmentId: advisory.segmentId,
            tag: advisory.laneTag!,
            baseRevision: advisory.baseRevision,
            text,
          })
        : replaceSegmentTaskImpression(db, {
            segmentId: advisory.segmentId,
            baseRevision: advisory.baseRevision,
            text,
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

  // 5. THE DEBT ACK — only now, in the SAME transaction (spec: "ACKS them only
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

// ---------------------------------------------------------------------------
// The claim (spec "Lifecycle debts", claim/ack discipline; ticket 03)
// ---------------------------------------------------------------------------

export interface AttachedImpressionDebtClaimerOptions {
  /** The lease stamp — `note_settlement_jobs.id`, which survives a claim-generation bump. */
  jobId: number;
  /** THE ELIGIBILITY COORDINATE: only this session's ATTACHED tasks' debts may be claimed. */
  sessionId: number;
  now: () => number;
}

/**
 * THE REAL CLAIM behind ticket 02's injectable seam.
 *
 * ELIGIBILITY IS ATTACHMENT, and it is asked through the ONE predicate that
 * already answers it — `getAttachedSegmentIds` (db/segments.ts), the same read
 * the turn facade's own scope and the attach menu use. The spec's rule is
 * exact: "only a run whose session is attached to the debt's task may claim it
 * — a debt with no eligible run WAITS DURABLY". An unattached run therefore
 * claims NOTHING, not because a filter dropped its rows but because its
 * eligible segment list is empty and the claim has nowhere to reach; the debts
 * keep waiting, unclaimed and unmarked, for a run that is attached.
 *
 * CLAIM, THEN LIST — AND NO MEMO. The seam is called several times in one run:
 * the advisory render at run start, every refusal's re-render, and again inside
 * the terminal transaction. Two facts force this shape.
 *
 * First, the answer must come from `listClaimedImpressionDebtsForJob`, never
 * from the claim's own return: `claimOpenImpressionDebtsForSegments` hands back
 * only what THAT call newly leased, so a second call would answer with the
 * empty set, shrink the run's touched set between its advisory and its commit,
 * and refuse the payload for a coverage mismatch nobody caused.
 *
 * Second, the claim itself is re-asserted every time rather than remembered in
 * this closure, because a REFUSED commit rolls its whole transaction back — and
 * the seam is called inside that transaction. A closure that remembered "I
 * already claimed" would, after one refusal, keep answering from a lease the
 * rollback had undone. Re-asserting is cheap (the claim write matches nothing
 * once the lease is held) and, unlike a memo, it cannot go stale.
 *
 * A DEBT BORN MID-RUN therefore joins the claim at the next call rather than
 * being silently swallowed — and that is the spec's own answer, not a
 * concession: a manual lifecycle write landing between a run's read and its
 * commit rejects that commit for re-read-re-decide. The new container appears
 * in the touched set, the payload does not cover it, and the run is sent back
 * with the re-rendered coordinates. Nothing is ever acked without a judgment.
 *
 * ACROSS PROCESSES IT IS THE SAME LEASE. The resume path claims in the dispatch
 * (to render the prompt's advisory) and the child claims again in its own
 * process; the second claim finds nothing unclaimed and the list returns the
 * same rows, because the lease is stamped with the JOB, not with either
 * process's instance of this closure.
 */
export function createAttachedImpressionDebtClaimer(
  options: AttachedImpressionDebtClaimerOptions,
): (db: Database) => readonly ImpressionDebtRecord[] {
  return (db: Database): readonly ImpressionDebtRecord[] => {
    claimOpenImpressionDebtsForSegments(
      db,
      getAttachedSegmentIds(db, options.sessionId),
      options.jobId,
      options.now(),
    );
    return listClaimedImpressionDebtsForJob(db, options.jobId);
  };
}

export interface SettlementImpressionMaintainerOptions {
  db: Database;
  jobId: number;
  /**
   * THE LEASE, and it is this ticket's first "must not get wrong": the
   * impression write is not public. `decide` asserts `(job, claimGeneration,
   * stage)` before it will record anything, so the operation belongs to the run
   * that holds the lease and to nothing else — a reclaimed or stale claimant is
   * refused by the same fence every settlement write already answers to.
   */
  claimGeneration: number;
  /** The stage this call believes it is in — a getter, because the unified run transitions mid-run. */
  readStage: () => NoteSettlementStage;
  /** Live at construction; read through a getter so the frozen edge-pass set replaces it in place. */
  readWritableTurnIds: () => ReadonlySet<number>;
  /**
   * THE CLAIMED-SET SEAM (ticket 02's own boundary: "the claim machinery itself
   * is ticket 03; this ticket consumes an injectable claimed-set seam"). Called
   * once per advisory render, once per decision, and once inside the terminal
   * transaction. The default claims nothing, so a bare unit test sees no debts —
   * and the ack below is a no-op against an empty claim.
   */
  claimImpressionDebts?: (db: Database) => readonly ImpressionDebtRecord[];
  now?: () => number;
}

export interface SettlementImpressionMaintainer {
  /**
   * The advisory block, computed and REMEMBERED. Every address it prints enters
   * the ledger of what this run has been shown, which is what the receipts and
   * refusals below can name.
   */
  renderAdvisories(): string;
  /**
   * ONE CONTAINER'S DECISION, from the `remember` tool. Validates in full,
   * refuses HERE, and on success records a PENDING decision — writing nothing.
   * A refusal is local: no other pending decision is touched.
   */
  decide(db: Database, raw: Record<string, unknown>): { ok: boolean; text: string };
  /** Runs inside the terminal transaction; throws `ImpressionSettlementRefused` on any rejection. */
  settle(db: Database): SettleImpressionsOutcome;
  /** Test/report visibility: what this run has been shown so far. */
  shown(): ReadonlyMap<string, ImpressionAdvisory>;
  /** Test/report visibility: the pending ledger this run's `commit` will be judged against. */
  pending(): ReadonlyMap<string, PendingImpressionDecision>;
}

/**
 * THE RUN-SCOPED MAINTAINER — the advisory ledger, the PENDING DECISION LEDGER,
 * and the two seams the tool layer calls.
 *
 * THE PENDING LEDGER IS IN MEMORY, JOB-SCOPED, AND HELD BY THE RUN THAT MADE
 * ITS DECISIONS. That is a choice, and the reason is the one thing a durable
 * table could not have: a pending decision is a claim about a VERSION — the
 * revision and the membership digest it was decided against — and those
 * coordinates are only meaningful to the run that read them. A table would
 * outlive the process that filled it, and the next attempt would inherit
 * judgments made against text it never saw, over a window it has not read; it
 * would then either re-verify them all (in which case the table bought
 * nothing) or trust them (in which case the whole fence is gone). A run that
 * dies before its commit leaves NOTHING promoted, NOTHING acked and no flag
 * cleared, and its successor re-reads and re-decides — which is exactly the
 * spec's re-read-re-decide discipline, reached by construction rather than by
 * a cleanup path someone has to remember to write.
 */
export function createSettlementImpressionMaintainer(
  options: SettlementImpressionMaintainerOptions,
): SettlementImpressionMaintainer {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const claimDebts = options.claimImpressionDebts ?? (() => []);
  const shownAdvisories = new Map<string, ImpressionAdvisory>();
  const pendingDecisions = new Map<string, PendingImpressionDecision>();

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
    decide(db, raw) {
      // THE PRINCIPAL GATE. Asserted before the decision is even parsed: an
      // impression write is settlement's alone, so a caller that does not hold
      // THIS job's lease at THIS stage is told so and nothing else happens.
      try {
        assertNoteSettlementJobClaimed(
          db,
          options.jobId,
          options.claimGeneration,
          options.readStage(),
        );
      } catch (error) {
        if (error instanceof NoteSettlementJobFenceError) {
          return {
            ok: false,
            text:
              "Impression refused — the impression write belongs to the settlement run that " +
              `holds this window's lease, and this dispatch's lease was reclaimed (${error.message}). ` +
              "Nothing was written. No further write or commit will succeed. Stop making tool calls.",
          };
        }
        throw error;
      }
      const result = recordImpressionDecision(db, {
        jobId: options.jobId,
        writableTurnIds: options.readWritableTurnIds(),
        claimedDebts: claimDebts(db),
        raw,
        nowEpoch: now(),
        alreadyDecided: new Set(pendingDecisions.keys()),
      });
      if (!result.ok) {
        return { ok: false, text: result.message };
      }
      // LAST DECISION WINS, per container: a writer that re-reads a refused
      // container's coordinates and decides again is doing the right thing, and
      // its second judgment is the one the commit is held to.
      pendingDecisions.set(result.pending.address, result.pending);
      return { ok: true, text: result.receipt };
    },
    settle(db) {
      try {
        return settleImpressions(db, {
          jobId: options.jobId,
          writableTurnIds: options.readWritableTurnIds(),
          claimedDebts: claimDebts(db),
          pending: pendingDecisions,
          nowEpoch: now(),
        });
      } catch (error) {
        if (!(error instanceof ImpressionSettlementRefused)) {
          throw error;
        }
        // EVERY refusal re-renders the coordinates, and every re-render enters
        // the shown ledger: the next `commit` in this same run decides against
        // what it was just shown, which is the whole point of re-read-re-decide.
        // Reading them here (rather than inside `settleImpressions`) keeps that
        // module free of the ledger it reports through.
        remember(computeAdvisories(db));
        throw error;
      }
    },
    shown: () => shownAdvisories,
    pending: () => pendingDecisions,
  };
}
