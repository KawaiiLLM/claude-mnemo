import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import type { Database } from "bun:sqlite";

import { runWriteTransaction } from "../db/database";
import {
  recoverDeadHitSidecarLock,
  summarizeToolInput,
  withHitSidecarLock,
} from "./sidecar-protocol";

const SUMMARY_LIMIT = 200;
const ACTIVE_SIDECAR = /^hits-\d{4}-\d{2}-\d{2}\.jsonl$/u;
const ROTATED_SIDECAR =
  /^hits-\d{4}-\d{2}-\d{2}\.[a-zA-Z0-9_-]+\.rotated\.jsonl$/u;

interface SidecarHitBase {
  hit_id: string;
  content_session_id: string;
  event_type: string;
  ts_ms: number;
  rule_id: number;
}

export interface ToolSidecarHit extends SidecarHitBase {
  tool_name: string;
  tool_input_summary: string;
  tool_use_id?: string;
}

export interface PromptSidecarHit extends SidecarHitBase {
  event_type: "UserPromptSubmit";
  prompt_summary: string;
}

export type SidecarHit = ToolSidecarHit | PromptSidecarHit;

export interface RotateHitSidecarsOptions {
  rotationId?: () => string;
}

export interface IngestHitSidecarsOptions extends RotateHitSidecarsOptions {
  rotateActive?: boolean;
  nowMs?: () => number;
  beforeInsert?: (hit: SidecarHit, index: number) => void;
  afterCommit?: () => void;
  afterCheckpoint?: () => void;
}

export interface HitIngestResult {
  rotatedFiles: string[];
  inserted: number;
  duplicate: number;
  resolved: number;
  unresolved: number;
  checkpointPath: string | null;
}

interface SessionRow {
  id: number;
}

interface ToolCandidateRow {
  observationId: number;
  promptNumber: number;
  toolInput: string | null;
  createdAtEpoch: number;
}

interface PromptCandidateRow {
  turnId: number;
  promptNumber: number;
  userPrompt: string | null;
  createdAtEpoch: number;
}

function rulesDirectory(dataRoot: string): string {
  return join(dataRoot, "rules");
}

export function resolveHitIngestCheckpointPath(dataRoot: string): string {
  return join(rulesDirectory(dataRoot), "hit-ingest-checkpoint.json");
}

function isErrorCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as Error & { code?: string }).code === code
  );
}

function listSidecars(dataRoot: string, pattern: RegExp): string[] {
  const directory = rulesDirectory(dataRoot);
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return [];
    throw error;
  }
  return names
    .filter((name) => pattern.test(name))
    .sort()
    .map((name) => join(directory, name));
}

export function rotateHitSidecars(
  dataRoot: string,
  options: RotateHitSidecarsOptions = {},
): string[] {
  return withHitSidecarLock(dataRoot, () => {
    const rotationId = options.rotationId ?? randomUUID;
    const rotated: string[] = [];
    for (const activePath of listSidecars(dataRoot, ACTIVE_SIDECAR)) {
      const suffix = ".jsonl";
      const rotatedPath = `${activePath.slice(0, -suffix.length)}.${rotationId()}.rotated${suffix}`;
      try {
        renameSync(activePath, rotatedPath);
        rotated.push(rotatedPath);
      } catch (error) {
        // A concurrent ingester may have atomically won the same rotation.
        if (!isErrorCode(error, "ENOENT")) throw error;
      }
    }
    return rotated;
  });
}

function takePrefix(value: string): string {
  return Array.from(value).slice(0, SUMMARY_LIMIT).join("");
}

function summarizeStoredToolInput(toolInput: string | null): string | null {
  return summarizeToolInput(toolInput ?? undefined);
}

function timestampDistance(createdAtEpoch: number, tsMs: number): number {
  return Math.abs(createdAtEpoch - Math.floor(tsMs / 1_000));
}

function pickClosest<T extends { createdAtEpoch: number }>(
  candidates: T[],
  tsMs: number,
  id: (candidate: T) => number,
): T | undefined {
  return candidates.sort((left, right) => {
    const distance =
      timestampDistance(left.createdAtEpoch, tsMs) -
      timestampDistance(right.createdAtEpoch, tsMs);
    return distance || id(left) - id(right);
  })[0];
}

function isPromptHit(hit: SidecarHit): hit is PromptSidecarHit {
  return hit.event_type === "UserPromptSubmit" && "prompt_summary" in hit;
}

export function resolveHitTurn(db: Database, hit: SidecarHit): string | null {
  const session = db
    .query<SessionRow, [string]>(
      "SELECT id FROM sessions WHERE content_session_id = ?",
    )
    .get(hit.content_session_id);
  if (!session) return null;

  if (isPromptHit(hit)) {
    const candidates = db
      .query<PromptCandidateRow, [number]>(
        `SELECT id AS turnId, prompt_number AS promptNumber,
                user_prompt AS userPrompt, created_at_epoch AS createdAtEpoch
         FROM turns
         WHERE session_id = ? AND user_prompt IS NOT NULL`,
      )
      .all(session.id)
      .filter(
        (candidate) =>
          takePrefix(candidate.userPrompt ?? "") === hit.prompt_summary,
      );
    const match = pickClosest(candidates, hit.ts_ms, ({ turnId }) => turnId);
    return match ? `S${session.id}/T${match.promptNumber}` : null;
  }

  const candidates = db
    .query<ToolCandidateRow, [number, string]>(
      `SELECT o.id AS observationId, t.prompt_number AS promptNumber,
              o.tool_input AS toolInput, o.created_at_epoch AS createdAtEpoch
       FROM observations o
       JOIN turns t ON t.id = o.turn_id
       WHERE t.session_id = ? AND o.tool_name = ?`,
    )
    .all(session.id, hit.tool_name)
    .filter(
      (candidate) =>
        summarizeStoredToolInput(candidate.toolInput) === hit.tool_input_summary,
    );
  const match = pickClosest(
    candidates,
    hit.ts_ms,
    ({ observationId }) => observationId,
  );
  return match ? `S${session.id}/T${match.promptNumber}` : null;
}

function requiredString(
  value: Record<string, unknown>,
  field: string,
): string {
  const result = value[field];
  if (typeof result !== "string" || result.length === 0) {
    throw new Error(`invalid sidecar hit: ${field} must be a non-empty string`);
  }
  return result;
}

function parseHit(value: unknown): SidecarHit {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid sidecar hit: expected an object");
  }
  const row = value as Record<string, unknown>;
  const base: SidecarHitBase = {
    hit_id: requiredString(row, "hit_id"),
    content_session_id: requiredString(row, "content_session_id"),
    event_type: requiredString(row, "event_type"),
    ts_ms: Number(row.ts_ms),
    rule_id: Number(row.rule_id),
  };
  if (!Number.isInteger(base.ts_ms) || base.ts_ms < 0) {
    throw new Error("invalid sidecar hit: ts_ms must be a non-negative integer");
  }
  if (!Number.isInteger(base.rule_id) || base.rule_id <= 0) {
    throw new Error("invalid sidecar hit: rule_id must be a positive integer");
  }

  if (base.event_type === "UserPromptSubmit") {
    return { ...base, event_type: "UserPromptSubmit", prompt_summary: requiredString(row, "prompt_summary") };
  }
  const toolUseId = row.tool_use_id;
  if (toolUseId !== undefined && typeof toolUseId !== "string") {
    throw new Error("invalid sidecar hit: tool_use_id must be a string");
  }
  return {
    ...base,
    tool_name: requiredString(row, "tool_name"),
    tool_input_summary: requiredString(row, "tool_input_summary"),
    ...(toolUseId ? { tool_use_id: toolUseId } : {}),
  };
}

function readHits(paths: string[]): SidecarHit[] {
  const hits: SidecarHit[] = [];
  for (const path of paths) {
    const content = readFileSync(path, "utf8");
    const lines = content.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!.trim();
      if (line === "") continue;
      try {
        hits.push(parseHit(JSON.parse(line)));
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`${basename(path)}:${index + 1}: ${reason}`);
      }
    }
  }
  return hits;
}

function writeCheckpoint(
  dataRoot: string,
  rotatedPaths: string[],
  committedAtEpoch: number,
): string {
  const path = resolveHitIngestCheckpointPath(dataRoot);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(
    temporary,
    `${JSON.stringify({
      version: 1,
      rotated_files: rotatedPaths.map((rotatedPath) => basename(rotatedPath)),
      committed_at_epoch: committedAtEpoch,
    })}\n`,
    { mode: 0o600 },
  );
  renameSync(temporary, path);
  return path;
}

export function ingestHitSidecars(
  db: Database,
  dataRoot: string,
  options: IngestHitSidecarsOptions = {},
): HitIngestResult {
  const transactionResult = runWriteTransaction(db, () => {
    recoverDeadHitSidecarLock(dataRoot);
    const newlyRotated =
      options.rotateActive === false ? [] : rotateHitSidecars(dataRoot, options);
    const rotatedFiles = Array.from(
      new Set([...listSidecars(dataRoot, ROTATED_SIDECAR), ...newlyRotated]),
    ).sort();
    const hits = readHits(rotatedFiles);
    let inserted = 0;
    let duplicate = 0;
    let resolved = 0;
    let unresolved = 0;
    hits.forEach((hit, index) => {
      options.beforeInsert?.(hit, index);
      const turnRef = resolveHitTurn(db, hit);
      const row = db
        .query<{ id: number }, [string, number, string | null, string, number]>(
          `INSERT INTO rule_events (
             event_uid, rule_id, event_kind, turn_ref, adjustment_json,
             created_at_epoch
           ) VALUES (?, ?, 'hit', ?, ?, ?)
           ON CONFLICT(event_uid) DO NOTHING
           RETURNING id`,
        )
        .get(
          hit.hit_id,
          hit.rule_id,
          turnRef,
          JSON.stringify({
            resolution: turnRef === null ? "unresolved" : "resolved",
            hit,
          }),
          Math.floor(hit.ts_ms / 1_000),
        );
      if (row) {
        inserted += 1;
        if (turnRef === null) unresolved += 1;
        else resolved += 1;
      } else {
        duplicate += 1;
      }
    });
    return { rotatedFiles, inserted, duplicate, resolved, unresolved };
  });
  const { rotatedFiles, inserted, duplicate, resolved, unresolved } =
    transactionResult;
  if (rotatedFiles.length === 0) {
    return {
      rotatedFiles: [],
      inserted: 0,
      duplicate: 0,
      resolved: 0,
      unresolved: 0,
      checkpointPath: null,
    };
  }

  options.afterCommit?.();
  const checkpointPath = writeCheckpoint(
    dataRoot,
    rotatedFiles,
    Math.floor((options.nowMs ?? Date.now)() / 1_000),
  );
  options.afterCheckpoint?.();
  for (const path of rotatedFiles) {
    try {
      unlinkSync(path);
    } catch (error) {
      if (!isErrorCode(error, "ENOENT")) throw error;
    }
  }

  return {
    rotatedFiles,
    inserted,
    duplicate,
    resolved,
    unresolved,
    checkpointPath,
  };
}
