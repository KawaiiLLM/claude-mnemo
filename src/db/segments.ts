import type { Database } from "bun:sqlite";

import { indexSegmentToFTS } from "./search";
import { normalizeTypeValues, type MemoryType } from "../shared/type-vocabulary";

/**
 * Segments and the topic registry (spec D6).
 *
 * A segment is one coherent chapter of work on one topic — the unit that would
 * earn a line in the day's diary. It carries a turn's field shape (title,
 * content, multi-value type, tags, status) so the read surfaces do not need a
 * second vocabulary for the higher level, plus a `revision` that makes
 * concurrent rewrites of an OPEN segment safe (see `applySegmentWrites`).
 *
 * Everything here is storage mechanics. Which turns belong to which segment,
 * when a segment closes, and what its body says are settlement decisions; this
 * module only refuses writes that would corrupt the structure.
 */

export const SEGMENT_STATUSES = ["open", "delivered", "abandoned"] as const;
export type SegmentStatus = (typeof SEGMENT_STATUSES)[number];

export const TOPIC_STATUSES = ["active", "dormant", "retired"] as const;
export type TopicStatus = (typeof TOPIC_STATUSES)[number];

export interface TopicRecord {
  id: number;
  name: string;
  aliases: string[];
  status: TopicStatus;
  createdAtEpoch: number;
  updatedAtEpoch: number;
}

export interface SegmentRecord {
  id: number;
  topicId: number | null;
  title: string;
  content: string | null;
  type: MemoryType[];
  tags: string[];
  status: SegmentStatus;
  revision: number;
  createdAtEpoch: number;
  updatedAtEpoch: number;
}

interface TopicRow {
  id: number;
  name: string;
  aliases: string;
  status: TopicStatus;
  createdAtEpoch: number;
  updatedAtEpoch: number;
}

interface SegmentRow {
  id: number;
  topicId: number | null;
  title: string;
  content: string | null;
  type: string;
  tags: string;
  status: SegmentStatus;
  revision: number;
  createdAtEpoch: number;
  updatedAtEpoch: number;
}

const TOPIC_COLUMNS = `
  id,
  name,
  aliases,
  status,
  created_at_epoch AS createdAtEpoch,
  updated_at_epoch AS updatedAtEpoch
`;

const SEGMENT_COLUMNS = `
  id,
  topic_id AS topicId,
  title,
  content,
  type,
  tags,
  status,
  revision,
  created_at_epoch AS createdAtEpoch,
  updated_at_epoch AS updatedAtEpoch
`;

function parseStringArray(value: string | null): string[] {
  if (!value) {
    return [];
  }
  const parsed = JSON.parse(value) as unknown;
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
}

function mapTopicRow(row: TopicRow | null): TopicRecord | null {
  return row ? { ...row, aliases: parseStringArray(row.aliases) } : null;
}

function mapSegmentRow(row: SegmentRow | null): SegmentRecord | null {
  return row
    ? {
        ...row,
        type: parseStringArray(row.type) as MemoryType[],
        tags: parseStringArray(row.tags),
      }
    : null;
}

/** Alias lookup is case- and width-insensitive; the stored spelling is kept. */
function normalizeTopicKey(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

export interface UpsertTopicInput {
  name: string;
  aliases?: string[];
  status?: TopicStatus;
  nowEpoch: number;
}

/**
 * Register a topic, or fold a new spelling into the one that already owns this
 * name (spec D6/D9's anti-fragmentation rule: search before minting). Returns
 * the surviving topic either way, so a caller never has to branch on whether it
 * won the race.
 */
export function upsertTopic(db: Database, input: UpsertTopicInput): TopicRecord {
  const existing = findTopic(db, input.name);
  if (existing) {
    const merged = [...existing.aliases];
    for (const alias of input.aliases ?? []) {
      if (
        normalizeTopicKey(alias) !== normalizeTopicKey(existing.name) &&
        !merged.some((known) => normalizeTopicKey(known) === normalizeTopicKey(alias))
      ) {
        merged.push(alias);
      }
    }
    // The name a caller arrives with becomes an alias when the match came
    // through an existing alias — otherwise the spelling would be lost.
    if (
      normalizeTopicKey(input.name) !== normalizeTopicKey(existing.name) &&
      !merged.some((known) => normalizeTopicKey(known) === normalizeTopicKey(input.name))
    ) {
      merged.push(input.name);
    }

    const updated = mapTopicRow(
      db
        .query<TopicRow, [string, TopicStatus, number, number]>(
          `UPDATE topics SET aliases = ?, status = ?, updated_at_epoch = ?
           WHERE id = ? RETURNING ${TOPIC_COLUMNS}`,
        )
        .get(
          JSON.stringify(merged),
          input.status ?? existing.status,
          input.nowEpoch,
          existing.id,
        ) ?? null,
    );
    if (!updated) {
      throw new Error(`Failed to update topic ${existing.id}.`);
    }
    return updated;
  }

  const inserted = mapTopicRow(
    db
      .query<TopicRow, [string, string, TopicStatus, number, number]>(
        `INSERT INTO topics (name, aliases, status, created_at_epoch, updated_at_epoch)
         VALUES (?, ?, ?, ?, ?)
         RETURNING ${TOPIC_COLUMNS}`,
      )
      .get(
        input.name,
        JSON.stringify(input.aliases ?? []),
        input.status ?? "active",
        input.nowEpoch,
        input.nowEpoch,
      ) ?? null,
  );

  if (!inserted) {
    throw new Error(`Failed to register topic ${input.name}.`);
  }
  return inserted;
}

/** Resolve a name through the registry: exact name first, then aliases. */
export function findTopic(db: Database, name: string): TopicRecord | null {
  const key = normalizeTopicKey(name);
  const rows = db.query<TopicRow, []>(`SELECT ${TOPIC_COLUMNS} FROM topics`).all();

  const byName = rows.find((row) => normalizeTopicKey(row.name) === key);
  if (byName) {
    return mapTopicRow(byName);
  }

  const byAlias = rows.find((row) =>
    parseStringArray(row.aliases).some((alias) => normalizeTopicKey(alias) === key),
  );
  return mapTopicRow(byAlias ?? null);
}

export function getTopic(db: Database, topicId: number): TopicRecord | null {
  return mapTopicRow(
    db
      .query<TopicRow, [number]>(`SELECT ${TOPIC_COLUMNS} FROM topics WHERE id = ?`)
      .get(topicId) ?? null,
  );
}

export function listTopics(db: Database, status?: TopicStatus): TopicRecord[] {
  const rows = status
    ? db
        .query<TopicRow, [TopicStatus]>(
          `SELECT ${TOPIC_COLUMNS} FROM topics WHERE status = ? ORDER BY id ASC`,
        )
        .all(status)
    : db
        .query<TopicRow, []>(`SELECT ${TOPIC_COLUMNS} FROM topics ORDER BY id ASC`)
        .all();

  return rows
    .map((row) => mapTopicRow(row))
    .filter((topic): topic is TopicRecord => topic !== null);
}

export interface CreateSegmentInput {
  title: string;
  topicId?: number | null;
  content?: string | null;
  /** Omitted → `[]` (ticket 02: no mechanical title-prefix draft any more). */
  type?: string[];
  tags?: string[];
  status?: SegmentStatus;
  nowEpoch: number;
}

export function createSegment(
  db: Database,
  input: CreateSegmentInput,
): SegmentRecord {
  const type = normalizeTypeValues(input.type ?? []);

  const inserted = mapSegmentRow(
    db
      .query<
        SegmentRow,
        [number | null, string, string | null, string, string, SegmentStatus, number, number]
      >(
        `INSERT INTO segments (
           topic_id, title, content, type, tags, status,
           created_at_epoch, updated_at_epoch
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING ${SEGMENT_COLUMNS}`,
      )
      .get(
        input.topicId ?? null,
        input.title,
        input.content ?? null,
        JSON.stringify(type),
        JSON.stringify(input.tags ?? []),
        input.status ?? "open",
        input.nowEpoch,
        input.nowEpoch,
      ) ?? null,
  );

  if (!inserted) {
    throw new Error("Failed to create segment.");
  }
  indexSegment(db, inserted);
  return inserted;
}

/** Keep the segment's search row in step with the row it was written from. */
function indexSegment(db: Database, segment: SegmentRecord): void {
  indexSegmentToFTS(db, {
    id: segment.id,
    title: segment.title,
    content: segment.content,
    type: JSON.stringify(segment.type),
    tags: JSON.stringify(segment.tags),
  });
}

export function getSegment(db: Database, segmentId: number): SegmentRecord | null {
  return mapSegmentRow(
    db
      .query<SegmentRow, [number]>(
        `SELECT ${SEGMENT_COLUMNS} FROM segments WHERE id = ?`,
      )
      .get(segmentId) ?? null,
  );
}

export function listOpenSegments(db: Database): SegmentRecord[] {
  return db
    .query<SegmentRow, []>(
      `SELECT ${SEGMENT_COLUMNS} FROM segments WHERE status = 'open'
       ORDER BY updated_at_epoch DESC, id DESC`,
    )
    .all()
    .map((row) => mapSegmentRow(row))
    .filter((segment): segment is SegmentRecord => segment !== null);
}

/** Idempotent membership assertion; returns the turn ids newly linked. */
export function addSegmentMembers(
  db: Database,
  segmentId: number,
  turnIds: readonly number[],
  nowEpoch: number,
): number[] {
  const statement = db.query<{ turnId: number }, [number, number, number]>(
    `INSERT INTO segment_members (segment_id, turn_id, created_at_epoch)
     VALUES (?, ?, ?)
     ON CONFLICT (segment_id, turn_id) DO NOTHING
     RETURNING turn_id AS turnId`,
  );

  const added: number[] = [];
  for (const turnId of turnIds) {
    const row = statement.get(segmentId, turnId, nowEpoch);
    if (row) {
      added.push(row.turnId);
    }
  }
  return added;
}

export function getSegmentMemberTurnIds(
  db: Database,
  segmentId: number,
): number[] {
  return db
    .query<{ turnId: number }, [number]>(
      `SELECT sm.turn_id AS turnId
       FROM segment_members sm
       JOIN turns t ON t.id = sm.turn_id
       WHERE sm.segment_id = ?
       ORDER BY t.created_at_epoch ASC, t.id ASC`,
    )
    .all(segmentId)
    .map((row) => row.turnId);
}

export function getSegmentsForTurn(db: Database, turnId: number): SegmentRecord[] {
  return db
    .query<SegmentRow, [number]>(
      `SELECT
         s.id,
         s.topic_id AS topicId,
         s.title,
         s.content,
         s.type,
         s.tags,
         s.status,
         s.revision,
         s.created_at_epoch AS createdAtEpoch,
         s.updated_at_epoch AS updatedAtEpoch
       FROM segments s
       JOIN segment_members sm ON sm.segment_id = s.id
       WHERE sm.turn_id = ?
       ORDER BY s.id ASC`,
    )
    .all(turnId)
    .map((row) => mapSegmentRow(row))
    .filter((segment): segment is SegmentRecord => segment !== null);
}

export interface SegmentWrite {
  segmentId: number;
  /** The revision the caller read before composing this body. */
  expectedRevision: number;
  title?: string;
  content?: string | null;
  type?: string[];
  tags?: string[];
  status?: SegmentStatus;
}

export type SegmentWriteRejection =
  | "missing"
  | "revision-conflict"
  | "frozen"
  | "invalid-type";

export interface ExcludedSegmentWrite {
  write: SegmentWrite;
  reason: SegmentWriteRejection;
  /** The row as it stands now — what the caller replays its judgement against. */
  latest: SegmentRecord | null;
  detail?: string;
}

export interface ApplySegmentWritesResult {
  applied: SegmentRecord[];
  excluded: ExcludedSegmentWrite[];
}

export interface ApplySegmentWritesOptions {
  nowEpoch: number;
}

const SEGMENT_WRITE_SAVEPOINT = "mnemo_segment_writes";

/**
 * Compare-and-set writes over open segments (spec D9, 裁决 14).
 *
 * Concurrent settlements partition cleanly by session EXCEPT for open segments,
 * which any of them may rewrite. Rather than serialize every settlement behind
 * a global lock, each write declares the revision it was composed against: a
 * write whose revision moved on is EXCLUDED from this transaction and handed
 * back with the segment as it stands now, so the caller replays the judgement
 * for that one segment in a follow-up write. Everything else in the batch —
 * including the caller's other partition writes, which never enter this
 * savepoint's rollback path — commits.
 *
 * A frozen (delivered/abandoned) segment refuses writes outright: spec D6
 * overturns a closed segment with an edge, never by rewriting history.
 */
export function applySegmentWrites(
  db: Database,
  writes: readonly SegmentWrite[],
  options: ApplySegmentWritesOptions,
): ApplySegmentWritesResult {
  const applied: SegmentRecord[] = [];
  const excluded: ExcludedSegmentWrite[] = [];

  db.exec(`SAVEPOINT ${SEGMENT_WRITE_SAVEPOINT}`);
  try {
    for (const write of writes) {
      const current = getSegment(db, write.segmentId);
      if (!current) {
        excluded.push({ write, reason: "missing", latest: null });
        continue;
      }
      if (current.status !== "open") {
        excluded.push({ write, reason: "frozen", latest: current });
        continue;
      }

      let type: MemoryType[];
      try {
        type = write.type ? normalizeTypeValues(write.type) : current.type;
      } catch (error) {
        excluded.push({
          write,
          reason: "invalid-type",
          latest: current,
          detail: error instanceof Error ? error.message : String(error),
        });
        continue;
      }

      const updated = mapSegmentRow(
        db
          .query<
            SegmentRow,
            [
              string,
              string | null,
              string,
              string,
              SegmentStatus,
              number,
              number,
              number,
            ]
          >(
            `UPDATE segments
               SET title = ?,
                   content = ?,
                   type = ?,
                   tags = ?,
                   status = ?,
                   revision = revision + 1,
                   updated_at_epoch = ?
             WHERE id = ? AND revision = ?
             RETURNING ${SEGMENT_COLUMNS}`,
          )
          .get(
            write.title ?? current.title,
            write.content === undefined ? current.content : write.content,
            JSON.stringify(type),
            JSON.stringify(write.tags ?? current.tags),
            write.status ?? current.status,
            options.nowEpoch,
            write.segmentId,
            write.expectedRevision,
          ) ?? null,
      );

      if (!updated) {
        excluded.push({ write, reason: "revision-conflict", latest: current });
        continue;
      }

      indexSegment(db, updated);
      applied.push(updated);
    }
  } catch (error) {
    db.exec(`ROLLBACK TO ${SEGMENT_WRITE_SAVEPOINT}`);
    db.exec(`RELEASE ${SEGMENT_WRITE_SAVEPOINT}`);
    throw error;
  }
  db.exec(`RELEASE ${SEGMENT_WRITE_SAVEPOINT}`);

  return { applied, excluded };
}
