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

/**
 * The rule subsystem's canonical reference namespace (spec §B): `S<session_id>`
 * plus `T<prompt_number>` — NOT the `[T<db-id>]` form the extractor writes.
 */
const RULE_TURN_REF_PATTERN = /^S(\d+)\/T(\d+)$/;

/**
 * Distinct resolved evidence turns a rule needs before its evidence exempts
 * anything (spec §B). Mirrors `propose_rule`'s own ≥2 requirement, re-checked at
 * read time because the resolver also sees records that path never validated.
 */
const RULE_EXEMPTION_MIN_EVIDENCE = 2;

/**
 * Turns the rule pipeline treats as load-bearing, resolved to DB turn ids.
 *
 * Settlement uses this as an EXEMPTION set (spec §B): a persistent rule's source
 * turn is routinely never cited by a later turn — rules are consumed by the
 * dispatcher, not by prose — so a zero-in-degree demotion nomination would
 * mechanically kill exactly the turns that produced durable knowledge. The
 * exemption blocks only that nomination; an explicit model or user re-grade
 * still applies.
 *
 * Two sources, both required by spec:
 *   - MULTI-EVIDENCE proposals — `propose_rule` demands ≥2 evidence refs, and
 *     those refs live on the rule (the `proposed` event carries none), so the
 *     rule's evidence array is read for rules that actually have a proposal or
 *     evidence-addition event behind them. A singular `turn_ref` on some other
 *     event is deliberately NOT a source: one incidental mention is not the
 *     multi-evidence signal the exemption is priced for.
 *   - JUDGMENTS traced through `source_event_id` to their originating `hit`
 *     event, whose `turn_ref` names the turn where the rule actually fired.
 *
 * The ≥2 requirement is RE-CHECKED here, not trusted from the writer. Only the
 * `propose_rule` path enforces it; a malformed, legacy or hand-edited
 * `evidence_added` record can leave a rule with one usable ref, and honouring
 * that would exempt a turn on exactly the single incidental mention the previous
 * paragraph rules out. Cardinality is counted over DISTINCT turns the refs
 * actually resolve to, so a duplicated ref is one piece of evidence, not two.
 *
 * Dangling refs (naming no turn) do not exempt. `sessionId`, when given, scopes
 * the RESULT to one session — the settlement caller only cares about its own
 * cohort — but the cardinality count deliberately spans sessions: a rule with
 * evidence in two different sessions is genuinely multi-evidence, and its one
 * in-scope turn is exactly as load-bearing as if both refs were local.
 */
export function getRuleExemptTurnIds(
  db: Database,
  sessionId?: number,
): Set<number> {
  const exempt = new Set<number>();
  const resolve = db.query<{ id: number }, [number, number]>(
    "SELECT id FROM turns WHERE session_id = ? AND prompt_number = ?",
  );

  /** Resolves a ref to a turn id, or null; does NOT apply the session scope. */
  const resolveRef = (
    ref: string | null | undefined,
  ): { sessionId: number; turnId: number } | null => {
    if (typeof ref !== "string") {
      return null;
    }
    const match = RULE_TURN_REF_PATTERN.exec(ref.trim());
    if (!match) {
      return null;
    }
    const refSessionId = Number(match[1]);
    const promptNumber = Number(match[2]);
    if (
      !Number.isSafeInteger(refSessionId) ||
      !Number.isSafeInteger(promptNumber)
    ) {
      return null;
    }
    const turn = resolve.get(refSessionId, promptNumber);
    return turn ? { sessionId: refSessionId, turnId: turn.id } : null;
  };

  const addRef = (ref: string | null): void => {
    const resolved = resolveRef(ref);
    if (!resolved) {
      return;
    }
    if (sessionId !== undefined && resolved.sessionId !== sessionId) {
      return;
    }
    exempt.add(resolved.turnId);
  };

  const proposedEvidence = db
    .query<{ evidence: string }, []>(
      `SELECT r.evidence AS evidence
       FROM rules r
       WHERE EXISTS (
         SELECT 1 FROM rule_events e
         WHERE e.rule_id = r.id
           AND e.event_kind IN ('proposed', 'evidence_added')
       )`,
    )
    .all();
  for (const row of proposedEvidence) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.evidence);
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) {
      continue;
    }
    // Resolve the WHOLE rule first: the ≥2 test is a property of the rule, so a
    // ref cannot be admitted until every sibling ref has been counted.
    const resolvedByRule = new Map<number, number>();
    for (const item of parsed) {
      if (item && typeof item === "object" && "ref" in item) {
        const resolved = resolveRef((item as { ref?: unknown }).ref as string);
        if (resolved) {
          resolvedByRule.set(resolved.turnId, resolved.sessionId);
        }
      }
    }
    if (resolvedByRule.size < RULE_EXEMPTION_MIN_EVIDENCE) {
      continue;
    }
    for (const [turnId, refSessionId] of resolvedByRule) {
      if (sessionId === undefined || refSessionId === sessionId) {
        exempt.add(turnId);
      }
    }
  }

  const judgmentSources = db
    .query<{ turnRef: string | null }, []>(
      `SELECT source.turn_ref AS turnRef
       FROM rule_events judgment
       JOIN rule_events source ON source.id = judgment.source_event_id
       WHERE judgment.event_kind = 'judgment'`,
    )
    .all();
  for (const row of judgmentSources) {
    addRef(row.turnRef);
  }

  return exempt;
}

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
