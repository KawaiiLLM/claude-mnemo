# 01 — 退役词离开枚举

**What to build:** 结算 agent 与主 agent 在工具 schema 里只看得见还能用的值。`note` 的 `mode`
不再声明 `overwrite`/`append`,`remember` 的 verb 不再声明 `append`/`replace`/`assign`。
描述里**不解释**这些词退役了——一个模型看不见的词,不需要向它介绍。

对应 spec:`.scratch/settlement-ergonomics/spec.md` D1。

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] 两个枚举里都不再出现退役字面量,描述文本里也没有它们的名字
- [ ] 既有的「拒绝并指名替代品」测试改为断言 schema 层就不接受(方向反过来,不是删掉)
- [ ] 结算侧共用 `noteInputShape.mode`,所以它的 schema 同步收窄——加一条断言钉住这个共用关系
- [ ] 已删掉的**参数级**退役(`topic`/`truncate`/`view`)保持原样,不受影响
- [ ] 突变:把任一退役字面量加回枚举,必须有测试变红
