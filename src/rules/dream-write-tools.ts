import type { Database } from "bun:sqlite";
import { z } from "zod";

import { runWriteTransaction } from "../db/database";
import {
  createRuleStore,
  type Rule,
  type RuleEvent,
} from "../db/rules";
import {
  normalizeTrigramText,
  searchRuleClaimCandidates,
} from "../db/search";
import { hashContent } from "../utils/hash";
import {
  ruleEvidenceSchema,
  ruleStatusSchema,
  triggerSpecSchema,
} from "./schema";

export const RULE_CLAIM_SIMILARITY_THRESHOLD = 0.72;

export const proposeRuleInputShape = {
  name: z.string().min(1),
  claim: z.string().min(1).max(300),
  rationale: z.string().min(1),
  scope: z.string().min(1),
  trigger_kind: z.enum(["prompt", "tool", "result", "none"]),
  trigger_spec: triggerSpecSchema.nullable(),
  evidence: ruleEvidenceSchema.array().optional(),
  distinct_from: z.array(z.number().int().positive()).min(1).optional(),
  add_evidence_to: z.number().int().positive().optional(),
};

export const proposeRuleInputSchema = z
  .object(proposeRuleInputShape)
  .strict()
  .superRefine((input, context) => {
    if (input.add_evidence_to !== undefined && !input.evidence?.length) {
      context.addIssue({
        code: "custom",
        path: ["evidence"],
        message: "evidence is required when add_evidence_to is set",
      });
    }
    if (input.add_evidence_to !== undefined && input.distinct_from !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["distinct_from"],
        message: "distinct_from cannot be combined with add_evidence_to",
      });
    }
  });

const adjustmentSchema = z
  .object({ status: ruleStatusSchema.optional() })
  .catchall(z.unknown());

export const submitJudgmentInputShape = {
  rule_id: z.number().int().positive(),
  source_event_id: z.number().int().positive(),
  label: z.string().min(1),
  rationale: z.string().min(1),
  adjustment: adjustmentSchema.optional(),
};

export const submitJudgmentInputSchema = z
  .object(submitJudgmentInputShape)
  .strict();

export type ProposeRuleInput = z.infer<typeof proposeRuleInputSchema>;
export type SubmitJudgmentInput = z.infer<typeof submitJudgmentInputSchema>;

interface SimilarRuleCandidate {
  id: number;
  name: string;
  claim: string;
  status: Rule["status"];
  similarity: number;
  rejection_reason?: string | null;
  suggested_action?: "add_evidence";
}

export type ProposeRuleResult =
  | {
      status: "rejected";
      reason: "insufficient_evidence";
      detail: string;
    }
  | {
      status: "rejected";
      reason: "exact_name" | "similar_claim";
      candidates: SimilarRuleCandidate[];
    }
  | {
      status: "created";
      idempotent: boolean;
      event_uid: string;
      rule: Rule;
      event: RuleEvent;
    }
  | {
      status: "evidence_added";
      idempotent: boolean;
      event_uid: string;
      rule: Rule;
      event: RuleEvent;
    };

export type SubmitJudgmentResult =
  | {
      status: "recorded";
      idempotent: boolean;
      event_uid: string;
      event: RuleEvent;
      rule: Rule;
    }
  | {
      status: "conflict";
      idempotent: false;
      event_uid: string;
      event: RuleEvent;
      rule: Rule;
    };

export interface CreateDreamRuleWriteToolsOptions {
  db: Database;
  /** Returns epoch seconds; injectable so function-seam tests are deterministic. */
  now?: () => number;
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("tool input must be valid JSON");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
      .join(",")}}`;
  }
  throw new Error("tool input must be valid JSON");
}

function eventUid(kind: "propose_rule" | "submit_judgment", input: unknown): string {
  return `${kind}:${hashContent(stableSerialize(input))}`;
}

function trigrams(value: string): string[] {
  const codePoints = Array.from(normalizeTrigramText(value));
  const result: string[] = [];
  for (let index = 0; index <= codePoints.length - 3; index += 1) {
    result.push(codePoints.slice(index, index + 3).join(""));
  }
  return result;
}

function trigramSimilarity(left: string, right: string): number {
  const leftSet = new Set(trigrams(left));
  const rightSet = new Set(trigrams(right));
  if (leftSet.size === 0 || rightSet.size === 0) {
    return normalizeTrigramText(left) === normalizeTrigramText(right) ? 1 : 0;
  }
  let overlap = 0;
  for (const gram of leftSet) {
    if (rightSet.has(gram)) overlap += 1;
  }
  return (2 * overlap) / (leftSet.size + rightSet.size);
}

function isTombstoneStatus(status: Rule["status"]): boolean {
  return status === "refuted" || status === "retired";
}

function similarCandidates(db: Database, claim: string): SimilarRuleCandidate[] {
  const store = createRuleStore(db);
  const grams = trigrams(claim);
  const candidateIds = grams.length > 0
    ? searchRuleClaimCandidates(db, grams)
    : store.list().map(({ id }) => id);
  return candidateIds
    .map((id) => store.get(id))
    .filter((rule): rule is Rule => rule !== null)
    .map((rule) => ({ rule, similarity: trigramSimilarity(claim, rule.claim) }))
    .filter(({ similarity }) => similarity > RULE_CLAIM_SIMILARITY_THRESHOLD)
    .sort((left, right) => right.similarity - left.similarity || left.rule.id - right.rule.id)
    .map(({ rule, similarity }) => ({
      id: rule.id,
      name: rule.name,
      claim: rule.claim,
      status: rule.status,
      similarity,
      ...(isTombstoneStatus(rule.status)
        ? {
            rejection_reason: store.getLatestTombstoneReason(rule.id),
          }
        : { suggested_action: "add_evidence" as const }),
    }));
}

function exactNameCandidate(rule: Rule): SimilarRuleCandidate {
  return {
    id: rule.id,
    name: rule.name,
    claim: rule.claim,
    status: rule.status,
    similarity: 1,
    ...(isTombstoneStatus(rule.status)
      ? {}
      : { suggested_action: "add_evidence" as const }),
  };
}

const EVIDENCE_REF_PATTERN = /^S(\d+)\/T(\d+)$/;

function validateProposalEvidence(
  db: Database,
  input: ProposeRuleInput,
): string | null {
  const evidence = input.evidence ?? [];
  const isAddEvidenceOperation = input.add_evidence_to !== undefined;
  if (!isAddEvidenceOperation && evidence.length < 2) {
    return "at least 2 evidence items are required";
  }

  const resolvedTurns: Array<{ id: number; sessionId: number }> = [];
  for (const [index, item] of evidence.entries()) {
    const match = EVIDENCE_REF_PATTERN.exec(item.ref);
    if (!match) {
      return `evidence[${index}].ref must match ^S\\d+/T\\d+$`;
    }
    const sessionId = Number(match[1]);
    const promptNumber = Number(match[2]);
    const turn = Number.isSafeInteger(sessionId) &&
        Number.isSafeInteger(promptNumber)
      ? db.query<{ id: number; sessionId: number }, [number, number]>(
          `SELECT t.id, t.session_id AS sessionId
           FROM turns t
           JOIN sessions s ON s.id = t.session_id
           WHERE t.session_id = ? AND t.prompt_number = ?`,
        ).get(sessionId, promptNumber)
      : null;
    if (!turn) {
      return `evidence[${index}].ref does not reference an existing turn: ${item.ref}`;
    }
    resolvedTurns.push(turn);
  }

  if (isAddEvidenceOperation) return null;
  if (new Set(resolvedTurns.map(({ id }) => id)).size < 2) {
    return "at least 2 distinct turns are required";
  }
  if (
    input.scope === "global" &&
    new Set(resolvedTurns.map(({ sessionId }) => sessionId)).size < 2
  ) {
    return "global scope requires evidence from at least 2 distinct sessions";
  }
  return null;
}

export function createDreamRuleWriteTools(
  options: CreateDreamRuleWriteToolsOptions,
): {
  proposeRule(input: unknown): ProposeRuleResult;
  submitJudgment(input: unknown): SubmitJudgmentResult;
} {
  const now = options.now ?? (() => Math.floor(Date.now() / 1_000));

  return {
    proposeRule(rawInput) {
      const input = proposeRuleInputSchema.parse(rawInput);
      const uid = eventUid("propose_rule", input);
      return runWriteTransaction(options.db, () => {
        const store = createRuleStore(options.db);
        const priorEvent = store.getEventByUid(uid);
        if (priorEvent) {
          const priorRule = store.get(priorEvent.ruleId);
          const expectedKind = input.add_evidence_to === undefined
            ? "proposed"
            : "evidence_added";
          if (!priorRule || priorEvent.eventKind !== expectedKind) {
            throw new Error(`event_uid collision for ${uid}`);
          }
          if (input.add_evidence_to === undefined) {
            return {
              status: "created" as const,
              idempotent: true,
              event_uid: uid,
              rule: priorRule,
              event: priorEvent,
            };
          }
          return {
            status: "evidence_added" as const,
            idempotent: true,
            event_uid: uid,
            rule: priorRule,
            event: priorEvent,
          };
        }

        let evidenceTarget: Rule | null = null;
        if (input.add_evidence_to !== undefined) {
          const target = store.get(input.add_evidence_to);
          if (!target) {
            throw new Error(`rule ${input.add_evidence_to} not found`);
          }
          if (isTombstoneStatus(target.status)) {
            throw new Error(
              `cannot add evidence to tombstoned rule ${input.add_evidence_to}`,
            );
          }
          evidenceTarget = target;
        }

        const evidenceRejection = validateProposalEvidence(options.db, input);
        if (evidenceRejection) {
          return {
            status: "rejected" as const,
            reason: "insufficient_evidence" as const,
            detail: evidenceRejection,
          };
        }

        if (evidenceTarget) {
          const evidence = input.evidence!;
          const createdAtEpoch = now();
          const rule = store.update(evidenceTarget.id, {
            evidence: [...evidenceTarget.evidence, ...evidence],
            updatedAtEpoch: createdAtEpoch,
            lastEvidenceAtEpoch: Math.max(
              evidenceTarget.lastEvidenceAtEpoch,
              ...evidence.map(({ at }) => at),
            ),
          });
          const event = store.createEvent({
            eventUid: uid,
            ruleId: evidenceTarget.id,
            eventKind: "evidence_added",
            rationale: input.rationale,
            adjustment: { evidence_count: evidence.length },
            createdAtEpoch,
          });
          return {
            status: "evidence_added" as const,
            idempotent: false,
            event_uid: uid,
            rule,
            event,
          };
        }

        const exactName = store.list().find((rule) => rule.name === input.name);
        if (exactName) {
          return {
            status: "rejected" as const,
            reason: "exact_name" as const,
            candidates: [exactNameCandidate(exactName)],
          };
        }

        const candidates = similarCandidates(options.db, input.claim);
        const distinctions = new Set(input.distinct_from ?? []);
        if (candidates.some(({ id }) => !distinctions.has(id))) {
          return {
            status: "rejected" as const,
            reason: "similar_claim" as const,
            candidates,
          };
        }

        const createdAtEpoch = now();
        const rule = store.create({
          name: input.name,
          claim: input.claim,
          rationale: input.rationale,
          scope: input.scope,
          triggerKind: input.trigger_kind,
          triggerSpec: input.trigger_spec,
          status: "provisional",
          evidence: input.evidence,
          createdAtEpoch,
        });
        const event = store.createEvent({
          eventUid: uid,
          ruleId: rule.id,
          eventKind: "proposed",
          rationale: input.rationale,
          adjustment: input.distinct_from
            ? { distinct_from: [...input.distinct_from] }
            : null,
          createdAtEpoch,
        });
        return {
          status: "created" as const,
          idempotent: false,
          event_uid: uid,
          rule,
          event,
        };
      });
    },

    submitJudgment(rawInput) {
      const input = submitJudgmentInputSchema.parse(rawInput);
      const uid = eventUid("submit_judgment", input);
      return runWriteTransaction(options.db, () => {
        const store = createRuleStore(options.db);
        const priorJudgment = store.getJudgmentBySourceEventId(input.source_event_id);
        if (priorJudgment) {
          const priorRule = store.get(priorJudgment.ruleId);
          if (!priorRule) {
            throw new Error(`rule ${priorJudgment.ruleId} not found`);
          }
          const idempotent = priorJudgment.eventUid === uid;
          if (idempotent) {
            return {
              status: "recorded" as const,
              idempotent: true,
              event_uid: priorJudgment.eventUid,
              event: priorJudgment,
              rule: priorRule,
            };
          }
          return {
            status: "conflict" as const,
            idempotent: false,
            event_uid: priorJudgment.eventUid,
            event: priorJudgment,
            rule: priorRule,
          };
        }

        const priorEvent = store.getEventByUid(uid);
        if (priorEvent) {
          throw new Error(`event_uid collision for ${uid}`);
        }

        const rule = store.get(input.rule_id);
        if (!rule) throw new Error(`rule ${input.rule_id} not found`);
        const createdAtEpoch = now();
        const nextStatus = input.adjustment?.status;
        let updatedRule = rule;
        let event: RuleEvent;
        if (nextStatus !== undefined && nextStatus !== rule.status) {
          updatedRule = store.update(rule.id, {
            status: nextStatus,
            updatedAtEpoch: createdAtEpoch,
            event: {
              eventUid: uid,
              eventKind: "judgment",
              sourceEventId: input.source_event_id,
              label: input.label,
              rationale: input.rationale,
              adjustment: input.adjustment,
            },
          });
          event = store.getEventByUid(uid)!;
        } else {
          event = store.createEvent({
            eventUid: uid,
            ruleId: rule.id,
            eventKind: "judgment",
            sourceEventId: input.source_event_id,
            label: input.label,
            rationale: input.rationale,
            adjustment: input.adjustment ?? null,
            createdAtEpoch,
          });
        }
        return {
          status: "recorded" as const,
          idempotent: false,
          event_uid: uid,
          event,
          rule: updatedRule,
        };
      });
    },
  };
}
