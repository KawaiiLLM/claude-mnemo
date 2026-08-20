# 04 — 结算重武装:50 窗、全笔记权限、造边撤边、提示词重写

**What to build:** 结算子代理成为 50-turn 窗口上的「后见之明的主 agent」:窗内
全部笔记内容可改、可建段跨段改派、可造边撤边,同门同要求;提示词由共享 Rubric
v5 + 重写后的结算专款组成。

**Ruling base:** spec D6、D7;[S15069/T1113](三裁)、[S15069/T1124](建段与
跨段改派)。**显式回收** ownership-and-note-cadence 批次「结算不再重建笔记」的裁决。

**Blocked by:** 01、02、03。

**Status:** blocked

## Pinned decisions

- consecutive 触发阈值 25→50;其余触发器(compact/residual/sessionend/backfill)
  事件语义不变。
- facade 对 title/content/insight 的硬拒撤销:三字段走与主 agent 同一套
  write/edit 模式与门。**同门同要求**:结算上下文渲染须记 field completeness
  (关闭 write-mode 票 07 记录的豁免口);渲染在上下文里的字段完整时天然满足,
  截断时结算与主 agent 同样被拒。
- 归属动作开放:结算的 remember 面获得建段与跨段改派;值域限制(该会话已挂靠
  段∪无归属)删除。「只纠显性失配、存疑不动」保留在共享 rubric 段节,不在代码。
- 边动作 = 票 02 的同一套原语:纯关系写、撤边;C7 先存栅栏
  (`eligibleRelationPairKeys` 快照及其检查)删除。
- 提示词重写:共享 Rubric v5 之外的结算专款 = 任务框架(后见之明,检查或重建
  窗内边与笔记;补结算从零重建)+ 权限声明 + 程序款(调和:补缺/纠错/撤伪)+
  commit 终检。删除先存栅栏措辞与一切残留差异化语言。
- 注册面奇偶性测试**不改而绿**:差集仍恰为 `{commit}`。commit 行为不变。

## Acceptance criteria

- [ ] 结算写 title/content/insight 成功,且被同一套门拦截(截断/失效/未授权三
      种拒绝可复现)。
- [ ] 结算建段、跨段改派成功;旧值域拒绝路径不复存在。
- [ ] 结算纯关系写与撤边走 02 原语;先存栅栏代码与快照删除,全仓 grep 无存活。
- [ ] consecutive 在第 50 个完结 turn 触发,49 不触发。
- [ ] 奇偶性测试不改而绿;commit 既有测试不改而绿。
- [ ] 提示词测试断言:含共享 rubric hash、含后见之明任务框架、不含先存栅栏与
      「no append」类残留。
- [ ] typecheck 干净;全套绿,只余既定的陈旧包守卫红。

## Ground rules

- NO git write commands。报出改动文件清单,主会话提交。
- **本票是 `src/worker/` 的例外**:结算面就在那里。仍不碰 `~/.claude-mnemo/`、
  `plugin/scripts/`、版本号(`note-settlement-sdk-query.ts` 里的版本常量原样)。
- 不自行重建 bundle。变异候选:completeness 记录、50 阈值、栅栏删除。
