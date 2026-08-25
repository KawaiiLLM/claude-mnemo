# 09 — 边带两侧 tag(contract):旧列与双写下线

**What to build:** 旧的 `tags` 列与维持它的双写代码消失,两侧列成为唯一事实来源。

**Blocked by:** 06, 07, 08。

**Status:** ready-for-agent

- [ ] 旧列删除;所有残留读者一个不剩,用 grep 哨兵钉住。
- [ ] 双写代码删除;写入路径只维护两侧列与侧索引。
- [ ] 迁移做一次 failpoint 重启测试;第二次运行是无操作。
- [ ] 全套测试绿;身份键的幂等性测试在没有旧列兜底的情况下仍然成立。

## 票 01 落地后加的一条约束

**不能用 `ALTER TABLE memory_edges DROP COLUMN tags`。** 那一列是 `UNIQUE (citing_kind, citing_id, cited_kind, cited_id, relation, tags)` 的一部分,SQLite 拒绝删除受约束/被索引的列。这一步需要**整表重建**,而且 `memory_edge_tags.edge_row_id REFERENCES memory_edges(id) ON DELETE CASCADE` 意味着 rename-copy-drop 的过程中 SQLite 会改写那个外键目标 —— 重建顺序必须把它算进去,并有测试断言重建后侧索引与级联仍然成立。

