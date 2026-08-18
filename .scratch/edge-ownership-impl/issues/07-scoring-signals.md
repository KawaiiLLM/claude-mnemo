# 07 — 计分信号层

**What to build:** 每 turn 可查询的边信号元组,供视图 spec 消费;不定权重、不碰渲染。

规范:`.scratch/turn-edge-mechanism/spec.md`「三条计分规则」+「不钉数值权重」。

- 信号:`overridden`(被 override 即真)、refines 超基线入度(入度−1,下限 0,按**来源阶段**分桶:决策/落地)、encodes 计数、depends-on 记录但不入信号。
- 查询层函数+测试,无任何渲染消费(消费是视图 spec 的验收,[S15069/T924])。

**Blocked by:** 01(词表与阶段派生)。

**Status:** ready-for-agent

- [ ] 链表基线图上全员零信号;加一条跨越式 refines 后仅该节点上升
- [ ] override 受害者 overridden=真
- [ ] encodes 计数与来源阶段分桶各一条构造性测试
- [ ] 无边图 = 全零(退化保证的信号层半边)
