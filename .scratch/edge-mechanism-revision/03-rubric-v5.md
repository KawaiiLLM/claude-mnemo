# 03 — Rubric v5 定稿入库,Policy 并入

**What to build:** 共享判断文本换 v5:四节重组、脱钩声明、删边检验、并列补相、
发布仪式;Memory Policy 独立块退役并入;两个消费面逐字节一致照旧由 hash 守卫钉住。

**Ruling base:** spec D5;定稿文本 = 同目录 `rubric-v5-draft.md` 正文段(评审
记录与变更清单不入库);[S15069/T1121](peer 三必改)、[S15069/T1124](Policy
中性末句)。

**Blocked by:** None — can start immediately(纯文本与守卫,不依赖边机制)。

**Status:** ready-for-agent

## Pinned decisions

- `MEMORY_RUBRIC_TEXT` 整体替换为草案「# Memory Rubric v5」以下正文,**逐字使
  用,一个字都不要改**;版本号 v5;hash 重算。有异议回来报告,不要「改进」。
- `MEMORY_POLICY_TEXT`/`MEMORY_POLICY_VERSION`/`renderMemoryPolicyBlock` 退役:
  Policy 已是 rubric 的 `## Policy` 节。注入组装器删除独立 Policy 槽;结算提示
  词无需新增(共享文本自带)。
- review 词条的改写(「本轮产生或否定裁决时,按并列补相加 design/correction」)
  随正文一起进来——它在词表里,属于同一份文本。
- hash 守卫测试更新至新常量;双渲染逐字节断言机制不变。
- 文档头注释追加 v4→v5 变更记录,沿用该文件既有的版本编年体例。

## Acceptance criteria

- [ ] `MEMORY_RUBRIC_TEXT` 与草案正文逐字一致(含四节序、并列补相、删边检验、
      首发布合法根、中性 Policy 末句)。
- [ ] Policy 独立块的常量与渲染函数不复存在;其唯一消费点改走 rubric。
- [ ] hash 守卫测试对两个消费面渲染断言一致且绿。
- [ ] 注入组装器输出不再含独立 `<mnemo-memory-policy>` 标签。
- [ ] typecheck 干净;全套绿,只余既定的陈旧包守卫红。

## Ground rules

- NO git write commands。报出改动文件清单,主会话提交。
- 不碰 `~/.claude-mnemo/`、`plugin/scripts/`、版本号、`src/worker/`(结算提示
  词的专款重写在票 04,本票只保证共享文本可达)。
- 不自行重建 bundle。
