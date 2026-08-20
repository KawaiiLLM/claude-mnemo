# 06 — timeline 不渲染 rewind 与 skip 的行

**What to build:** 时间线里不再出现被回卷(rewind)的 turn,也不再出现记笔记时
被判为无须记录(skip)的 turn。它们不是「渲染成灰色」或「带个标记」,是**根本不
出现在行里**。

**Ruling base:** [S15069/T1084]。

**Blocked by:** none(票 05 已落地,`d96708c`)。

**Status:** ready-for-agent

## Pinned decisions

- 两个排除条件,各有其列,不要混:
  - **rewind** = `turns.was_rolled_back = 1`
  - **skip** = `turns.status = 'skipped'`
- 排除发生在**选取**这一层,不在渲染这一层。被排除的 turn 不占页预算、不参与
  里程碑选举、不影响相邻行的 gap 计算——它们对时间线不存在。
- **`REWIND_MARKER` 在 timeline 侧随之成为死代码**,应移除其 timeline 用法。
  但 **recall 侧保留**:金样例在 recall 的行上钉着 `[rewind]`,两个面有意分歧
  (票 05 已据此判过一次)。不要顺手删共享常量本身。
- **`status = 'undone'` 不在本票范围内。** 裁决只点名了 rewind 与 skip;undone
  是第三种状态(sidechain 出生即标记),语义不同。**不要顺手一起排除**,要动另
  行裁决。
- 未结算的 turn(尚无笔记、也未 skip)**照常渲染**,行标签走 title 缺失时的
  prompt 回退——票 05 的回退规则因此仍有唯一的活用例。

## Acceptance criteria

- [ ] `was_rolled_back = 1` 的 turn 不出现在 `turns` 视图,也不出现在
      `milestones` 视图。
- [ ] `status = 'skipped'` 的 turn 同样两个视图都不出现。
- [ ] 被排除的 turn 不占页预算:同一页能多容纳相应数量的其他 turn。
- [ ] 被排除的 turn 不参与里程碑选举(即使它带着边)。
- [ ] `status = 'undone'` 的 turn **仍然渲染**——本票不碰它。
- [ ] 未结算 turn 照常渲染,标签回退到 prompt。
- [ ] recall 的输出不受影响,其金样例夹具不改而绿(含 `[rewind]` 那条)。
- [ ] typecheck 干净;全套绿,只余既定的陈旧包守卫红。

## Ground rules

- NO git write commands。报出改动文件清单,主会话提交。
- 不碰 `~/.claude-mnemo/`、`plugin/scripts/`、版本号、`src/worker/`。
- 不要自行重建 bundle。
- `src/mcp/recall.ts` 与 `src/mcp/format.ts` 只读不改;若必须改,回来报告。
