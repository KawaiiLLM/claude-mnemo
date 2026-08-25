# 01 — 迁移编排次序:注册表迁移先于任何边 schema 改动

**What to build:** 升级一个已有数据库时,lane-declaration 的注册表迁移(M0–M4)完整跑完并写下自己的收据之后,才轮到任何 v12 的边 schema 改动;全新数据库直接建成目标形状,旧迁移不运行,并在收据里显式标记「不适用」。

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

今天 `initializeSchema` 先跑 `ensureMemoryEdgesSchema`、最后才跑 `runLaneRegistryMigration`,而后者的 M0/M2 读的正是 `memory_edges.tags`。票 05 一旦把那一列改掉,整个未发版的 lane-declaration 批次会在同一次首次打开里当场失效。**这张票今天不改变任何行为**,存在的理由是给后面的列改造一个合法的位置。

- [ ] 升级路径:注册表迁移在边 schema 改动之前完成,并有测试用一个「旧形状 + 有待迁移边」的夹具证明它读到了它需要的数据。
- [ ] 全新库路径:注册表迁移不运行,收据里有一行显式的「不适用」,而不是缺一行。
- [ ] 两条路径各做一次 failpoint 重启测试:中途崩溃后重开,状态一致、不重复执行。
- [ ] 现有全部迁移测试保持绿;本票不引入任何可观察的行为变化,并有一条测试钉住这一点。
