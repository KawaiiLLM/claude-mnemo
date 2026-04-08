import type { Database } from "bun:sqlite";

import { indexObservationToFTS } from "./search";

export interface ObservationRecord {
  id: number;
  turnId: number;
  type: string;
  title: string;
  content: string | null;
  description: string | null;
  insight: string | null;
  narrative: string | null;
  facts: string[];
  tags: string[];
  concepts: string[];
  filesRead: string[];
  filesModified: string[];
  createdAtEpoch: number;
}

export interface CreateObservationInput {
  turnId: number;
  type: string;
  title: string;
  content?: string | null;
  description?: string | null;
  insight?: string | null;
  narrative?: string | null;
  facts?: string[];
  tags?: string[];
  concepts?: string[];
  filesRead?: string[];
  filesModified?: string[];
  createdAtEpoch: number;
}

interface ObservationRow {
  id: number;
  turnId: number;
  type: string;
  title: string;
  content: string | null;
  description: string | null;
  insight: string | null;
  narrative: string | null;
  facts: string | null;
  tags: string | null;
  concepts: string | null;
  filesRead: string | null;
  filesModified: string | null;
  createdAtEpoch: number;
}

const OBSERVATION_SELECT = `
  SELECT
    id,
    turn_id AS turnId,
    type,
    title,
    COALESCE(content, description) AS content,
    COALESCE(content, description) AS description,
    insight,
    narrative,
    facts,
    COALESCE(tags, concepts) AS tags,
    concepts,
    files_read AS filesRead,
    files_modified AS filesModified,
    created_at_epoch AS createdAtEpoch
  FROM observations
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

function combineLegacyInsight(
  narrative: string | null,
  facts: string[],
): string | null {
  if (narrative && facts.length > 0) {
    return [narrative, ...facts].join("\n");
  }

  return narrative ?? (facts.length > 0 ? facts.join("\n") : null);
}

function mapObservationRow(row: ObservationRow | null): ObservationRecord | null {
  if (!row) {
    return null;
  }

  const facts = parseJsonArray(row.facts);
  const tags = parseJsonArray(row.tags);
  const concepts = parseJsonArray(row.concepts);
  const resolvedTags = tags.length > 0 ? tags : concepts;
  const resolvedInsight = row.insight ?? combineLegacyInsight(row.narrative, facts);

  return {
    ...row,
    description: row.description ?? row.content,
    insight: resolvedInsight,
    narrative: row.narrative ?? resolvedInsight,
    facts,
    tags: resolvedTags,
    concepts: concepts.length > 0 ? concepts : resolvedTags,
    filesRead: parseJsonArray(row.filesRead),
    filesModified: parseJsonArray(row.filesModified),
  };
}

export function createObservation(
  db: Database,
  input: CreateObservationInput,
): ObservationRecord {
  const content = input.content ?? input.description ?? null;
  const facts = input.facts ?? [];
  const tags = input.tags ?? input.concepts ?? [];
  const insight = input.insight ?? combineLegacyInsight(input.narrative ?? null, facts);
  const narrative = input.narrative ?? insight;
  const concepts = input.concepts ?? tags;
  const inserted = db
    .query<
      ObservationRow,
      [
        number,
        string,
        string,
        string | null,
        string | null,
        string | null,
        string | null,
        string,
        string,
        string,
        string,
        string,
        number,
      ]
    >(
      `
        INSERT INTO observations (
          turn_id,
          type,
          title,
          content,
          description,
          insight,
          narrative,
          facts,
          tags,
          concepts,
          files_read,
          files_modified,
          created_at_epoch
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        RETURNING
          id,
          turn_id AS turnId,
          type,
          title,
          COALESCE(content, description) AS content,
          COALESCE(content, description) AS description,
          insight,
          narrative,
          facts,
          COALESCE(tags, concepts) AS tags,
          concepts,
          files_read AS filesRead,
          files_modified AS filesModified,
          created_at_epoch AS createdAtEpoch
      `,
    )
    .get(
      input.turnId,
      input.type,
      input.title,
      content,
      content,
      insight,
      narrative,
      stringifyJsonArray(facts),
      stringifyJsonArray(tags),
      stringifyJsonArray(concepts),
      stringifyJsonArray(input.filesRead ?? []),
      stringifyJsonArray(input.filesModified ?? []),
      input.createdAtEpoch,
    );

  const observation = mapObservationRow(inserted);

  if (!observation) {
    throw new Error("Failed to create observation.");
  }

  indexObservationToFTS(db, observation);

  return observation;
}

export function getObservationsForTurn(
  db: Database,
  turnId: number,
): ObservationRecord[] {
  return db
    .query<ObservationRow, [number]>(
      `${OBSERVATION_SELECT} WHERE turn_id = ? ORDER BY id ASC`,
    )
    .all(turnId)
    .map((row) => mapObservationRow(row))
    .filter((observation): observation is ObservationRecord => observation !== null);
}

export function getObservation(
  db: Database,
  observationId: number,
): ObservationRecord | null {
  return mapObservationRow(
    db
      .query<ObservationRow, [number]>(`${OBSERVATION_SELECT} WHERE id = ?`)
      .get(observationId) ?? null,
  );
}
