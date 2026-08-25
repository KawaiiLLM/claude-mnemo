# 04 — 删掉节点死亡:全局否决、valid、E5、自引

**What to build:** 模型里不再有「节点被杀死」这回事。随之消失的是候选资格排除、`dead`、`lastDeclarer`、`valid`、单 source/单 sink 的阻断性错误,以及整条自引规则 —— 控制台与渲染器也不再讲这些概念。

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] 里程碑候选资格排除整条删除。今天有 18 个存活 turn 靠它被排除,删除后它们重新入选,要有一条测试钉住这个变化而不是让它悄悄发生。
- [ ] `dead` / `lastDeclarer` / `valid` 从 lane 状态与选举中消失;tier ② 由「closed-valid 终点」变为「closed 终点」;`open-last-declarer` 这个席位不再出现,单独一条测试钉它。
- [ ] E5(单 source / 单 sink)删除 —— 它今天还在阻断提交,强制的却是 v11 已经删掉的一句话。
- [ ] 自引规则整条删除:一条边的两端必须是不同节点。全库唯一那条自引边由迁移撤回(可在本票内完成)。
- [ ] **控制台不是不变的**:它的载荷仍在公开 `validity` / `lastDeclarer`,并逐 turn 公开 `dead`,渲染器仍输出 closed-valid/invalid。删字段、改契约,不重新设计 UI,但必须同批完成,否则控制台继续讲旧模型。
- [ ] 每一处删除都有一条 grep 哨兵,防止它以另一个名字回来。

**File ownership:** 选举、lane 状态归约、checker 的错误类与渲染器、控制台载荷与前端。**不碰**词表与写入判定(票 02)。
