/**
 * The shared `type` vocabulary (spec D5). One word list serves both levels: a
 * turn's type and a segment's type (the union of its members'), so recall's
 * `type:` filter means the same thing whichever granularity it lands on.
 *
 * `rolled-back` (spec's 回退) is in the vocabulary but NOT reachable from the
 * mechanical draft path: "this conclusion was later overturned" is hindsight,
 * and hindsight is the settlement pass's job. `draftTypeFromTitle` can never
 * return it, and `normalizeTypeValues` rejects it unless the caller declares
 * itself the settlement writer.
 */

export const MEMORY_TYPES = [
  "research",
  "design",
  "implement",
  "fix",
  "measure",
  "review",
  "write",
  "ops",
  "chat",
  "rolled-back",
] as const;

export type MemoryType = (typeof MEMORY_TYPES)[number];

/** The value a title matched no alias for. Never a claim, always a gap. */
export const UNKNOWN_TYPE = "unknown";

export type DraftType = MemoryType | typeof UNKNOWN_TYPE;

export const TYPE_GLYPH: Record<MemoryType, string> = {
  research: "🔍",
  design: "⚖️",
  implement: "🔧",
  fix: "🔴",
  measure: "📊",
  review: "✅",
  write: "✍️",
  ops: "⚙️",
  chat: "💬",
  "rolled-back": "↩️",
};

export function isMemoryType(value: unknown): value is MemoryType {
  return (
    typeof value === "string" &&
    (MEMORY_TYPES as readonly string[]).includes(value)
  );
}

/**
 * Title-prefix aliases, longest-match-wins at lookup time.
 *
 * These are PREFIXES of a note title, not free-text keywords: the writing
 * discipline (D5) is that a title opens by naming what the turn was doing
 * ("修复 X 的竞态", "Investigate the stall"), so the first word carries the
 * function. Matching anywhere in the title would let "调研如何修复" resolve to
 * two types by accident of word order.
 *
 * `rolled-back` deliberately has NO aliases: no prefix can mint it.
 */
const TYPE_ALIASES: Record<Exclude<MemoryType, "rolled-back">, string[]> = {
  research: [
    "research", "investigate", "explore", "survey", "study", "analyze",
    "analyse", "diagnose", "调研", "研究", "排查", "分析", "探索", "诊断",
  ],
  design: [
    "design", "spec", "plan", "propose", "decide", "evaluate", "compare",
    "设计", "方案", "规划", "选型", "评估", "对比", "定案", "裁决",
  ],
  implement: [
    "implement", "add", "build", "create", "introduce", "wire", "ship",
    "support", "实现", "新增", "构建", "接入", "落地", "上线", "补全",
  ],
  fix: [
    "fix", "repair", "resolve", "correct", "patch", "harden", "hotfix",
    "修复", "修正", "解决", "纠正", "加固", "止血",
  ],
  measure: [
    "measure", "benchmark", "profile", "count", "verify", "test", "validate",
    "度量", "测量", "统计", "基准", "验证", "实测", "压测",
  ],
  review: [
    "review", "audit", "check", "inspect", "assess", "critique",
    "评审", "审查", "复核", "核对", "检查", "审计",
  ],
  write: [
    "write", "document", "draft", "record", "summarize", "note", "explain",
    "撰写", "编写", "记录", "文档", "总结", "起草", "说明",
  ],
  ops: [
    "ops", "release", "deploy", "publish", "migrate", "upgrade", "bump",
    "configure", "clean", "发版", "发布", "部署", "迁移", "升级", "配置",
    "清理", "运维",
  ],
  chat: [
    "chat", "discuss", "ask", "answer", "reply", "clarify",
    "闲聊", "讨论", "询问", "回答", "澄清",
  ],
};

interface AliasEntry {
  alias: string;
  type: MemoryType;
}

// Longest first: "研究" must not shadow a longer alias that starts with it, and
// "add" must not win over a hypothetical "address".
const SORTED_ALIASES: AliasEntry[] = Object.entries(TYPE_ALIASES)
  .flatMap(([type, aliases]) =>
    aliases.map((alias) => ({ alias: alias.toLowerCase(), type: type as MemoryType })),
  )
  .sort((left, right) => right.alias.length - left.alias.length);

/**
 * ASCII aliases must end at a word boundary — "addendum" is not "add" — while a
 * CJK alias has no boundary character to look for and matches on the prefix
 * alone ("修复竞态" is a `fix`).
 */
function matchesPrefix(title: string, alias: string): boolean {
  if (!title.startsWith(alias)) {
    return false;
  }
  const nextCharacter = title.charAt(alias.length);
  if (nextCharacter === "") {
    return true;
  }
  if (/[a-z0-9]/.test(alias.charAt(alias.length - 1))) {
    return !/[a-z0-9]/.test(nextCharacter);
  }
  return true;
}

/**
 * The birth-time type draft (spec D5): a mechanical guess so the recent-work
 * rendering is not blank until settlement runs. Matching nothing is `unknown`,
 * never a guess — a wrong glyph costs more than a missing one, and settlement
 * is what fills it in.
 */
export function draftTypeFromTitle(title: string | null | undefined): DraftType {
  if (!title) {
    return UNKNOWN_TYPE;
  }

  const normalized = title.normalize("NFKC").trimStart().toLowerCase();
  if (!normalized) {
    return UNKNOWN_TYPE;
  }

  for (const entry of SORTED_ALIASES) {
    if (matchesPrefix(normalized, entry.alias)) {
      return entry.type;
    }
  }

  return UNKNOWN_TYPE;
}

export type TypeWriteSource = "draft" | "settlement";

export class RestrictedTypeError extends Error {
  constructor(public readonly value: string) {
    super(
      `type '${value}' is settlement-only: it is a hindsight judgement and cannot be written by the mechanical path`,
    );
    this.name = "RestrictedTypeError";
  }
}

/**
 * Validate and de-duplicate a multi-value type list, order-preserving.
 *
 * Throws on an unknown word (a typo silently dropped would make `type:` filters
 * quietly lossy) and on `rolled-back` from a non-settlement writer.
 */
export function normalizeTypeValues(
  values: readonly string[],
  source: TypeWriteSource = "draft",
): MemoryType[] {
  const normalized: MemoryType[] = [];

  for (const raw of values) {
    const value = raw.trim();
    if (!value) {
      continue;
    }
    if (!isMemoryType(value)) {
      throw new Error(`unknown type value: ${raw}`);
    }
    if (value === "rolled-back" && source !== "settlement") {
      throw new RestrictedTypeError(value);
    }
    if (!normalized.includes(value)) {
      normalized.push(value);
    }
  }

  return normalized;
}
