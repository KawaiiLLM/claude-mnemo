import { createHash } from "node:crypto";
import { resolve } from "node:path";

import type { Database } from "bun:sqlite";

import { runWriteTransaction } from "../db/database";
import { createRuleStore, type Rule } from "../db/rules";
import {
  TRIGGER_INDEX_SLOT_LIMIT,
  type RuleStatus,
  type TriggerIndex,
  triggerIndexSchema,
} from "./schema";

export { TRIGGER_INDEX_SLOT_LIMIT } from "./schema";

export interface RenderTriggerIndexOptions {
  project: string;
  createdAtEpoch: number;
}

function priorPushStatus(db: Database, rule: Rule): "confirmed" | "provisional" {
  if (rule.status !== "digest_only") return rule.status as "confirmed" | "provisional";
  const row = db.query<{ statusBefore: RuleStatus | null }, [number]>(
    `SELECT status_before AS statusBefore
     FROM rule_events
     WHERE rule_id = ? AND status_after = 'digest_only'
     ORDER BY id DESC LIMIT 1`,
  ).get(rule.id);
  return row?.statusBefore === "confirmed" ? "confirmed" : "provisional";
}

function priority(
  rule: Rule,
  pushStatus: "confirmed" | "provisional",
): [number, number, number] {
  return [
    pushStatus === "confirmed" ? 1 : 0,
    rule.lastEvidenceAtEpoch,
    -rule.id,
  ];
}

function comparePriority(
  left: Rule,
  right: Rule,
  pushStatuses: ReadonlyMap<number, "confirmed" | "provisional">,
): number {
  const a = priority(left, pushStatuses.get(left.id)!);
  const b = priority(right, pushStatuses.get(right.id)!);
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return b[index]! - a[index]!;
  }
  return 0;
}

function evictionEventUid(
  project: string,
  rule: Rule,
  nextStatus: RuleStatus,
  createdAtEpoch: number,
): string {
  const digest = createHash("sha256")
    .update(`${resolve(project)}\0${rule.id}\0${rule.status}\0${nextStatus}\0${createdAtEpoch}`)
    .digest("hex");
  return `trigger-index:${digest}`;
}

export function renderTriggerIndex(
  db: Database,
  options: RenderTriggerIndexOptions,
): TriggerIndex {
  return runWriteTransaction(db, () => {
    const project = resolve(options.project);
    const store = createRuleStore(db);
    const candidates = store
      .list()
      .filter(
        (rule) =>
          (rule.scope === "global" || resolve(rule.scope) === project) &&
          rule.triggerKind !== "none" &&
          ["confirmed", "provisional", "digest_only"].includes(rule.status),
      );
    const pushStatuses = new Map(
      candidates.map((rule) => [rule.id, priorPushStatus(db, rule)] as const),
    );
    candidates.sort((left, right) =>
      comparePriority(left, right, pushStatuses),
    );
    const selectedIds = new Set(
      candidates.slice(0, TRIGGER_INDEX_SLOT_LIMIT).map((rule) => rule.id),
    );

    for (const rule of candidates) {
      const nextStatus = selectedIds.has(rule.id)
        ? pushStatuses.get(rule.id)!
        : "digest_only";
      if (rule.status === nextStatus) continue;
      store.update(rule.id, {
        status: nextStatus,
        updatedAtEpoch: options.createdAtEpoch,
        event: {
          eventUid: evictionEventUid(
            project,
            rule,
            nextStatus,
            options.createdAtEpoch,
          ),
          eventKind: nextStatus === "digest_only" ? "evicted" : "restored",
          rationale:
            nextStatus === "digest_only"
              ? "trigger index slot limit exceeded"
              : "trigger index slot became available",
        },
      });
    }

    const index = {
      version: 1 as const,
      rules: candidates
        .filter((rule) => selectedIds.has(rule.id))
        .map((rule) => ({
          id: rule.id,
          name: rule.name,
          claim: rule.claim,
          scope: rule.scope,
          trigger: rule.triggerSpec!,
        })),
    };
    return triggerIndexSchema.parse(index);
  });
}

/**
 * Compiles the one shared runtime file while preserving the spec's independent
 * `global + current project` ten-slot pools. The file is the deterministic
 * union of every pool; dispatchers filter by cwd and take the first ten before
 * matching an event, so rules from unrelated projects never compete.
 */
export function renderSharedTriggerIndex(
  db: Database,
  options: Pick<RenderTriggerIndexOptions, "createdAtEpoch">,
): TriggerIndex {
  return runWriteTransaction(db, () => {
    const store = createRuleStore(db);
    const candidates = store
      .list()
      .filter(
        (rule) =>
          rule.triggerKind !== "none" &&
          ["confirmed", "provisional", "digest_only"].includes(rule.status),
      );
    const pushStatuses = new Map(
      candidates.map((rule) => [rule.id, priorPushStatus(db, rule)] as const),
    );
    candidates.sort((left, right) =>
      comparePriority(left, right, pushStatuses),
    );

    const projects = Array.from(
      new Set(
        candidates
          .filter((rule) => rule.scope !== "global")
          .map((rule) => resolve(rule.scope)),
      ),
    ).sort();
    const pools = [
      candidates.filter((rule) => rule.scope === "global"),
      ...projects.map((project) =>
        candidates.filter(
          (rule) =>
            rule.scope === "global" || resolve(rule.scope) === project,
        )
      ),
    ];
    const selectedIds = new Set(
      pools.flatMap((pool) =>
        pool.slice(0, TRIGGER_INDEX_SLOT_LIMIT).map((rule) => rule.id)
      ),
    );

    for (const rule of candidates) {
      const nextStatus = selectedIds.has(rule.id)
        ? pushStatuses.get(rule.id)!
        : "digest_only";
      if (rule.status === nextStatus) continue;
      store.update(rule.id, {
        status: nextStatus,
        updatedAtEpoch: options.createdAtEpoch,
        event: {
          eventUid: evictionEventUid(
            "all-projects",
            rule,
            nextStatus,
            options.createdAtEpoch,
          ),
          eventKind: nextStatus === "digest_only" ? "evicted" : "restored",
          rationale:
            nextStatus === "digest_only"
              ? "trigger index slot limit exceeded"
              : "trigger index slot became available",
        },
      });
    }

    return triggerIndexSchema.parse({
      version: 1,
      rules: candidates
        .filter((rule) => selectedIds.has(rule.id))
        .map((rule) => ({
          id: rule.id,
          name: rule.name,
          claim: rule.claim,
          scope: rule.scope,
          trigger: rule.triggerSpec!,
        })),
    });
  });
}

export function serializeTriggerIndex(index: TriggerIndex): string {
  return `${JSON.stringify(triggerIndexSchema.parse(index), null, 2)}\n`;
}
