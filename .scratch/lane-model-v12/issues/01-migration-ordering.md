# 01 — 迁移编排次序:注册表迁移先于任何边 schema 改动

**What to build:** 升级一个已有数据库时,lane-declaration 的注册表迁移(M0–M4)完整跑完并写下自己的收据之后,才轮到任何 v12 的边 schema 改动;全新数据库直接建成目标形状,旧迁移不运行,并在收据里显式标记「不适用」。

**Blocked by:** None — can start immediately.

**Status:** done (未发版)

今天 `initializeSchema` 先跑 `ensureMemoryEdgesSchema`、最后才跑 `runLaneRegistryMigration`,而后者的 M0/M2 读的正是 `memory_edges.tags`。票 05 一旦把那一列改掉,整个未发版的 lane-declaration 批次会在同一次首次打开里当场失效。**这张票今天不改变任何行为**,存在的理由是给后面的列改造一个合法的位置。

- [x] 升级路径:注册表迁移在边 schema 改动之前完成,并有测试用一个「旧形状 + 有待迁移边」的夹具证明它读到了它需要的数据。
- [x] 全新库路径:注册表迁移不运行,收据里有一行显式的「不适用」,而不是缺一行。
- [x] 两条路径各做一次 failpoint 重启测试:中途崩溃后重开,状态一致、不重复执行。
- [x] 现有全部迁移测试保持绿;本票不引入任何可观察的行为变化,并有一条测试钉住这一点。

## Comments

**落地形态**(`src/db/lanes.ts` 编排器 + `src/db/schema.ts` 的 `runLaneModelV12EdgeMigration`
槽,测试 `tests/db/schema.lane-migration-ordering.test.ts`):次序不是靠注释,而是靠两个
互补的运行期闸,**在损害发生的地方**检查,与未来那一票把代码写在哪无关。

1. `assertPreLaneModelV12EdgeShape` —— 还有待跑的相位时,`memory_edges` 必须仍是 v12 前
   形状(有 `tags`、无 `tail_tag`/`head_tag`),否则抛 `LaneMigrationOrderError`。列改造
   无论写在哪里,都必须在表上留下这两个痕迹之一。
2. `assertLaneRegistrySettled` —— v12 相位槽在四张收据齐全前拒绝运行,拦的是「槽本身被
   上移」。

「不适用」判据取的是**「四相位读得到的表全空」**(`memory_edges` ∪ `turns`),不是「文件
刚建」:后者过不了它自己那条 failpoint(崩溃重开后「刚建」这个事实就没了),前者可无限
重导且本来就是「不适用」的真实含义。全新库照写四张相位收据(载荷与真跑一字节不差,有测试
钉住),另加一行独立的 `lane-registry-not-applicable`;该行**刻意不进** `lane-declaration-%`
族,因为现存测试按那个前缀数相位收据。
