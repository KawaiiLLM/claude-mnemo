import { isAbsolute } from "node:path";

import type { Database } from "bun:sqlite";

import { runWriteTransaction } from "./database";
import { indexRuleToFTS } from "./search";
import {
  type RuleEvidence,
  type RuleStatus,
  ruleEvidenceSchema,
  ruleStatusSchema,
  type TriggerKind,
  type TriggerSpec,
  triggerSpecSchema,
} from "../rules/schema";

const MAX_TRIGGER_SPEC_BYTES = 1_024;
const RULE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface Rule {
  id: number;
  name: string;
  claim: string;
  rationale: string;
  scope: string;
  triggerKind: TriggerKind;
  triggerSpec: TriggerSpec | null;
  status: RuleStatus;
  evidence: RuleEvidence[];
  createdAtEpoch: number;
  updatedAtEpoch: number;
  lastEvidenceAtEpoch: number;
}

export interface CreateRuleInput {
  name: string;
  claim: string;
  rationale: string;
  scope: string;
  triggerKind: TriggerKind;
  triggerSpec: TriggerSpec | null;
  status: RuleStatus;
  evidence?: RuleEvidence[];
  createdAtEpoch: number;
  updatedAtEpoch?: number;
  lastEvidenceAtEpoch?: number;
}

export interface UpdateRuleInput {
  name?: string;
  claim?: string;
  rationale?: string;
  scope?: string;
  triggerKind?: TriggerKind;
  triggerSpec?: TriggerSpec | null;
  status?: RuleStatus;
  evidence?: RuleEvidence[];
  updatedAtEpoch: number;
  lastEvidenceAtEpoch?: number;
  event?: Omit<CreateRuleEventInput, "ruleId" | "createdAtEpoch">;
}

export interface RuleEvent {
  id: number;
  eventUid: string;
  ruleId: number;
  eventKind: string;
  sourceEventId: number | null;
  turnRef: string | null;
  label: string | null;
  rationale: string | null;
  adjustment: unknown | null;
  statusBefore: RuleStatus | null;
  statusAfter: RuleStatus | null;
  createdAtEpoch: number;
}

export interface CreateRuleEventInput {
  eventUid: string;
  ruleId: number;
  eventKind: string;
  sourceEventId?: number | null;
  turnRef?: string | null;
  label?: string | null;
  rationale?: string | null;
  adjustment?: unknown | null;
  statusBefore?: RuleStatus | null;
  statusAfter?: RuleStatus | null;
  createdAtEpoch: number;
}

interface RuleRow {
  id: number;
  name: string;
  claim: string;
  rationale: string;
  scope: string;
  triggerKind: TriggerKind;
  triggerSpec: string | null;
  status: RuleStatus;
  evidence: string;
  createdAtEpoch: number;
  updatedAtEpoch: number;
  lastEvidenceAtEpoch: number;
}

interface RuleEventRow {
  id: number;
  eventUid: string;
  ruleId: number;
  eventKind: string;
  sourceEventId: number | null;
  turnRef: string | null;
  label: string | null;
  rationale: string | null;
  adjustmentJson: string | null;
  statusBefore: RuleStatus | null;
  statusAfter: RuleStatus | null;
  createdAtEpoch: number;
}

const RULE_SELECT = `
  SELECT id, name, claim, rationale, scope,
         trigger_kind AS triggerKind, trigger_spec AS triggerSpec,
         status, evidence, created_at_epoch AS createdAtEpoch,
         updated_at_epoch AS updatedAtEpoch,
         last_evidence_at_epoch AS lastEvidenceAtEpoch
  FROM rules
`;

const RULE_RETURNING = `
  id, name, claim, rationale, scope,
  trigger_kind AS triggerKind, trigger_spec AS triggerSpec,
  status, evidence, created_at_epoch AS createdAtEpoch,
  updated_at_epoch AS updatedAtEpoch,
  last_evidence_at_epoch AS lastEvidenceAtEpoch
`;

function assertEpoch(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative epoch-second integer`);
  }
}

function validateRule(input: CreateRuleInput): {
  triggerSpecJson: string | null;
  evidenceJson: string;
} {
  if (!RULE_NAME.test(input.name)) throw new Error("name must be kebab-case");
  if (input.claim.length === 0 || input.claim.length > 300) {
    throw new Error("claim must contain at most 300 characters");
  }
  if (input.rationale.length === 0) throw new Error("rationale is required");
  if (input.scope !== "global" && !isAbsolute(input.scope)) {
    throw new Error("scope must be global or an absolute project path");
  }
  ruleStatusSchema.parse(input.status);
  assertEpoch(input.createdAtEpoch, "createdAtEpoch");
  assertEpoch(input.updatedAtEpoch ?? input.createdAtEpoch, "updatedAtEpoch");
  assertEpoch(
    input.lastEvidenceAtEpoch ?? input.createdAtEpoch,
    "lastEvidenceAtEpoch",
  );

  let triggerSpecJson: string | null = null;
  if (input.triggerKind === "none") {
    if (input.triggerSpec !== null) {
      throw new Error("triggerSpec must be null when triggerKind is none");
    }
  } else {
    const parsed = triggerSpecSchema.parse(input.triggerSpec);
    if (parsed.kind !== input.triggerKind) {
      throw new Error("triggerKind must match triggerSpec.kind");
    }
    triggerSpecJson = JSON.stringify(parsed);
    if (Buffer.byteLength(triggerSpecJson, "utf8") > MAX_TRIGGER_SPEC_BYTES) {
      throw new Error("triggerSpec must be at most 1KB");
    }
  }

  const evidence = (input.evidence ?? []).map((item) =>
    ruleEvidenceSchema.parse(item),
  );
  return { triggerSpecJson, evidenceJson: JSON.stringify(evidence) };
}

function mapRule(row: RuleRow): Rule {
  return {
    ...row,
    triggerSpec:
      row.triggerSpec === null
        ? null
        : triggerSpecSchema.parse(JSON.parse(row.triggerSpec)),
    evidence: ruleEvidenceSchema.array().parse(JSON.parse(row.evidence)),
  };
}

function mapEvent(row: RuleEventRow): RuleEvent {
  const { adjustmentJson, ...event } = row;
  return {
    ...event,
    adjustment: adjustmentJson === null ? null : JSON.parse(adjustmentJson),
  };
}

function insertEvent(db: Database, input: CreateRuleEventInput): RuleEvent {
  assertEpoch(input.createdAtEpoch, "createdAtEpoch");
  if (input.eventKind === "judgment") {
    if (input.sourceEventId == null) {
      throw new Error("judgment events require sourceEventId");
    }
    const source = db.query<{ eventKind: string; ruleId: number }, [number]>(
      `SELECT event_kind AS eventKind, rule_id AS ruleId
       FROM rule_events WHERE id = ?`,
    ).get(input.sourceEventId);
    if (source?.eventKind !== "hit" || source.ruleId !== input.ruleId) {
      throw new Error("sourceEventId must reference a hit for the same rule");
    }
  } else if (input.sourceEventId != null) {
    throw new Error("sourceEventId is only valid for judgment events");
  }
  const row = db.query<RuleEventRow, Array<string | number | null>>(
    `INSERT INTO rule_events (
       event_uid, rule_id, event_kind, source_event_id, turn_ref, label,
       rationale, adjustment_json, status_before, status_after, created_at_epoch
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING id, event_uid AS eventUid, rule_id AS ruleId,
       event_kind AS eventKind, source_event_id AS sourceEventId,
       turn_ref AS turnRef, label, rationale, adjustment_json AS adjustmentJson,
       status_before AS statusBefore, status_after AS statusAfter,
       created_at_epoch AS createdAtEpoch`,
  ).get(
    input.eventUid,
    input.ruleId,
    input.eventKind,
    input.sourceEventId ?? null,
    input.turnRef ?? null,
    input.label ?? null,
    input.rationale ?? null,
    input.adjustment == null ? null : JSON.stringify(input.adjustment),
    input.statusBefore ?? null,
    input.statusAfter ?? null,
    input.createdAtEpoch,
  );
  if (!row) throw new Error("failed to create rule event");
  return mapEvent(row);
}

export interface RuleStore {
  create(input: CreateRuleInput): Rule;
  get(id: number): Rule | null;
  list(): Rule[];
  update(id: number, input: UpdateRuleInput): Rule;
  createEvent(input: CreateRuleEventInput): RuleEvent;
  getEventByUid(eventUid: string): RuleEvent | null;
  getJudgmentBySourceEventId(sourceEventId: number): RuleEvent | null;
  getLatestTombstoneReason(ruleId: number): string | null;
  listEvents(ruleId: number): RuleEvent[];
}

export function createRuleStore(db: Database): RuleStore {
  return {
    create(input) {
      const validated = validateRule(input);
      const updatedAt: number = input.updatedAtEpoch ?? input.createdAtEpoch;
      const lastEvidenceAt: number =
        input.lastEvidenceAtEpoch ?? input.createdAtEpoch;
      const row = db.query<RuleRow, Array<string | number | null>>(
        `INSERT INTO rules (
           name, claim, rationale, scope, trigger_kind, trigger_spec, status,
           evidence, created_at_epoch, updated_at_epoch, last_evidence_at_epoch
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING ${RULE_RETURNING}`,
      ).get(
        input.name,
        input.claim,
        input.rationale,
        input.scope,
        input.triggerKind,
        validated.triggerSpecJson,
        input.status,
        validated.evidenceJson,
        input.createdAtEpoch,
        updatedAt,
        lastEvidenceAt,
      );
      if (!row) throw new Error("failed to create rule");
      const rule = mapRule(row);
      indexRuleToFTS(db, rule);
      return rule;
    },

    get(id) {
      const row = db.query<RuleRow, [number]>(`${RULE_SELECT} WHERE id = ?`).get(id);
      return row ? mapRule(row) : null;
    },

    list() {
      return db.query<RuleRow, []>(`${RULE_SELECT} ORDER BY id`).all().map(mapRule);
    },

    update(id, input) {
      return runWriteTransaction(db, () => {
        const current = this.get(id);
        if (!current) throw new Error(`rule ${id} not found`);
        const nextInput: CreateRuleInput = {
          ...current,
          ...input,
          triggerSpec:
            input.triggerSpec === undefined
              ? current.triggerSpec
              : input.triggerSpec,
          createdAtEpoch: current.createdAtEpoch,
          updatedAtEpoch: input.updatedAtEpoch,
          lastEvidenceAtEpoch:
            input.lastEvidenceAtEpoch ?? current.lastEvidenceAtEpoch,
        };
        const validated = validateRule(nextInput);
        db.query(
          `UPDATE rules SET name = ?, claim = ?, rationale = ?, scope = ?,
             trigger_kind = ?, trigger_spec = ?, status = ?, evidence = ?,
             updated_at_epoch = ?, last_evidence_at_epoch = ?
           WHERE id = ?`,
        ).run(
          nextInput.name,
          nextInput.claim,
          nextInput.rationale,
          nextInput.scope,
          nextInput.triggerKind,
          validated.triggerSpecJson,
          nextInput.status,
          validated.evidenceJson,
          input.updatedAtEpoch,
          nextInput.lastEvidenceAtEpoch ?? current.lastEvidenceAtEpoch,
          id,
        );
        if (current.status !== nextInput.status) {
          if (!input.event) {
            throw new Error("status changes require a rule event");
          }
          insertEvent(db, {
            ...input.event,
            ruleId: id,
            statusBefore: current.status,
            statusAfter: nextInput.status,
            createdAtEpoch: input.updatedAtEpoch,
          });
        }
        const updated = this.get(id)!;
        indexRuleToFTS(db, updated);
        return updated;
      });
    },

    createEvent(input) {
      return insertEvent(db, input);
    },

    getEventByUid(eventUid) {
      const row = db.query<RuleEventRow, [string]>(
        `SELECT id, event_uid AS eventUid, rule_id AS ruleId,
           event_kind AS eventKind, source_event_id AS sourceEventId,
           turn_ref AS turnRef, label, rationale,
           adjustment_json AS adjustmentJson, status_before AS statusBefore,
           status_after AS statusAfter, created_at_epoch AS createdAtEpoch
         FROM rule_events WHERE event_uid = ?`,
      ).get(eventUid);
      return row ? mapEvent(row) : null;
    },

    getJudgmentBySourceEventId(sourceEventId) {
      const row = db.query<RuleEventRow, [number]>(
        `SELECT id, event_uid AS eventUid, rule_id AS ruleId,
           event_kind AS eventKind, source_event_id AS sourceEventId,
           turn_ref AS turnRef, label, rationale,
           adjustment_json AS adjustmentJson, status_before AS statusBefore,
           status_after AS statusAfter, created_at_epoch AS createdAtEpoch
         FROM rule_events
         WHERE event_kind = 'judgment' AND source_event_id = ?`,
      ).get(sourceEventId);
      return row ? mapEvent(row) : null;
    },

    getLatestTombstoneReason(ruleId) {
      return db.query<{ rationale: string | null }, [number]>(
        `SELECT rationale
         FROM rule_events
         WHERE rule_id = ?
           AND status_after IN ('refuted', 'retired')
           AND rationale IS NOT NULL
           AND length(trim(rationale)) > 0
         ORDER BY id DESC LIMIT 1`,
      ).get(ruleId)?.rationale ?? null;
    },

    listEvents(ruleId) {
      return db.query<RuleEventRow, [number]>(
        `SELECT id, event_uid AS eventUid, rule_id AS ruleId,
           event_kind AS eventKind, source_event_id AS sourceEventId,
           turn_ref AS turnRef, label, rationale,
           adjustment_json AS adjustmentJson, status_before AS statusBefore,
           status_after AS statusAfter, created_at_epoch AS createdAtEpoch
         FROM rule_events WHERE rule_id = ? ORDER BY id`,
      ).all(ruleId).map(mapEvent);
    },
  };
}
