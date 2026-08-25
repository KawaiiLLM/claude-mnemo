# 03 — 两条词表迁移:refutes 与 supersedes 各自归位

**What to build:** 存量数据跟上七词词表 —— 所有 `refutes` 行变成 `override`,所有 `supersedes` 行变成无 tag 的 `override`,并且 `supersedes` 从 schema 的 CHECK 与两处把它当评分信号读的特判里一并消失。

**Blocked by:** 02(目标词必须先存在)。

**Status:** ready-for-agent

**这条迁移在真实生产数据上已经撞键。** `S15069/T1072 → T1068` 这一对上同时存在一条 `refutes`(asserted)与一条 `override`(judged),两条都无 tag,身份键在迁移后完全相同。先前的 spec 只核过 `supersedes` 的零冲突就把结论推广到了整条迁移,那是错的。

- [ ] 撞键合并规则:同一身份键上多行时,保留 `asserted` 那行的审计元数据(行 id、created_at、provenance),删除 `judged` 重复行;两行同为 asserted 时保留较早那行;收据记下双方的行 id 与 provenance。
- [ ] 用上面那对**真实数据**做夹具,断言合并后的结果与收据内容。
- [ ] `supersedes`:155 条全部 turn→turn、全部无 tag,与现存 override/refutes 零同 pair 冲突(已实测),方向一律是引用方=纠正者,因此不需要逐条语义分流 —— 但仍走同一套合并规则,以防未来数据不同。
- [ ] schema 的 CHECK 条目删除;把 `supersedes` 出边当 corrector、入边当「被推翻的受害者」读的两处评分特判删除。**同一行数据不能再有两套读法。**
- [ ] 数据与收据同事务;failpoint 重启测试;第二次运行是无操作。
