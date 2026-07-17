# 03 — 计分融合：等级驱动里程碑基础分

**What to build:** timeline 里程碑选择的基础分由 turn 的显著度等级提供，等级缺失的旧 turn 回退 type 查表；corrector 晋升与互引入度作为结构修正层原样保留。

**Blocked by:** 01 — turn 显著度列与提取 agent 打分链路。

**Status:** implemented

## 设计决定（见 ../spec.md「计分融合」）

1. 等级只替换基础分（现由 MILESTONE_BASE_SCORE type 查表得出的部分）：等级管「turn 本身多重要」，结构层管「后续历史如何改写它」，两者正交。
2. NULL 等级 → type 查表回退，无需回填历史 turn；同一会话内两种来源的基础分可共存竞争。
3. 等级到基础分的映射保持与既有 type 分值同量纲（避免新旧 turn 竞争失衡）；映射常量集中一处、可调。
4. corrector 晋升、互引入度、adaptive budget 的既有逻辑与常量一律不动。
5. 0.2.38 校准的私有 dump 重验由调用方在验收阶段执行，不在本票范围；本票以构造测试证明行为可控。

## 关键文件

- `src/mcp/timeline.ts` — `MILESTONE_BASE_SCORE`、`milestoneWeightedScore`（约 653、694 行）
- `tests/mcp/` — 既有加权选择测试的先例

## 约束

- 不执行任何 git 命令；只编辑文件。
- 不做版本号变更、不重建 plugin/scripts/*.cjs（stale-bundle 守卫 1 fail 是预期基线）。
- 不触碰 ~/.claude-mnemo 下的任何线上数据。
- `bunx tsc --noEmit` 通过；`bun test` 相对基线（928 pass / 1 fail）不回退。

## Acceptance criteria

- [x] 构造带等级的 turn 集：高等级低 type 分的 turn 战胜低等级高 type 分的 turn
- [x] NULL 等级 turn 的选择结果与改动前一致（回退路径回归）
- [x] corrector 晋升与互引入度行为不变（既有相关测试不回退）
- [x] 映射常量集中可调；既有测试不回退

## Comments

- `src/mcp/timeline.ts` 新增集中可调的 `MILESTONE_GRADE_BASE_SCORE`，0–4 级映射到既有基础分同量纲的 0–4；有等级时 `milestoneBaseScore` 直接使用等级基础分，不再受 type 或 deliverable 文件门槛影响。
- `significance_grade IS NULL` 时完整回退原 `MILESTONE_BASE_SCORE` type 查表，包括 feature/refactor/change 无修改文件时基础分为 0 的旧行为，无需历史回填。
- 仅替换 `milestoneWeightedScore` 所消费的基础分来源；corrector 的 always-keep 晋升、被纠正受害者降级、互引入度加分、citation cap 与 adaptive day budget 均未修改。
- 构造测试覆盖 4 级 discovery 战胜 1 级 decision，并断言保留项得分；另以 NULL grade 覆盖 decision/feature 及 deliverable 文件门槛回退。
- 定向验证：`tests/mcp/timeline.test.ts`、`tests/hooks/milestone-injection.test.ts`、`tests/hooks/context-milestones.test.ts` 共 177 pass / 0 fail；全量 `bun test` 为 951 pass / 1 fail，唯一失败是按约束未重建 bundle 的 stale-bundle 守卫；`bunx tsc --noEmit` 通过。
- 偏差：按票面约定未运行 0.2.38 私有 dump 对照（由调用方验收）；未改 timeline 渲染函数、corrector/互引入度/adaptive budget 逻辑或常量。
