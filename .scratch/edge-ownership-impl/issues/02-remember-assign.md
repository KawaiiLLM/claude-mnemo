# 02 — remember 复活 `assign` 动词

**What to build:** 主 agent 一次调用把一个区间/列表的 turn 派进段,或置无归属;单归属搬家语义。

规范:`.scratch/ownership-and-note-cadence/spec.md`「所有权」节 assign 条目([S15069/T926])。

- 动词 `assign`:`id="E<n>"` 或省略(省略 = 置无归属,从现归属移除,turn 变 homeless);turn 集合收 `S<n>/T<a>..T<b>` 区间或地址列表。
- **单归属**:写路径强制——派入前先从现段移除,同一事务;**不加追溯性 schema 约束**(遗留段可能共享 turn,冻结不动)。
- 移除/搬家落 DB 原语(现行唯一原语只增不减,peer 发现 3);`create` 的 `members` 种子与 `assign` 同一条写入路径;派生 facets 随成员增删重算。
- 区间跨不存在的 turn:整个调用拒绝并报出缺哪个,零部分写入。

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] 区间派入/列表派入/置无归属三形态各有测试
- [ ] 已属 E_a 的 turn 派入 E_b 后,E_a 不再计入其 facets(mutation fixture,peer 发现 3 点名的缺口)
- [ ] `create`+`members` 与 `assign` 走同一写入路径的断言
- [ ] 不存在的 turn 使整个调用拒绝,零部分写入
