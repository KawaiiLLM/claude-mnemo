# 06 — 渲染端指针行去重

**What to build:** 注入文档的溢出指针从「每节一条」收敛为「文档末尾一条」，仅当某节的溢出目标与文档级目标不同时保留节级指针，消除同一目标重复出现多次的 token 浪费。

**Blocked by:** None — can start immediately.

**Status:** implemented

## 设计决定（见 ../spec.md「渲染端」）

1. 现状：`renderPersonaDocumentInjection` 为每个被截断的节各产生一行 `（本节还有 N 行，完整见 <displayPath>）`，同一 displayPath 在一份文档里重复 4 次约 80 token（S1730 实测）。
2. 目标行为：同一 displayPath 的节级指针合并为文档末尾一条（如「（其余 N 行省略，完整见 <displayPath>）」，N 为各节省略行数之和）；节级指针仅在其目标与文档级目标不同时保留。
3. 既有调用方（persona、experience、sessions）的指针目标语义不变，只改重复展示；三路拆分的既有断言按新行为更新。

## 关键文件

- `src/diary/persona-render.ts` — `renderPersonaDocumentInjection`、`sectionPointer`
- `tests/hooks/context.diary.test.ts`、`tests/diary/` — 受影响断言

## 约束

- 不执行任何 git 命令；只编辑文件。
- 不做版本号变更、不重建 plugin/scripts/*.cjs（stale-bundle 守卫 1 fail 是预期基线）。
- 不触碰 ~/.claude-mnemo 下的任何线上数据。
- `bunx tsc --noEmit` 通过；`bun test` 相对基线（928 pass / 1 fail）不回退。

## Acceptance criteria

- [x] 多节被截断且目标相同时，输出只含一条文档级指针（含省略总行数）
- [x] 节级目标与文档级不同时，该节保留节级指针
- [x] 预算语义不变：指针行计入预算、降级路径（骨架/H1/单指针）不回退
- [x] 既有测试按新行为更新后全部通过

## Comments

- `renderPersonaDocumentInjection` 现在汇总所有指向文档级目标的省略行，并在文档末尾输出唯一的 `（其余 N 行省略，完整见 …）`；可选 `sectionDisplayPaths` 让目标不同的节继续就地输出节级指针。
- 保留原有“完整内容 → 含标题骨架与指针 → H1 + 文档指针 → 单指针”预算降级路径，所有指针仍参与 `estimateDiaryTokens` 计量。
- 验证：`bun test tests/diary/persona-render.test.ts tests/hooks/context.test.ts tests/hooks/context.diary.test.ts` 为 29 pass / 0 fail；`bunx tsc --noEmit` 通过。全量基线与最终回归统一在票 04 完成后执行。
- code review 补强：极限 H1/单行 fallback 现在也保留异质节目标；新增回归后 Standards 与 Spec 复核均无残余 finding。
- 最终本泳道联合回归（票 06 + 04 的 7 个相关测试文件）为 46 pass / 0 fail。最终全量为 942 pass / 4 fail：除预期 stale-bundle 外的 3 fail 均是并行票 03 的 grade 必填测试夹具尚未同步，不涉及本票。
- 偏差：无。
