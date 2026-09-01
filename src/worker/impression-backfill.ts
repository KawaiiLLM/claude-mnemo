import type { Database } from "bun:sqlite";

import {
  dbImpressionAnchorResolver,
  readLaneImpression,
  replaceLaneImpression,
} from "../db/impressions";
import { listLanesForSegment } from "../db/lanes";
import {
  getSegment,
  readSegmentTaskImpression,
  replaceSegmentTaskImpression,
  retireSegmentImpressionSourceFields,
  type SegmentRecord,
} from "../db/segments";
import { liveTurnSql } from "../db/turn-liveness";
import { settledMemberIdsForLane } from "../mcp/timeline";
import { SEGMENT_IMPRESSION_SOURCE_FIELDS } from "../shared/segment-fields";
import {
  impressionCapForLane,
  validateImpression,
  type ImpressionAnchorResolver,
  TASK_IMPRESSION_TOKEN_CAP,
} from "../shared/lane-impressions";

import { resolveEraCutoffForImpressions } from "./note-settlement-impressions";

/**
 * THE LEGACY BACKFILL (lane-impressions spec Rev 8, "Legacy backfill"; ticket
 * 05) — the distinct migration job that turns one task's retiring narrative
 * fields into the impression surface that succeeds them, and cuts that task
 * over in the same transaction.
 *
 * WHY IT IS NOT SETTLEMENT. Ordinary settlement deliberately cannot see segment
 * fields and holds no whole-task context; asking it to author this would be
 * asking it to fake authority over content it never reads. So the backfill is
 * its own job, per task, with its own inputs (the four source fields, the
 * declared-lane roster, the member/anchor index), its own teaching variant
 * (impression-backfill-teaching.ts) and its own fence.
 *
 * WHAT THIS MODULE IS AND IS NOT. Everything here is SYNCHRONOUS and
 * transaction-shaped: the coverage query, the source snapshot, the input
 * assembly, and `commitImpressionBackfill`, which runs INSIDE the caller's
 * write transaction so that a refusal rolls the whole cutover back. The
 * asynchronous half — claim, generate, bounded retry — is
 * `impression-backfill-runner.ts`, and the model client itself is a seam that
 * module takes, because a model job may not run inside a schema migration and
 * must not be reachable from the worker core.
 *
 * THE ORDER IS THE SPEC'S, and it is enforced by statement order in one
 * transaction: seed the lane impressions, seed the task tier (which flips
 * `impression_origin` and with it the card's pointer line and slimmed form),
 * and only THEN retire done/decisions/next_steps. No state in which a field is
 * cleared and no successor exists is reachable, because the only writer of the
 * clear runs last inside the transaction the seeds are in.
 */

// ---------------------------------------------------------------------------
// Digests — the fence's alphabet
// ---------------------------------------------------------------------------

/**
 * FNV-1a over a string, as 8 lowercase hex digits. The fence needs a stable,
 * order-free-of-scheduling summary of "is this input still the one I read",
 * and a content hash is what the spec offers beside a write sequence: SQLite's
 * own `write_gate_stamps` are second-granular, so two writes inside one second
 * are indistinguishable there — a hash of the bytes is not.
 */
function fnv1aHex(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index) & 0xff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
    hash ^= input.charCodeAt(index) >>> 8;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * A digest over an ordered list of parts, LENGTH-PREFIXED so it needs no
 * separator at all: `["ab","c"]` and `["a","bc"]` encode differently by
 * construction. An ABSENT part (`null`) encodes as a length no string can
 * have, so "this field was NULL" and "this field held the empty string" are
 * two different digests rather than one.
 */
function digestParts(kind: string, parts: readonly (string | null)[]): string {
  const joined = parts
    .map((part) => (part === null ? "-1:" : `${part.length}:${part}`))
    .join("");
  return `${kind}${parts.length}-${fnv1aHex(joined)}`;
}

/**
 * The four source fields, as readers of a `SegmentRecord`. Keyed by
 * `SEGMENT_IMPRESSION_SOURCE_FIELDS`, so the digest cannot come to describe a
 * different field set than the one the spec names — adding a source field
 * there makes this map a type error rather than a silent fence hole.
 */
const SOURCE_FIELD_VALUE: Record<
  (typeof SEGMENT_IMPRESSION_SOURCE_FIELDS)[number],
  (segment: SegmentRecord) => string | null
> = {
  decisions: (segment) => segment.decisions,
  done: (segment) => segment.done,
  next_steps: (segment) => segment.nextSteps,
  content: (segment) => segment.content,
};

// ---------------------------------------------------------------------------
// Coverage — BY QUERY, open and closed alike
// ---------------------------------------------------------------------------

/**
 * One task that still carries legacy narrative fields, with the sizes the scale
 * gate is measured in.
 */
export interface LegacyFieldTask {
  segmentId: number;
  status: string;
  title: string;
  /** Characters in each source field, and their sum — the input-assembly axis. */
  doneChars: number;
  decisionsChars: number;
  nextStepsChars: number;
  contentChars: number;
  sourceChars: number;
  declaredLaneCount: number;
  memberCount: number;
}

/**
 * EVERY task carrying legacy fields, largest first — found BY QUERY, never by a
 * hand list (spec "Coverage", peer round-3 finding 5).
 *
 * OPEN AND CLOSED ALIKE, and the query says so by naming no status at all:
 * "closed tasks stay recallable and can reopen, so history must migrate too".
 * Production also still holds the retired arc-era words (`delivered`,
 * `abandoned`) on 43 of its 61 legacy-field rows, so any status predicate here
 * — even an inclusive-looking one — would have silently excluded most of the
 * corpus. The absence of the predicate is the coverage guarantee.
 *
 * "CARRIES LEGACY FIELDS" is one predicate with two halves: any of the three
 * retiring narrative fields holds non-blank text, OR `content` holds non-blank
 * text while `impression_origin IS NULL` — ticket 01's mechanical "the content
 * slot is still legacy field text" discriminator, which is also exactly the
 * flag this job's commit flips. A task whose content is already an impression
 * and whose narrative fields are empty has nothing left to migrate and does not
 * appear.
 */
export function listTasksCarryingLegacyFields(db: Database): LegacyFieldTask[] {
  return db
    .query<LegacyFieldTask, []>(
      `SELECT s.id AS segmentId,
              s.status AS status,
              s.title AS title,
              length(coalesce(s.done, '')) AS doneChars,
              length(coalesce(s.decisions, '')) AS decisionsChars,
              length(coalesce(s.next_steps, '')) AS nextStepsChars,
              length(coalesce(s.content, '')) AS contentChars,
              length(coalesce(s.done, ''))
                + length(coalesce(s.decisions, ''))
                + length(coalesce(s.next_steps, ''))
                + length(coalesce(s.content, '')) AS sourceChars,
              (SELECT count(*) FROM lanes l WHERE l.segment_id = s.id) AS declaredLaneCount,
              (SELECT count(*) FROM segment_members m WHERE m.segment_id = s.id) AS memberCount
         FROM segments s
        WHERE trim(coalesce(s.done, '')) <> ''
           OR trim(coalesce(s.decisions, '')) <> ''
           OR trim(coalesce(s.next_steps, '')) <> ''
           OR (trim(coalesce(s.content, '')) <> '' AND s.impression_origin IS NULL)
        ORDER BY sourceChars DESC, s.id ASC`,
    )
    .all();
}

// ---------------------------------------------------------------------------
// The source snapshot — every coordinate the committing transaction re-checks
// ---------------------------------------------------------------------------

/**
 * THE SOURCE-SNAPSHOT FENCE'S STATE (spec "Source-snapshot fence", peer round-3
 * finding 2). Deployment phase 1 keeps the old fields WRITABLE, so every one of
 * this job's inputs can move under it while the model is generating. Each
 * coordinate answers exactly one question, and each is compared separately so a
 * refusal names WHICH input moved.
 */
export interface BackfillSourceSnapshot {
  segmentId: number;
  /** The four source fields' contents — "a decision appended mid-generation must never be swallowed by a stale-snapshot clear". */
  sourceFields: string;
  /** The declared-lane ROSTER: which lanes exist. A declare, an undeclare, a rename or a merge moves it. */
  laneRegistry: string;
  /** The MEMBER/ANCHOR index: which turns this task owns and which lane words each carries. A tag write or a membership change moves it. */
  memberIndex: string;
  /** The task tier's impression fence, read before generation — a settlement replacement landing mid-call must not be clobbered. */
  taskImpressionRevision: number;
  /** Each declared lane's impression fence, same reason, keyed by tag. */
  laneImpressionRevisions: ReadonlyArray<{ tag: string; revision: number }>;
}

/** One member turn, as the migration's anchor index shows it. */
export interface BackfillAnchorRow {
  turnId: number;
  sessionId: number;
  promptNumber: number;
  /** The qualified anchor form a claim must cite: `S<n>/T<m>`. */
  address: string;
  title: string | null;
  /** The lane words this turn carries inside this task, ascending. */
  laneTags: string[];
  createdAtEpoch: number;
}

interface AnchorDbRow {
  turnId: number;
  sessionId: number;
  promptNumber: number;
  title: string | null;
  tags: string | null;
  createdAtEpoch: number;
}

/**
 * THE MEMBER/ANCHOR INDEX — one read, one meaning: every LIVE turn this task
 * owns, in event order, with the address a claim must cite it by and the lane
 * words it carries.
 *
 * It is the migration's ONLY source of anchors, which is what makes "load-bearing
 * claims MUST be re-sourced to qualified anchors THROUGH the member/anchor
 * index" mechanically checkable at commit (`admissibleAnchorAddresses` below)
 * rather than a hope about the writer.
 *
 * Per-lane membership is DERIVED from each row's own `laneTags` rather than
 * asked again per lane: the same question asked twice is two answers that can
 * drift, and a per-lane query would also count a turn once per lane it carries.
 */
export function loadBackfillAnchorIndex(
  db: Database,
  segmentId: number,
  declaredTags: readonly string[],
): BackfillAnchorRow[] {
  const declared = new Set(declaredTags);
  return db
    .query<AnchorDbRow, [number]>(
      `SELECT t.id AS turnId,
              t.session_id AS sessionId,
              t.prompt_number AS promptNumber,
              t.title AS title,
              t.tags AS tags,
              t.created_at_epoch AS createdAtEpoch
         FROM segment_members sm
         JOIN turns t ON t.id = sm.turn_id
        WHERE sm.segment_id = ? AND ${liveTurnSql("t")}
        ORDER BY t.created_at_epoch ASC, t.id ASC`,
    )
    .all(segmentId)
    .map((row) => {
      let laneTags: string[] = [];
      if (row.tags) {
        try {
          const parsed = JSON.parse(row.tags) as unknown;
          if (Array.isArray(parsed)) {
            laneTags = [...new Set(parsed.filter((tag): tag is string => typeof tag === "string"))]
              .filter((tag) => declared.has(tag))
              .sort();
          }
        } catch {
          laneTags = [];
        }
      }
      return {
        turnId: row.turnId,
        sessionId: row.sessionId,
        promptNumber: row.promptNumber,
        address: `S${row.sessionId}/T${row.promptNumber}`,
        title: row.title,
        laneTags,
        createdAtEpoch: row.createdAtEpoch,
      };
    });
}

/**
 * Read every fence coordinate at one moment. `null` iff the segment is gone.
 *
 * Called TWICE per attempt — once to build the input the model generates from,
 * and once inside the committing transaction — and compared with
 * `compareBackfillSourceSnapshots`. That is the whole fence: nothing here
 * decides anything, it only records what was true.
 */
export function captureBackfillSourceSnapshot(
  db: Database,
  segmentId: number,
): BackfillSourceSnapshot | null {
  const segment = getSegment(db, segmentId);
  if (!segment) {
    return null;
  }
  const lanes = listLanesForSegment(db, segmentId);
  const declaredTags = lanes.map((lane) => lane.tag);
  const anchors = loadBackfillAnchorIndex(db, segmentId, declaredTags);
  const taskImpression = readSegmentTaskImpression(db, segmentId);
  return {
    segmentId,
    sourceFields: digestParts(
      "f",
      SEGMENT_IMPRESSION_SOURCE_FIELDS.map(
        (field) => SOURCE_FIELD_VALUE[field](segment),
      ),
    ),
    laneRegistry: digestParts(
      "r",
      lanes.map((lane) => `${lane.id}:${lane.tag}`),
    ),
    memberIndex: digestParts(
      "m",
      anchors.map((anchor) => `${anchor.turnId}:${anchor.laneTags.join(",")}`),
    ),
    taskImpressionRevision: taskImpression?.revision ?? 0,
    laneImpressionRevisions: declaredTags.map((tag) => ({
      tag,
      revision: readLaneImpression(db, segmentId, tag)?.revision ?? 0,
    })),
  };
}

/**
 * Every coordinate that moved between the two reads, named. EMPTY means the
 * whole snapshot held.
 *
 * ALL of them are reported, not the first — a writer sent back to regenerate
 * deserves the full picture, the same posture the deterministic validator and
 * the settlement fence already take.
 */
export function compareBackfillSourceSnapshots(
  read: BackfillSourceSnapshot,
  atCommit: BackfillSourceSnapshot,
): string[] {
  const drift: string[] = [];
  if (read.sourceFields !== atCommit.sourceFields) {
    drift.push(
      "the retiring fields (done/decisions/next_steps/content) were written after you read them " +
        `(${read.sourceFields} -> ${atCommit.sourceFields}) — clearing them now would swallow that write`,
    );
  }
  if (read.laneRegistry !== atCommit.laneRegistry) {
    drift.push(
      `this task's declared-lane roster moved (${read.laneRegistry} -> ${atCommit.laneRegistry}) — ` +
        "a lane was declared, renamed, merged or undeclared while you were writing",
    );
  }
  if (read.memberIndex !== atCommit.memberIndex) {
    drift.push(
      `the member/anchor index moved (${read.memberIndex} -> ${atCommit.memberIndex}) — ` +
        "a turn joined, left, or had its lane words rewritten while you were writing",
    );
  }
  if (read.taskImpressionRevision !== atCommit.taskImpressionRevision) {
    drift.push(
      `the task-tier impression moved (revision ${read.taskImpressionRevision} -> ` +
        `${atCommit.taskImpressionRevision}) — another writer reached this container first`,
    );
  }
  const laneRevisionAtCommit = new Map(
    atCommit.laneImpressionRevisions.map((entry) => [entry.tag, entry.revision]),
  );
  for (const entry of read.laneImpressionRevisions) {
    const now = laneRevisionAtCommit.get(entry.tag);
    if (now !== undefined && now !== entry.revision) {
      drift.push(
        `lane #${entry.tag}'s impression moved (revision ${entry.revision} -> ${now}) — ` +
          "another writer reached this container first",
      );
    }
  }
  return drift;
}

// ---------------------------------------------------------------------------
// Input assembly — what the migration writer is shown
// ---------------------------------------------------------------------------

export interface BackfillLaneInput {
  tag: string;
  /** `clamp(10 × settledMembers, 100, 500)`, computed on the SAME shared settled universe settlement's own advisory uses. */
  cap: number;
  settledMemberCount: number;
  /** The lane's own slice of the anchor index — addresses this lane's claims are expected to rest on. */
  anchors: BackfillAnchorRow[];
}

export interface BackfillTaskInput {
  segmentId: number;
  title: string;
  status: string;
  /** The four source fields, exactly as stored. */
  source: {
    done: string | null;
    decisions: string | null;
    nextSteps: string | null;
    content: string | null;
  };
  /** The task tier's flat 500. */
  taskCap: number;
  lanes: BackfillLaneInput[];
  /** Every live member turn, event order — the union the lane slices are taken from. */
  anchorIndex: BackfillAnchorRow[];
  snapshot: BackfillSourceSnapshot;
}

/**
 * Everything one migration job reads, at one moment, with the snapshot that
 * moment is fenced by. `null` iff the segment is gone.
 *
 * Re-run FROM SCRATCH on every attempt (see the runner): a re-claimed job
 * re-reads and re-generates, so a job whose fields moved between attempts
 * writes the CURRENT text, never a cached one.
 */
export function assembleBackfillInput(
  db: Database,
  segmentId: number,
): BackfillTaskInput | null {
  const segment = getSegment(db, segmentId);
  if (!segment) {
    return null;
  }
  const snapshot = captureBackfillSourceSnapshot(db, segmentId);
  if (snapshot === null) {
    return null;
  }
  const declaredTags = listLanesForSegment(db, segmentId).map((lane) => lane.tag);
  const anchorIndex = loadBackfillAnchorIndex(db, segmentId, declaredTags);
  const eraCutoffEpoch = resolveEraCutoffForImpressions(db);
  const lanes: BackfillLaneInput[] = declaredTags.map((tag) => {
    const settledMemberCount = settledMemberIdsForLane(
      db,
      segmentId,
      tag,
      eraCutoffEpoch,
    ).length;
    return {
      tag,
      cap: impressionCapForLane(settledMemberCount),
      settledMemberCount,
      anchors: anchorIndex.filter((anchor) => anchor.laneTags.includes(tag)),
    };
  });
  return {
    segmentId,
    title: segment.title,
    status: segment.status,
    source: {
      done: segment.done,
      decisions: segment.decisions,
      nextSteps: segment.nextSteps,
      content: segment.content,
    },
    taskCap: TASK_IMPRESSION_TOKEN_CAP,
    lanes,
    anchorIndex,
    snapshot,
  };
}

/**
 * The anchors a migration batch may cite — the member/anchor index's own
 * addresses and nothing else.
 *
 * TASK-SCOPED, not lane-scoped, and that is a decision worth stating: the
 * migration job reads ONE task at a time and shows the writer that task's whole
 * roster and index at once, so "cited through the index" is a task-level fact.
 * Which of those addresses belongs in WHICH lane is a lane-relevance judgment,
 * and lane relevance is a teaching duty (spec's own two-tier split) — turning
 * it into a code rejection here would smuggle a semantic ruling into the
 * mechanical tier, the exact mistake the validator section forbids.
 */
export function admissibleAnchorAddresses(
  anchorIndex: readonly BackfillAnchorRow[],
): Set<string> {
  return new Set(anchorIndex.map((anchor) => anchor.address));
}

// ---------------------------------------------------------------------------
// The generated batch
// ---------------------------------------------------------------------------

export interface BackfillLaneImpression {
  tag: string;
  text: string;
}

/** One legacy claim the writer could not place — the reason a task's cutover is REFUSED. */
export interface BackfillUnresolvedClaim {
  claim: string;
  reason: string;
}

export interface BackfillBatch {
  lanes: BackfillLaneImpression[];
  /** The TASK-TIER impression. Required: flipping `impression_origin` IS the cutover, and only this text flips it. */
  task: string;
  unresolved: BackfillUnresolvedClaim[];
}

export type ParsedBackfillBatch =
  | { ok: true; batch: BackfillBatch; bytes: number }
  | { ok: false; message: string; bytes: number };

/**
 * Parse and MEASURE the output batch. The measurement is of the UTF-8
 * serialized bytes of what the writer actually sent, taken before anything is
 * interpreted — the same rule and the same reason as the settlement payload's
 * (CJK and JSON escaping diverge from chars and from token estimates alike),
 * and it is the output-batch axis of the scale gate.
 */
export function parseBackfillBatch(raw: unknown): ParsedBackfillBatch {
  const bytes = raw === undefined ? 0 : Buffer.byteLength(JSON.stringify(raw) ?? "", "utf8");
  const reject = (message: string): ParsedBackfillBatch => ({ ok: false, bytes, message });
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return reject(
      'the migration batch must be an object: {"lanes": [...], "task": "...", "unresolved": [...]}.',
    );
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.task !== "string" || record.task.trim() === "") {
    return reject(
      '"task" is required — the task-tier impression. Its arrival is what cuts this task over; ' +
        "there is no batch without it.",
    );
  }
  const lanesRaw = record.lanes ?? [];
  if (!Array.isArray(lanesRaw)) {
    return reject('"lanes" must be an array of {tag, text} entries.');
  }
  const lanes: BackfillLaneImpression[] = [];
  const seenTags = new Set<string>();
  for (const entry of lanesRaw as unknown[]) {
    if (typeof entry !== "object" || entry === null) {
      return reject("every lanes entry must be an object of {tag, text}.");
    }
    const laneRecord = entry as Record<string, unknown>;
    const tag = typeof laneRecord.tag === "string" ? laneRecord.tag.trim().replace(/^#/, "") : "";
    if (tag === "") {
      return reject('every lanes entry needs "tag" — the lane word, without the leading "#".');
    }
    if (seenTags.has(tag)) {
      return reject(`lane "#${tag}" appears more than once — one impression per lane.`);
    }
    seenTags.add(tag);
    if (typeof laneRecord.text !== "string" || laneRecord.text.trim() === "") {
      return reject(`lane "#${tag}" needs "text" — the WHOLE initial impression.`);
    }
    lanes.push({ tag, text: laneRecord.text });
  }
  const unresolvedRaw = record.unresolved ?? [];
  if (!Array.isArray(unresolvedRaw)) {
    return reject('"unresolved" must be an array of {claim, reason} entries.');
  }
  const unresolved: BackfillUnresolvedClaim[] = [];
  for (const entry of unresolvedRaw as unknown[]) {
    if (typeof entry !== "object" || entry === null) {
      return reject("every unresolved entry must be an object of {claim, reason}.");
    }
    const unresolvedRecord = entry as Record<string, unknown>;
    if (typeof unresolvedRecord.claim !== "string" || unresolvedRecord.claim.trim() === "") {
      return reject('every unresolved entry needs "claim" — the legacy text you could not place.');
    }
    if (typeof unresolvedRecord.reason !== "string" || unresolvedRecord.reason.trim() === "") {
      return reject('every unresolved entry needs "reason" — why it could not be placed.');
    }
    unresolved.push({
      claim: unresolvedRecord.claim,
      reason: unresolvedRecord.reason,
    });
  }
  return { ok: true, bytes, batch: { lanes, task: record.task, unresolved } };
}

// ---------------------------------------------------------------------------
// The commit
// ---------------------------------------------------------------------------

/**
 * Why a cutover was refused. The kind decides whether a REGENERATION could
 * repair it, which is what the runner's bounded retry spends its budget on.
 */
export type BackfillRefusalKind =
  | "malformed"
  | "snapshot-fence"
  | "roster"
  | "anchor-index"
  | "validator"
  | "unresolved"
  | "lost-row";

/**
 * REGENERATION CAN REPAIR THESE. Everything else is terminal: an identical
 * retry cannot self-heal a deterministic failure, and `unresolved` is by
 * definition waiting on "a human or a better mapping", not on another sample.
 */
const REGENERABLE_REFUSALS = new Set<BackfillRefusalKind>([
  "malformed",
  "snapshot-fence",
  "roster",
  "anchor-index",
  "validator",
]);

export class ImpressionBackfillRefused extends Error {
  constructor(
    readonly kind: BackfillRefusalKind,
    message: string,
    /** What could not be placed — non-empty only for `unresolved`, and the job's operator-visible report. */
    readonly unresolved: readonly BackfillUnresolvedClaim[] = [],
  ) {
    super(message);
  }

  get regenerable(): boolean {
    return REGENERABLE_REFUSALS.has(this.kind);
  }
}

export interface CommitImpressionBackfillInput {
  segmentId: number;
  /** The snapshot the input was assembled at — the fence's other half. */
  snapshot: BackfillSourceSnapshot;
  /** The writer's raw output, unparsed: the parse is part of the refusal discipline. */
  rawBatch: unknown;
  nowEpoch: number;
}

export interface ImpressionBackfillOutcome {
  segmentId: number;
  seededLanes: number;
  /** Serialized bytes of the output batch — the scale gate's output axis. */
  batchBytes: number;
}

/** `origin` written on every row this job seeds (spec "Storage"). */
const BACKFILL_ORIGIN = "backfill" as const;

function refuse(
  kind: BackfillRefusalKind,
  header: string,
  body: readonly string[],
  unresolved: readonly BackfillUnresolvedClaim[] = [],
): never {
  throw new ImpressionBackfillRefused(
    kind,
    [`Cutover refused — ${header}`, ...body.map((line) => `  ${line}`)].join("\n"),
    unresolved,
  );
}

/**
 * THE ATOMIC BATCH (spec "Legacy backfill"): per-lane initial impressions plus
 * the task-tier impression, all `origin=backfill`, committed together with the
 * clearing of the source fields — "never before".
 *
 * RUNS INSIDE THE CALLER'S WRITE TRANSACTION and opens none of its own. Every
 * refusal below throws, so SQLite rolls the whole thing back: half-migrated
 * tasks are impossible, and "the fields stay UNCLEARED" needs no separate
 * branch to be true.
 *
 * The order of the checks is load-bearing in one place only: UNRESOLVED is
 * decided BEFORE the fence, because an unresolved report is not a drift problem
 * and re-reading would not change it — the operator must see what could not be
 * placed, not a message about a snapshot.
 */
export function commitImpressionBackfill(
  db: Database,
  input: CommitImpressionBackfillInput,
): ImpressionBackfillOutcome {
  const parsed = parseBackfillBatch(input.rawBatch);
  if (!parsed.ok) {
    refuse("malformed", `the migration batch is malformed: ${parsed.message}`, []);
  }
  const batch = parsed.batch;

  // 1. UNRESOLVED CONTENT REFUSES CUTOVER (spec, peer round-2 finding 4 — the
  //    residual-note container is DEAD). Content that maps to no lane and is
  //    not task-level does NOT get a new home invented for it: the job reports
  //    it, the source fields stay UNCLEARED, and this task's cutover waits for
  //    a human or a better mapping. Nothing is silently dropped and no third
  //    tier is created to hold it.
  if (batch.unresolved.length > 0) {
    refuse(
      "unresolved",
      `${batch.unresolved.length} legacy claim(s) could not be placed in any lane or at the task ` +
        "tier. This task's cutover is REFUSED: its fields stay as they are until a human or a " +
        "better mapping resolves them.",
      batch.unresolved.map((entry) => `- ${entry.claim}\n      (${entry.reason})`),
      batch.unresolved,
    );
  }

  // 2. THE SOURCE-SNAPSHOT FENCE, over every coordinate at once, before a byte
  //    is written.
  const atCommit = captureBackfillSourceSnapshot(db, input.segmentId);
  if (atCommit === null) {
    refuse("lost-row", `E${input.segmentId} no longer exists.`, []);
  }
  const drift = compareBackfillSourceSnapshots(input.snapshot, atCommit);
  if (drift.length > 0) {
    refuse(
      "snapshot-fence",
      "one or more of this job's source inputs moved while it was generating, so nothing lands " +
        "and the job re-reads and regenerates from scratch.",
      drift,
    );
  }

  // 3. THE ROSTER. A lane named by the batch must be DECLARED on this task —
  //    an impression for a lane that does not exist has no container, and the
  //    fence above has already proven the roster is the one the writer saw.
  const declaredTags = listLanesForSegment(db, input.segmentId).map((lane) => lane.tag);
  const declared = new Set(declaredTags);
  const strangers = batch.lanes
    .map((lane) => lane.tag)
    .filter((tag) => !declared.has(tag));
  if (strangers.length > 0) {
    refuse(
      "roster",
      "the batch names lane(s) this task has not declared.",
      [
        `not declared: ${strangers.map((tag) => `#${tag}`).join(", ")}`,
        `declared: ${declaredTags.length === 0 ? "(none)" : declaredTags.map((tag) => `#${tag}`).join(", ")}`,
      ],
    );
  }

  // 4. ANCHOR RE-SOURCING (spec "Anchor law for migration"). Most legacy field
  //    rows carry no addresses at all, and migrating them anchor-less would
  //    legally mint untraceable current law — so every anchor a seeded
  //    impression carries must be one the MEMBER/ANCHOR INDEX showed the
  //    writer. An address that resolves to some turn SOMEWHERE is not
  //    re-sourcing; it is invention that happens to typecheck.
  const anchorIndex = loadBackfillAnchorIndex(db, input.segmentId, declaredTags);
  const admissible = admissibleAnchorAddresses(anchorIndex);
  const resolveAnchor: ImpressionAnchorResolver = dbImpressionAnchorResolver(db, {
    logger: { warn: () => {} },
  });

  const eraCutoffEpoch = resolveEraCutoffForImpressions(db);
  const validationFailures: string[] = [];
  const outsideIndex: string[] = [];

  const checkOne = (label: string, text: string, cap: number): void => {
    const result = validateImpression({ text, cap, resolveAnchor });
    for (const rejection of result.rejections) {
      validationFailures.push(
        `${label}${rejection.line === null ? "" : ` line ${rejection.line}`}: ${rejection.message} [${rejection.rule}]`,
      );
    }
    for (const anchor of result.anchors) {
      const address = `S${anchor.sessionId}/T${anchor.promptNumber}`;
      if (!admissible.has(address)) {
        outsideIndex.push(
          `${label} line ${anchor.line}: anchor ${address} (written "${anchor.raw}") is not in this ` +
            "task's member/anchor index — a migrated claim may only rest on an address the index showed you",
        );
      }
    }
  };

  for (const lane of batch.lanes) {
    checkOne(
      `#${lane.tag}`,
      lane.text,
      impressionCapForLane(
        settledMemberIdsForLane(db, input.segmentId, lane.tag, eraCutoffEpoch).length,
      ),
    );
  }
  checkOne(`E${input.segmentId}`, batch.task, TASK_IMPRESSION_TOKEN_CAP);

  if (outsideIndex.length > 0) {
    refuse(
      "anchor-index",
      "one or more claims cite an address outside this task's member/anchor index.",
      outsideIndex,
    );
  }
  if (validationFailures.length > 0) {
    refuse(
      "validator",
      "one or more seeded impressions failed the write-time validator.",
      validationFailures,
    );
  }

  // 5. THE CUTOVER, in the spec's own order — and the order IS the statement
  //    order of this block.
  //
  //    (1) SEED the lane impressions. Each CASes on the revision the snapshot
  //        read, so a settlement replacement that landed after the fence
  //        somehow slipped through would still find no row to address.
  const laneRevisionRead = new Map(
    input.snapshot.laneImpressionRevisions.map((entry) => [entry.tag, entry.revision]),
  );
  for (const lane of batch.lanes) {
    const landed = replaceLaneImpression(db, {
      segmentId: input.segmentId,
      tag: lane.tag,
      baseRevision: laneRevisionRead.get(lane.tag) ?? 0,
      text: lane.text,
      origin: BACKFILL_ORIGIN,
    });
    if (!landed) {
      refuse(
        "lost-row",
        `#${lane.tag}: its row moved between this commit's fence and its own write.`,
        [],
      );
    }
  }

  //    (2) SEED the task tier. This write flips `impression_origin` from NULL,
  //        and that flip is what makes the card render the pointer line and the
  //        slimmed form — the pointer therefore PRECEDES the retirement by
  //        construction, not by a caller remembering to order two calls.
  const taskLanded = replaceSegmentTaskImpression(db, {
    segmentId: input.segmentId,
    baseRevision: input.snapshot.taskImpressionRevision,
    text: batch.task,
    origin: BACKFILL_ORIGIN,
    nowEpoch: input.nowEpoch,
  });
  if (!taskLanded) {
    refuse(
      "lost-row",
      `E${input.segmentId}: the task-tier row moved between this commit's fence and its own write.`,
      [],
    );
  }

  //    (3) RETIRE the source fields. Last, and only here.
  if (retireSegmentImpressionSourceFields(db, input.segmentId, input.nowEpoch) === null) {
    refuse("lost-row", `E${input.segmentId} vanished mid-cutover.`, []);
  }

  return {
    segmentId: input.segmentId,
    seededLanes: batch.lanes.length,
    batchBytes: parsed.bytes,
  };
}

// "HAS THIS TASK CUT OVER?" IS DELIBERATELY NOT A FUNCTION HERE. It is already
// answered, once, by `readTaskImpressionSlot` (mcp/impression-display.ts) —
// ticket 04's own reader of `impression_origin` — and the card asks it there.
// A second predicate in this module would be a second answer to the same
// question, free to drift from the one the display actually uses.
