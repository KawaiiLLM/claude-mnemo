import { resolve } from "node:path";

import type { Rule } from "../db/rules";
import { estimateDiaryTokens } from "../diary/domain";
import type { TriggerSpec } from "./schema";

export const RULE_DIGEST_TOKEN_BUDGET = 500;

const STATUS_PRIORITY: Readonly<Record<"confirmed" | "provisional" | "digest_only", number>> = {
  confirmed: 0,
  provisional: 1,
  digest_only: 2,
};

function describeTrigger(trigger: TriggerSpec | null): string {
  if (trigger === null) {
    return "由你根据规则正文中的条件自我匹配";
  }

  if (trigger.kind === "prompt") {
    const quantifier = trigger.match === "all" ? "全部" : "任一";
    return `用户请求包含${quantifier}关键词：${trigger.keywords.join("、")}`;
  }

  if (trigger.kind === "result") {
    const tool = trigger.tool ? `${trigger.tool} 的` : "工具";
    return `${tool}结果包含任一片段：${trigger.patterns.join("、")}`;
  }

  const conditions = [`调用 ${trigger.tool}`];
  if (trigger.require_param) conditions.push(`存在参数 ${trigger.require_param}`);
  if (trigger.param_absent) conditions.push(`缺少参数 ${trigger.param_absent}`);
  if (trigger.command_prefix) {
    conditions.push(`命令前缀为 ${trigger.command_prefix.join(" ")}`);
  }
  if (trigger.path_glob) conditions.push(`路径匹配 ${trigger.path_glob}`);
  return conditions.join("，且");
}

function statusLabel(status: Rule["status"]): string {
  if (status === "confirmed") return "已确认";
  if (status === "provisional") return "待验证";
  return "摘要规则";
}

function renderItem(rule: Rule): string {
  const scope = rule.scope === "global" ? "所有项目" : "仅当前项目";
  return `- [${statusLabel(rule.status)}] **${rule.name}** — 适用范围：${scope}；情境：${describeTrigger(rule.triggerSpec)}；规则：${rule.claim}`;
}

function compareRules(left: Rule, right: Rule): number {
  const statusDelta =
    STATUS_PRIORITY[left.status as keyof typeof STATUS_PRIORITY] -
    STATUS_PRIORITY[right.status as keyof typeof STATUS_PRIORITY];
  if (statusDelta !== 0) return statusDelta;
  if (left.lastEvidenceAtEpoch !== right.lastEvidenceAtEpoch) {
    return right.lastEvidenceAtEpoch - left.lastEvidenceAtEpoch;
  }
  return left.id - right.id;
}

export function renderRuleDigest(input: {
  rules: readonly Rule[];
  project?: string;
  tokenBudget?: number;
}): string {
  const project = input.project ? resolve(input.project) : null;
  const candidates = input.rules
    .filter(
      (rule): rule is Rule & { status: "confirmed" | "provisional" | "digest_only" } =>
        ["confirmed", "provisional", "digest_only"].includes(rule.status) &&
        (rule.triggerKind === "none" || rule.status === "digest_only") &&
        (rule.scope === "global" ||
          (project !== null && resolve(rule.scope) === project)),
    )
    .sort(compareRules);

  if (candidates.length === 0) return "";

  const budget = input.tokenBudget ?? RULE_DIGEST_TOKEN_BUDGET;
  const lines = ["## Rule Digest"];
  for (const rule of candidates) {
    const candidate = [...lines, "", renderItem(rule)].join("\n");
    if (estimateDiaryTokens(candidate) > budget) break;
    lines.push("", renderItem(rule));
  }

  return lines.length > 1 ? lines.join("\n") : "";
}
