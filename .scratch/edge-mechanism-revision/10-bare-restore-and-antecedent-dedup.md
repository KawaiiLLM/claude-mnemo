# 10 — 撤边补回 bare 行;timeline 前情按被引去重(终审必改 3、4)

**What to build:** 撤掉一对 turn 的最后一条关系时,若 citing turn 的正文仍提及
被引方,bare 行按当前正文补回——`↳`/被引计数不再因撤边蒸发。timeline 的前情
行按 (citing, cited) 去重,同对多关系不再渲染 `↳ T1 T1`。

**Ruling base:** peer 终审必改 3、4;dba77d2 的收窄本身被判正确,漏的是与
「关系写取代 bare」「硬删」的三方组合。

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

## Pinned decisions

- 补回时机:撤边路径(`retractTurnRelations` 层,turn 对 turn)在删除后检查
  该对是否已无任何行;是则重扫 citing turn 的 title/content/insight
  (`parseQualifiedReferences` 现成),正文仍名此靶 → 以 provenance `text-ref`
  补回 bare 行。**不采用**「bare 与 relation 常态并存」——那会反转票 01 的
  一事实一行去重,读者行数翻倍。
- 段/会话作 citing 方的撤边同理对待;无正文可扫的构造(如机械锚)自然不补。
- timeline:病灶在前情聚合(约 3811–3862 行,`SELECT DISTINCT citing_id,
  cited_id, relation` 后逐行 push)。在渲染聚合层按 (citingId, citedId) 去重;
  relation 明细保留给纠错旗判断(⚑ 逻辑不得回归)。cap 与 `+N` 按去重后的数量
  消耗。
- **不碰计分**(D10 仍然有效):edge-signals 零改动。

## Acceptance criteria

- [ ] 复现链转回归:正文提及→bare;写关系→bare 被取代;撤该关系→bare 回来,
      `↳`/被引计数不变。
- [ ] 正文不提及时撤最后一条关系→对消失(现行为,钉住)。
- [ ] 同对双关系在 timeline 前情里渲染一次;⚑ 纠错旗行为不变;cap/+N 按去重计。
- [ ] `edge-signals.ts` 与既有计分测试零改动。
- [ ] typecheck 干净;全套绿,只余既定的陈旧包守卫红。

## Ground rules

- NO git write commands。报出改动文件清单,主会话提交。
- 只碰 `src/db/citations.ts`、`src/db/memory-edges.ts`、`src/mcp/timeline.ts`
  及对应测试;note.ts / worker/ / format.ts 有并行 worker,只读;若撤边补回需
  要 facade 侧配合,回来报告。
- 不碰 `~/.claude-mnemo/`、`plugin/scripts/`、版本号;不重建 bundle。
