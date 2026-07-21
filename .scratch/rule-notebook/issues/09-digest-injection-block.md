# 09 — C 层摘要：SessionStart 新增独立区块

**What to build:** 纯加法的注入侧：`trigger_kind:"none"` 与 `digest_only` 规则渲染为摘要文档（适用条件写给读者，措辞锐利到可自我匹配），作为 SessionStart 注入的一个**新增独立区块**，独立预算 500 token，不挤占 RecentSessions + DiaryIndex 共享池。现有注入不含任何 experience 内容，本票不涉及任何替换或退役语义。

**Blocked by:** 02

**Status:** done

- [x] 摘要渲染：只含 none/digest_only 规则，confirmed 排序在前，超预算截断有确定性规则
- [x] SessionStart 注入出现新区块且不影响既有区块内容与预算（既有注入测试回归全绿）
- [x] 无规则时区块整体缺省（不注入空标题）
- [x] 500 token 预算上限有测试

## Comments

- Implemented `src/rules/digest.ts` with scope-aware filtering, human-readable
  applicability conditions, stable ordering, deterministic item-by-item
  truncation, and an independent 500-token budget.
- Registered a fifth, read-only `context digest` SessionStart hook. The block is
  omitted completely when no rule qualifies and does not share Persona or
  RecentSessions + DiaryIndex budgets.
- Verification: `bun run build`; `bun test` (1123 pass, 0 fail);
  `bunx tsc --noEmit` (pass). Two-axis review: Standards pass (0 hard findings),
  Spec pass (0 findings).
