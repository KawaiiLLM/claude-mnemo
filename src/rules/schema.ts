import { z } from "zod";

export const TRIGGER_INDEX_SLOT_LIMIT = 10;

const nonEmptyString = z.string().min(1);

export const promptTriggerSpecSchema = z
  .object({
    kind: z.literal("prompt"),
    keywords: z.array(z.string().min(3)).min(1).max(8),
    match: z.enum(["any", "all"]).default("any"),
  })
  .strict();

export const toolTriggerSpecSchema = z
  .object({
    kind: z.literal("tool"),
    tool: nonEmptyString,
    require_param: nonEmptyString.optional(),
    param_absent: nonEmptyString.optional(),
    command_prefix: z.array(nonEmptyString).min(1).max(4).optional(),
    path_glob: nonEmptyString.optional(),
  })
  .strict();

export const resultTriggerSpecSchema = z
  .object({
    kind: z.literal("result"),
    tool: nonEmptyString.optional(),
    patterns: z.array(z.string().min(1).max(64)).min(1).max(4),
  })
  .strict();

export const triggerSpecSchema = z.discriminatedUnion("kind", [
  promptTriggerSpecSchema,
  toolTriggerSpecSchema,
  resultTriggerSpecSchema,
]);

export type TriggerSpec = z.infer<typeof triggerSpecSchema>;
export type TriggerKind = TriggerSpec["kind"] | "none";

export const ruleStatusSchema = z.enum([
  "provisional",
  "confirmed",
  "refuted",
  "retired",
  "digest_only",
]);
export type RuleStatus = z.infer<typeof ruleStatusSchema>;

export const ruleEvidenceSchema = z
  .object({
    ref: nonEmptyString,
    note: nonEmptyString,
    at: z.number().int().nonnegative(),
  })
  .strict();
export type RuleEvidence = z.infer<typeof ruleEvidenceSchema>;

export const triggerIndexRuleSchema = z
  .object({
    id: z.number().int().positive(),
    name: nonEmptyString,
    claim: z.string().min(1).max(300),
    scope: nonEmptyString,
    trigger: triggerSpecSchema,
  })
  .strict();

export const triggerIndexSchema = z
  .object({
    version: z.literal(1),
    // The shared file is a union of independent per-project pools. Runtime
    // dispatch filters to global + cwd and then enforces the ten-slot cap.
    rules: z.array(triggerIndexRuleSchema),
  })
  .strict();

export type TriggerIndex = z.infer<typeof triggerIndexSchema>;
