# 01 — turn 显著度列与提取 agent 打分链路

**What to build:** 提取 agent 在每个 turn 摘要写入时给出 0–4 显著度等级并落库，且能随时修正先前 turn 的等级；每 10 turn 收到一次近 100 turn 的等级分布统计作校准参考。

**Blocked by:** None — can start immediately.

**Status:** implemented

## 设计决定（见 ../spec.md「五级显著度」）

1. turns 表新增等级列（INTEGER，NULL 允许，取值 0–4）。**新列而非新 status**；上线前 grep 现有 turn 查询，确认无隐式假设被破坏。
2. 提取 agent 工具 schema：turn 摘要输出新增必填等级字段（0–4，范围外拒绝）；新增可选 regrade 字段（目标 turn 引用 + 新等级），用于修正先前 turn。
3. 提示词载入 spec 的五级判据表（含实证例）与两条修正职能：(a) 误导降级——仅在亲眼看到证伪／回滚证据时修正，不得凭猜测改史；(b) 4 级唯一性——同弧线出现更佳代表时旧 4 降 3。
4. 每 10 turn（按 promptNumber 间隔）在提取提示词中插入一次近 100 turn 等级分布统计 + 参考基线；间隔 10 是为保住提示词前缀缓存。措辞明确为校准参考、不强制遵守——分布因会话性质而异，不得为凑分布改判。

## 关键文件

- `src/worker/processors.ts` — 提取 agent 提示词与工具处理
- `src/db/schema.ts` 及迁移路径 — turns 新列
- `tests/worker/` — 既有提取链路测试的先例

## 约束

- 不执行任何 git 命令（不 commit、不 branch、不 stash）；只编辑文件。
- 不做版本号变更、不重建 plugin/scripts/*.cjs（release-artifacts stale-bundle 守卫的 1 个失败是预期基线）。
- 不触碰 ~/.claude-mnemo 下的任何线上数据。
- `bunx tsc --noEmit` 通过；`bun test` 相对基线（928 pass / 1 fail，唯一失败为 stale-bundle 守卫）不回退。

## Acceptance criteria

- [x] 新 turn 摘要写入后等级落库；范围外等级被 schema 拒绝
- [x] regrade 可更新任意先前 turn 的等级，且不影响该 turn 其余字段
- [x] 分布统计只在间隔 turn 的提示词中出现，含近 100 turn 统计与基线、校准参考措辞
- [x] 提示词含五级判据与两条修正职能
- [x] 既有测试不回退

## Comments

- turns 新增 nullable `significance_grade`（fresh schema + forward migration，DB CHECK 约束 0–4），`TurnRecord.significanceGrade` 与 `remember.grade` 完成落库贯通；新 active/provisional turn 缺 grade 会被写入 handler 拒绝。
- `remember.regrade` 采用 `{ id: "T<n>", grade }`，只允许当前 turn 所在 session 的先前 turn；写入仅更新目标等级，保留其余字段。
- worker 固定提示词加入五级判据、S1730 实例、误导降级与 4 级唯一性；每个 promptNumber 为 10 的倍数时，批次提示词加入此前最多 100 turn 的实际分布与非配额基线。
- 定向验证：118 pass（schema/remember/processors/query-session）+ 95 pass（agent-session/definitions/turns/server）；`bunx tsc --noEmit` 通过。完整套件留在三票完成后的统一验收运行。
- 偏差：无。
