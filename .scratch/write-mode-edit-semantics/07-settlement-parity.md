# 07 — 结算子代理的工具与主 agent 完全一致,只多一个 commit

**What to build:** 结算子代理拿到的写工具与主 agent 相同——同一套 `write`/
`edit` 模式、同一个门——唯一的多余项是 `commit`。它不再是一个需要单独理解的写
面。

**Ruling base:** spec D12([S15069/T1056]:「结算 subagent 的工具和主 agent 一
致,不需要特殊对待,只多了一个 commit 工具」)。

**Blocked by:** 05(模式词汇必须先存在)。

**Status:** blocked

## Pinned decisions

- 结算的输入形状补上与主 agent 同一套 `mode`;`session` 字段的整覆盖行为改为经
  由 `write` 表达,而非一条隐式的独有路径。
- SDK 与提示词里的差异化措辞(「no append」一类)删除——它描述的差异已不存在。
- `commit` 保持原样:认领有效性检查、本轮写入计数、终态标记。它是唯一多出来的
  工具。
- 一致性要在**工具注册边界**上断言,不能只靠提示词文本比对——提示词说一致而注
  册不一致,正是这类回归最容易溜过去的地方。
- 归属(membership)那条独立的 wire surface 若与本条收敛冲突,**先报告再动**:
  它是 ADR-0002 划给结算的职责,不在本票的裁决范围内。

## Acceptance criteria

- [ ] 结算注册的写工具形状与主 agent 一致,差集恰为 `{commit}`,由测试断言而非
      人工比对。
- [ ] 结算的字段写入走同一套 `write`/`edit` 与同一个门。
- [ ] 提示词与 SDK 描述里不再有「no append」一类的差异化措辞。
- [ ] `commit` 行为不变,既有测试不改而绿。
- [ ] typecheck 干净;全套绿,只余既定的陈旧包守卫红。

## Ground rules

- NO git write commands。报出改动文件清单,主会话提交。
- **本票是 `src/worker/` 的例外**:结算面就在那里,允许改。仍不碰
  `~/.claude-mnemo/`、`plugin/scripts/`、版本号。
- 不自行重建 bundle(`node scripts/build.js` 属发版流程,不在票内)。
- 自己文件之外的瞬时红:窄范围重跑,绝不回滚工作树。
