# 02 — 维护节奏只剩一条:连续 20 turn 没动过段字段才提醒

**What to build:** 段维护回执不再因为「写得太勤」而提示。唯一保留的提醒是:连
续 20 个 turn 完全没有更新过段的任何字段。回执仍然是建议性的,永不拒绝写入。

**Ruling base:** spec D13([S15069/T1057])。

**Blocked by:** none。

**Status:** ready-for-agent

## Pinned decisions

- 「不足 10 turn 又写 → 太频繁」整条退役,连同它的阈值常量与回执分支。
- `decisions` 的豁免**随之消失,不是被裁掉**——它原本只豁免那一句提示,该句退
  役后无处可豁免。移除按字段判断豁免的实参与形参。ADR-0002 那条
  「a lost ruling is the costliest loss」的理由也随之作废(文档补注在票 08)。
- 保留的 20-turn 提醒,口径是「连续 N 个 turn 内没有任何段字段更新」。若现行实
  现是「距上次维护的 turn 数」,按前一种口径改,并在报告里说明两者差在哪。
- 回执文案里不要留「太频繁」的残句,也不要把两条提醒合并成一句含糊的话。

## Acceptance criteria

- [ ] 连续密集写入不再出现「太频繁」文案。
- [ ] 连续 20 turn 无任何段字段更新后,下一次写入的回执带提醒;不足 20 turn 时
      不带。
- [ ] `decisions` 与其他字段的回执一致,不再有字段级差异。
- [ ] typecheck 干净;全套绿,只余既定的陈旧包守卫红。

## Ground rules

- NO git write commands。报出改动文件清单,主会话提交。
- 不碰 `~/.claude-mnemo/`、`plugin/scripts/`、版本号、`src/worker/`。
- 文档(ADR-0002)不在本票,留给票 08。
- 自己文件之外的瞬时红:窄范围重跑,绝不回滚工作树。
