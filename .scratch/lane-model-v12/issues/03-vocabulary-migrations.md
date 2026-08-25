# 03 — 两条词表迁移:refutes 与 supersedes 各自归位

**What to build:** 存量数据跟上七词词表 —— 所有 `refutes` 行变成 `override`,所有 `supersedes` 行变成无 tag 的 `override`,并且 `supersedes` 从 schema 的 CHECK 与两处把它当评分信号读的特判里一并消失。

**Blocked by:** 02(目标词必须先存在)。

**Status:** done — landed, not released

**这条迁移在真实生产数据上已经撞键。** `S15069/T1072 → T1068` 这一对上同时存在一条 `refutes`(asserted)与一条 `override`(judged),两条都无 tag,身份键在迁移后完全相同。先前的 spec 只核过 `supersedes` 的零冲突就把结论推广到了整条迁移,那是错的。

- [x] 撞键合并规则:同一身份键上多行时,保留 `asserted` 那行的审计元数据(行 id、created_at、provenance),删除 `judged` 重复行;两行同为 asserted 时保留较早那行;收据记下双方的行 id 与 provenance。
- [x] 用上面那对**真实数据**做夹具,断言合并后的结果与收据内容。
- [x] `supersedes`:155 条全部 turn→turn、全部无 tag,与现存 override/refutes 零同 pair 冲突(已实测),方向一律是引用方=纠正者,因此不需要逐条语义分流 —— 但仍走同一套合并规则,以防未来数据不同。
- [x] schema 的 CHECK 条目删除;把 `supersedes` 出边当 corrector、入边当「被推翻的受害者」读的两处评分特判删除。**同一行数据不能再有两套读法。**
- [x] 数据与收据同事务;failpoint 重启测试;第二次运行是无操作。

## 票 02 落地后加的两条

- **合并在人工判定过的数据上是行为保持的(实测)。** 黄金夹具 `t900-1001-lane-sim` 里有一条 `refutes`(941→935);票 02 在**测试加载器**里按本票的规则把它迁成 `override`,结果 **11 条 lane 状态、四份报告、选举黄金全部逐字节不变**。夹具 JSON 本身没有改动 —— 它是未经调整的生产证据,它的价值就在于未经调整。
- **`refutes` 暂时保留了它的撤回镜像(`retractRefutes`),这是有意的。** 本票把行清空之前(以及任何还没跑过本迁移的库上),20 条 asserted 行会成为 E2 锚点,而结算的提交闸在可写集合里还有 E2 时会拒绝 —— 正是 `supersedes` 的镜像存在的那种死锁。本票跑完之后,这个镜像可以删,那是 `src/db/citations.ts` 里三行的事。


## Comments

**落地形态**:`src/db/lanes.ts` 的 `runLaneModelV12VocabularyMerge`(M-B,数据+收据一个
事务)与 `src/db/schema.ts` 的 `ensureMemoryEdgesLaneModelV12RelationContract`(M-D,
CHECK 收窄),两者按序挂在票 01 的 `runLaneModelV12EdgeMigration` 槽里,排在票 04 的
M-C 之后;测试 `tests/db/schema.lane-model-v12-vocabulary-merge.test.ts`。

**只读实测与本票原文的数字不符**:今天生产库是 `supersedes` 150 条(2 asserted /
148 judged)、`refutes` 8 条(6 asserted),不是 155 / 20。撞键那一对完全对上:edge
2643(`refutes`/`asserted`/无 tag/1787212083)与 edge 3010(`override`/`judged`/无
tag/1787337397),同为 `S15069/T1072 → T1068`,全库唯一一组撞键。夹具照抄这一对。

**M-B 的闸是谓词,不是收据。**「跑过一次」与「不可能再有这种行」是两句话:收据在手而
行又出现(还原旧备份、夹具手搭前迁移表)时,紧随其后的 M-D 会拒绝围着它重建,整次打开
失败。所以有退休词就修,收据只作首跑的审计记录。既有的六个历史迁移测试正是这个形状,
它们是这条改动的现成证据(把闸改回收据判定,15 条测试变红)。

**M-B 必须早于列改造(票 05/09)**,因为它的身份键末位就是 tag 载荷 —— 与 M-C 的
「不读任何 lane 列」相反。按票 01 的做法钉在损害发生处:待跑的 M-B 遇到已两列化的表
直接抛 `LaneMigrationOrderError`。票 01 的「已收缩表」夹具因此要补上 M-B 的收据 ——
声称收缩形状却没有这张收据,是升级路径产生不出来的状态。

**两个词一起退出 CHECK,不只 `supersedes`。** M-B 之后二者状态完全相同:零存量行、
不可写、无断言字段。只让一个留在 CHECK 里,等于保留一个「存储层承诺接受、而任何东西都
造不出来」的词 —— 正是本票从 `segment-rank.ts` 拿掉的那种「一行两读法」,换个地方而已;
也会让 `refutes` 重新武装 E2 死锁(可存但无撤回路径)。于是存储词表 = 写入词表 =
`EDGE_RELATIONS` 七词,`CITATION_RELATIONS` 与之相等,`RETRACTION_ONLY_RELATIONS`
变空,两个 `retract…` 镜像与两侧门面字段一并删除(票 02 留下的那条待办)。

**连带删除,均为同一原因**:`segment-rank.ts` 的 `isCorrector`/`isRolledBack` 两个键
与 `orphanSignals` 的两个信号;`timeline.ts` 的 ⚑ 标记(两条独立实现,同一个
出边-`supersedes` 谓词)。**不改指向 `override`** —— `override` 本来就有 29 条从未被
当作纠正信号的行,改指等于在没有测量支撑的数据上重排,而 spec 的常设约束是验证之前不动
评分。`remapLegacyRelation` 里 `supersedes → supersedes` 同时改成 `→ override`:那条
遗留折叠只在首次建表时跑,收窄后的 CHECK 会拒绝它折进来的旧词。

**E2 现在在活库上不可达**,这是 M-B 的后果而非 CHECK 的:没有任何存量行带词表外的词,
也没有写入面能造一条。校验器的 E2 类仍在(属票 11 地盘),其测试夹具改用
`PRAGMA ignore_check_constraints` 明说「迁移之前的旧库留下的行」。**票 11 需要裁定
E2 及其教学面条目是否随之退休** —— 教学面上错误类是封闭列表,留一条永不到来的拒绝,
正是票 04 点名的那种失败。

## 票 05 落地后发现的一条钉桩缺口

**M-B 的撞键夹具分辨不了它自己的两条合并子句。** 真实生产那一对上,`asserted` 恰好也是**较早**的那一行 —— 于是把 provenance 比较整条删掉,只留年龄序,每一条 M-B 测试仍然全绿(反转它才会红,而反转不等于删除)。票 05 补了一条 `asserted` 落在**较晚**一行的用例,目前那是唯一钉住 provenance 优先的东西。**建议在 M-B 自己的测试文件里镜像一条同形状的。**

