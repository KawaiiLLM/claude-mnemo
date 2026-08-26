# 06 — `delete` 两级统一,`undeclare` 退役

**What to build:** 空容器可以删掉。**54 个既无成员也无泳道的历史空段**因此可以从 console 里消失。

对应 spec:D4。

**Blocked by:** 05(create 统一)

**Status:** ready-for-agent

- [ ] 任务:无成员(按归属口径)**且**无已声明泳道才删;两个分支各一条拒绝用例
- [ ] 泳道:无成员 turn 携带它的 tag 才删(继承 undeclare 今天的守卫)
- [ ] 非空时拒绝,**报出数量并指出两条出路**(merge 改归属 / clear 去归属)
- [ ] `delete` **没有 force**——强删活容器是用错动词,不是需要警告的操作
- [ ] 判据在写事务内重查
- [ ] 突变:去掉「无泳道」这半个判据,必须有测试变红
