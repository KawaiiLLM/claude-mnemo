import type { Database } from "bun:sqlite";
import { z } from "zod";

import { createRuleStore, type Rule } from "../db/rules";
import { calendarDayBounds } from "../diary/calendar";
import {
  DEFAULT_DREAM_AGENT_HOUR,
  DEFAULT_DREAM_AGENT_TIME_ZONE,
} from "../shared/config";

/**
 * Matches turn-detail.sh's per-observation cap. Reusing 1,500 for each of the
 * three turn fields keeps their default contribution near 4,500 characters,
 * leaving ample room below the SDK's 100K whole-result limit.
 */
export const READ_TURN_DETAIL_DEFAULT_CAP = 1_500;
/** Three fields at this cap stay near 75K, below the SDK whole-result limit. */
export const READ_TURN_DETAIL_MAX_TEXT_CAP = 25_000;

const calendarDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).refine(
  (date) => {
    const parsed = new Date(`${date}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
  },
  "date must be a real YYYY-MM-DD calendar day",
);

const turnRefSchema = z.string().regex(/^S[1-9]\d*\/T[1-9]\d*$/u, {
  message: "turn_ref must match S<session_id>/T<prompt_number>",
});

export const readTurnDetailOptionsSchema = z
  .object({
    cap: z.number().int().positive().optional(),
    text_cap: z.number().int().positive().max(READ_TURN_DETAIL_MAX_TEXT_CAP).optional(),
    text_offset: z.number().int().nonnegative().optional(),
    full: z.boolean().optional(),
    include_observations: z.boolean().optional(),
    tool: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((options, context) => {
    if (
      options.full === true &&
      (
        options.cap !== undefined ||
        options.text_cap !== undefined ||
        options.text_offset !== undefined
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "cap/text_cap/text_offset and full conflict; pass one",
      });
    }
  });

export const listRuleHitsInputShape = {
  date: calendarDateSchema,
};

export const listRuleHitsInputSchema = z.object(listRuleHitsInputShape).strict();

export const readTurnDetailInputShape = {
  turn_ref: turnRefSchema,
  opts: readTurnDetailOptionsSchema.optional(),
};

export const readTurnDetailInputSchema = z
  .object(readTurnDetailInputShape)
  .strict();

export type ReadTurnDetailOptions = z.infer<typeof readTurnDetailOptionsSchema>;

export interface RuleHitReadResult {
  event_id: number;
  hit_id: string;
  created_at_epoch: number;
  rule: Rule;
  turn_ref: string | null;
  resolution: "resolved" | "unresolved";
  unresolved: boolean;
  hit: unknown | null;
}

export interface ListRuleHitsResult {
  date: string;
  hits: RuleHitReadResult[];
}

export interface TurnDetailText {
  id: number;
  session_id: number;
  prompt_number: number;
  user_prompt_len: number | null;
  assistant_response_len: number | null;
  assistant_transcript_len: number | null;
  user_prompt_truncated: boolean;
  assistant_response_truncated: boolean;
  assistant_transcript_truncated: boolean;
  user_prompt: string | null;
  assistant_response: string | null;
  assistant_transcript: string | null;
}

export interface TurnDetailObservation {
  id: number;
  tool_name: string | null;
  status: "pending" | "extracted" | "skipped";
  input_len: number | null;
  result_len: number | null;
  tool_input: string | null;
  tool_result: string | null;
}

export interface ReadTurnDetailResult {
  turn_ref: string;
  turn: TurnDetailText;
  observations?: TurnDetailObservation[];
}

export interface CreateDreamRuleReadToolsOptions {
  db: Database;
  timeZone?: string;
  boundaryHour?: number;
}

interface HitRow {
  eventId: number;
  hitId: string;
  ruleId: number;
  turnRef: string | null;
  adjustmentJson: string | null;
  createdAtEpoch: number;
}

interface TurnRefParts {
  sessionId: number;
  promptNumber: number;
}

type TurnDetailTextRow = Omit<
  TurnDetailText,
  | "user_prompt_truncated"
  | "assistant_response_truncated"
  | "assistant_transcript_truncated"
>;

function readDreamCalendarBoundary(db: Database): {
  timeZone: string;
  boundaryHour: number;
} {
  const timeZone = db.query<{ value: string }, []>(
    "SELECT value FROM diary_state WHERE key = 'dream_timezone'",
  ).get()?.value ?? DEFAULT_DREAM_AGENT_TIME_ZONE;
  const storedHour = db.query<{ value: string }, []>(
    "SELECT value FROM diary_state WHERE key = 'dream_hour'",
  ).get()?.value;
  const boundaryHour = storedHour === undefined
    ? DEFAULT_DREAM_AGENT_HOUR
    : Number(storedHour);
  if (!Number.isInteger(boundaryHour) || boundaryHour < 0 || boundaryHour > 23) {
    throw new Error(`invalid stored dream_hour: ${storedHour}`);
  }
  return { timeZone, boundaryHour };
}

function parseAdjustment(value: string | null): Record<string, unknown> | null {
  if (value === null) return null;
  const parsed: unknown = JSON.parse(value);
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : null;
}

function parseTurnRef(turnRef: string): TurnRefParts {
  const parsed = turnRefSchema.parse(turnRef);
  const match = /^S(\d+)\/T(\d+)$/u.exec(parsed)!;
  return {
    sessionId: Number(match[1]),
    promptNumber: Number(match[2]),
  };
}

function observationQuery(full: boolean): string {
  const textColumns = full
    ? "tool_input, tool_result"
    : "substr(tool_input, 1, ?) AS tool_input, substr(tool_result, 1, ?) AS tool_result";
  // `excluded_from_extraction = 0`: a `note` call's observation is captured for
  // the raw axis only. The dream agent reads turn detail in full, so without the
  // filter the note payload — the very text the P1 trial keeps out of the old
  // pipeline — would come back through this tool verbatim.
  return `
    SELECT id, tool_name, status,
           length(tool_input) AS input_len,
           length(tool_result) AS result_len,
           ${textColumns}
    FROM observations
    WHERE turn_id = ? AND excluded_from_extraction = 0
      AND (? IS NULL OR tool_name LIKE ?)
    ORDER BY id`;
}

function textWasTruncated(
  trueLength: number | null,
  value: string | null,
  offset: number,
): boolean {
  return trueLength !== null && (offset > 0 || (value?.length ?? 0) < trueLength);
}

function mapTurnDetailText(row: TurnDetailTextRow, offset: number): TurnDetailText {
  return {
    ...row,
    user_prompt_truncated: textWasTruncated(
      row.user_prompt_len,
      row.user_prompt,
      offset,
    ),
    assistant_response_truncated: textWasTruncated(
      row.assistant_response_len,
      row.assistant_response,
      offset,
    ),
    assistant_transcript_truncated: textWasTruncated(
      row.assistant_transcript_len,
      row.assistant_transcript,
      offset,
    ),
  };
}

export function createDreamRuleReadTools(
  options: CreateDreamRuleReadToolsOptions,
): {
  listRuleHits(date: string): ListRuleHitsResult;
  readTurnDetail(
    turnRef: string,
    detailOptions?: ReadTurnDetailOptions,
  ): ReadTurnDetailResult;
} {
  return {
    listRuleHits(rawDate) {
      const date = calendarDateSchema.parse(rawDate);
      const storedBoundary = readDreamCalendarBoundary(options.db);
      const { startEpoch, endEpoch } = calendarDayBounds(
        date,
        options.timeZone ?? storedBoundary.timeZone,
        options.boundaryHour ?? storedBoundary.boundaryHour,
      );
      const rows = options.db.query<HitRow, [number, number]>(
        `SELECT h.id AS eventId, h.event_uid AS hitId, h.rule_id AS ruleId,
                h.turn_ref AS turnRef, h.adjustment_json AS adjustmentJson,
                h.created_at_epoch AS createdAtEpoch
         FROM rule_events h
         WHERE h.event_kind = 'hit'
           AND h.created_at_epoch >= ?
           AND h.created_at_epoch < ?
           AND NOT EXISTS (
             SELECT 1 FROM rule_events judgment
             WHERE judgment.event_kind = 'judgment'
               AND judgment.source_event_id = h.id
           )
         ORDER BY h.created_at_epoch ASC, h.id ASC`,
      ).all(startEpoch, endEpoch);
      const store = createRuleStore(options.db);
      return {
        date,
        hits: rows.map((row) => {
          const rule = store.get(row.ruleId);
          if (!rule) throw new Error(`rule ${row.ruleId} not found for hit ${row.hitId}`);
          const adjustment = parseAdjustment(row.adjustmentJson);
          const unresolved = row.turnRef === null;
          return {
            event_id: row.eventId,
            hit_id: row.hitId,
            created_at_epoch: row.createdAtEpoch,
            rule,
            turn_ref: row.turnRef,
            resolution: unresolved ? "unresolved" as const : "resolved" as const,
            unresolved,
            hit: adjustment?.hit ?? null,
          };
        }),
      };
    },

    readTurnDetail(rawTurnRef, rawDetailOptions = {}) {
      const turnRef = turnRefSchema.parse(rawTurnRef);
      const detailOptions = readTurnDetailOptionsSchema.parse(rawDetailOptions);
      const { sessionId, promptNumber } = parseTurnRef(turnRef);
      const full = detailOptions.full === true;
      const textCap = detailOptions.text_cap ?? READ_TURN_DETAIL_DEFAULT_CAP;
      const textOffset = detailOptions.text_offset ?? 0;
      const turnRow = full
        ? options.db.query<TurnDetailTextRow, [number, number]>(
            `SELECT id, session_id, prompt_number,
                    length(user_prompt) AS user_prompt_len,
                    length(assistant_response) AS assistant_response_len,
                    length(assistant_transcript) AS assistant_transcript_len,
                    user_prompt, assistant_response, assistant_transcript
             FROM turns
             WHERE session_id = ? AND prompt_number = ?`,
          ).get(sessionId, promptNumber)
        : options.db.query<
            TurnDetailTextRow,
            [number, number, number, number, number, number, number, number]
          >(
            `SELECT id, session_id, prompt_number,
                    length(user_prompt) AS user_prompt_len,
                    length(assistant_response) AS assistant_response_len,
                    length(assistant_transcript) AS assistant_transcript_len,
                    substr(user_prompt, ? + 1, ?) AS user_prompt,
                    substr(assistant_response, ? + 1, ?) AS assistant_response,
                    substr(assistant_transcript, ? + 1, ?) AS assistant_transcript
             FROM turns
             WHERE session_id = ? AND prompt_number = ?`,
          ).get(
            textOffset,
            textCap,
            textOffset,
            textCap,
            textOffset,
            textCap,
            sessionId,
            promptNumber,
          );
      if (!turnRow) throw new Error(`turn not found: ${turnRef}`);
      const turn = mapTurnDetailText(turnRow, textOffset);

      const result: ReadTurnDetailResult = { turn_ref: turnRef, turn };
      if (detailOptions.include_observations === false) return result;

      const tool = detailOptions.tool ?? null;
      result.observations = full
        ? options.db.query<TurnDetailObservation, [number, string | null, string | null]>(
            observationQuery(true),
          ).all(turn.id, tool, tool)
        : options.db.query<
            TurnDetailObservation,
            [number, number, number, string | null, string | null]
          >(observationQuery(false)).all(
            detailOptions.cap ?? READ_TURN_DETAIL_DEFAULT_CAP,
            detailOptions.cap ?? READ_TURN_DETAIL_DEFAULT_CAP,
            turn.id,
            tool,
            tool,
          );
      return result;
    },
  };
}
