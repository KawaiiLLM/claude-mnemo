import type { Database } from "bun:sqlite";

export type MemoryStatus = "active" | "superseded" | "archived";

export interface MemoryRecord {
  id: number;
  type: string;
  scope: string;
  title: string;
  content: string;
  reasoning: string | null;
  application: string | null;
  tags: string[];
  status: MemoryStatus;
  supersededBy: number | null;
  expiresAtEpoch: number | null;
  sourceTurnId: number | null;
  createdAtEpoch: number;
  updatedAtEpoch: number | null;
}

interface MemoryRow {
  id: number;
  type: string;
  scope: string;
  title: string;
  content: string;
  reasoning: string | null;
  application: string | null;
  tags: string | null;
  status: MemoryStatus;
  supersededBy: number | null;
  expiresAtEpoch: number | null;
  sourceTurnId: number | null;
  createdAtEpoch: number;
  updatedAtEpoch: number | null;
}

export interface CreateMemoryInput {
  type: string;
  scope: string;
  title: string;
  content: string;
  reasoning?: string | null;
  application?: string | null;
  tags?: string[];
  status?: MemoryStatus;
  supersededBy?: number | null;
  expiresAtEpoch?: number | null;
  sourceTurnId?: number | null;
  createdAtEpoch: number;
  updatedAtEpoch: number | null;
}

export interface UpdateMemoryInput {
  type?: string;
  scope?: string;
  title?: string;
  content?: string;
  reasoning?: string | null;
  application?: string | null;
  tags?: string[];
  status?: MemoryStatus;
  supersededBy?: number | null;
  expiresAtEpoch?: number | null;
  sourceTurnId?: number | null;
  updatedAtEpoch?: number | null;
}

export interface ListMemoriesOptions {
  scope?: string;
  type?: string;
  status?: MemoryStatus;
  limit?: number;
}

const MEMORY_SELECT = `
  SELECT
    id,
    type,
    scope,
    title,
    content,
    reasoning,
    application,
    tags,
    status,
    superseded_by AS supersededBy,
    expires_at_epoch AS expiresAtEpoch,
    source_turn_id AS sourceTurnId,
    created_at_epoch AS createdAtEpoch,
    updated_at_epoch AS updatedAtEpoch
  FROM memories
`;

function parseJsonArray(value: string | null): string[] {
  if (!value) {
    return [];
  }

  return JSON.parse(value) as string[];
}

function stringifyJsonArray(values: string[]): string {
  return JSON.stringify(values);
}

function hasOwn<T extends object, K extends PropertyKey>(
  value: T,
  key: K,
): value is T & Record<K, unknown> {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function mapMemoryRow(row: MemoryRow | null): MemoryRecord | null {
  if (!row) {
    return null;
  }

  return {
    ...row,
    tags: parseJsonArray(row.tags),
  };
}

export function getMemory(db: Database, id: number): MemoryRecord | null {
  return mapMemoryRow(
    db.query<MemoryRow, [number]>(`${MEMORY_SELECT} WHERE id = ?`).get(id) ?? null,
  );
}

export function listMemories(
  db: Database,
  options: ListMemoriesOptions = {},
): MemoryRecord[] {
  const clauses: string[] = [];
  const params: Array<string | number> = [];

  if (options.scope) {
    clauses.push("scope = ?");
    params.push(options.scope);
  }

  if (options.type) {
    clauses.push("type = ?");
    params.push(options.type);
  }

  if (options.status) {
    clauses.push("status = ?");
    params.push(options.status);
  }

  const whereClause = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
  const boundParams = [...params, options.limit ?? 50];

  return db
    .query<MemoryRow, Array<string | number>>(
      `${MEMORY_SELECT}${whereClause} ORDER BY COALESCE(updated_at_epoch, created_at_epoch) DESC, id DESC LIMIT ?`,
    )
    .all(...boundParams)
    .map((row) => mapMemoryRow(row))
    .filter((record): record is MemoryRecord => record !== null);
}

export function createMemory(
  db: Database,
  input: CreateMemoryInput,
): MemoryRecord {
  const created = mapMemoryRow(
    db
      .query<
        MemoryRow,
        [
          string,
          string,
          string,
          string,
          string | null,
          string | null,
          string,
          MemoryStatus,
          number | null,
          number | null,
          number | null,
          number,
          number | null,
        ]
      >(
        `
          INSERT INTO memories (
            type,
            scope,
            title,
            content,
            reasoning,
            application,
            tags,
            status,
            superseded_by,
            expires_at_epoch,
            source_turn_id,
            created_at_epoch,
            updated_at_epoch
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          RETURNING
            id,
            type,
            scope,
            title,
            content,
            reasoning,
            application,
            tags,
            status,
            superseded_by AS supersededBy,
            expires_at_epoch AS expiresAtEpoch,
            source_turn_id AS sourceTurnId,
            created_at_epoch AS createdAtEpoch,
            updated_at_epoch AS updatedAtEpoch
        `,
      )
      .get(
        input.type,
        input.scope,
        input.title,
        input.content,
        input.reasoning ?? null,
        input.application ?? null,
        stringifyJsonArray(input.tags ?? []),
        input.status ?? "active",
        input.supersededBy ?? null,
        input.expiresAtEpoch ?? null,
        input.sourceTurnId ?? null,
        input.createdAtEpoch,
        input.updatedAtEpoch,
      ),
  );

  if (!created) {
    throw new Error("Failed to create memory.");
  }

  return created;
}

export function updateMemory(
  db: Database,
  id: number,
  input: UpdateMemoryInput,
): MemoryRecord | null {
  db.exec("BEGIN IMMEDIATE");

  try {
    const existing = getMemory(db, id);

    if (!existing) {
      db.exec("ROLLBACK");
      return null;
    }

    const updated = mapMemoryRow(
      db
        .query<
          MemoryRow,
          [
            string,
            string,
            string,
            string,
            string | null,
            string | null,
            string,
            MemoryStatus,
            number | null,
            number | null,
            number | null,
            number | null,
            number,
          ]
        >(
          `
            UPDATE memories
            SET
              type = ?,
              scope = ?,
              title = ?,
              content = ?,
              reasoning = ?,
              application = ?,
              tags = ?,
              status = ?,
              superseded_by = ?,
              expires_at_epoch = ?,
              source_turn_id = ?,
              updated_at_epoch = ?
            WHERE id = ?
            RETURNING
              id,
              type,
              scope,
              title,
              content,
              reasoning,
              application,
              tags,
              status,
              superseded_by AS supersededBy,
              expires_at_epoch AS expiresAtEpoch,
              source_turn_id AS sourceTurnId,
              created_at_epoch AS createdAtEpoch,
              updated_at_epoch AS updatedAtEpoch
          `,
        )
        .get(
          input.type ?? existing.type,
          input.scope ?? existing.scope,
          input.title ?? existing.title,
          input.content ?? existing.content,
          hasOwn(input, "reasoning")
            ? (input.reasoning ?? null)
            : existing.reasoning,
          hasOwn(input, "application")
            ? (input.application ?? null)
            : existing.application,
          stringifyJsonArray(input.tags ?? existing.tags),
          input.status ?? existing.status,
          hasOwn(input, "supersededBy")
            ? (input.supersededBy ?? null)
            : existing.supersededBy,
          hasOwn(input, "expiresAtEpoch")
            ? (input.expiresAtEpoch ?? null)
            : existing.expiresAtEpoch,
          hasOwn(input, "sourceTurnId")
            ? (input.sourceTurnId ?? null)
            : existing.sourceTurnId,
          input.updatedAtEpoch ?? Math.floor(Date.now() / 1000),
          id,
        ),
    );

    if (!updated) {
      throw new Error("Failed to update memory.");
    }

    db.exec("COMMIT");
    return updated;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function archiveMemory(
  db: Database,
  id: number,
  options: Pick<UpdateMemoryInput, "updatedAtEpoch"> = {},
): MemoryRecord | null {
  return updateMemory(db, id, {
    status: "archived",
    updatedAtEpoch: options.updatedAtEpoch,
  });
}
