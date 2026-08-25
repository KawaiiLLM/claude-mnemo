# 10 — 归属来自节点自身的 tags,而 tags 收进两个封闭词表

**What to build:** 一个节点属于哪些 lane,由它自己的 tags 决定,不再从边推导。连通成员才需要两侧同 tag 的边。

**Blocked by:** 09。

**Status:** ready-for-agent

这不是「简化一个函数」,而是一次**共享 lane 投影的替换**。今天投影的输入根本不带节点 tags,lane 成员只从带 tag 的边端点枚举。反例:T1/T2 属于 lane L 且 T2 index→T1,T3 也属于 L 但还没有边 —— 新模型说 L 是 open,现投影看不见 T3,仍判 closed。

- [ ] 投影的输入携带节点自身 tags;成员枚举换源;加载器与归约的输出契约一起改。
- [ ] **只带 tag、还没有边的成员参与 closed/open 判定**,一条测试用上面那个反例钉住。
- [ ] **provisional lane 合法**:一条新声明的 lane 可以暂时只有 0 或 1 个成员;声明不规定固定时点;连通性原则对它不适用,不报为缺陷。
- [ ] `undeclare` 的守门条件从「仍有边携带该 tag」改为「**仍有成员节点自身带该 tag**」,并在还有成员时**拒绝**;清理成员的 tag 是结算的显式动作。旧条件会让一条有成员、零边的 provisional lane 被撤掉,留下指向不存在 lane 的归属。
- [ ] 突变验证:恢复任一处旧口径,必须有点名它的测试变红。

## 后加的一半:tags 的写入闸(spec D3b/D3c)

- [ ] `tags` 只接受该 turn 所属段**已声明的 lane tag** 与该段的**策展 tag**;其余拒绝并列出当前合法集合。不做成 schema 枚举 —— MCP 的形状连接时公布一次,而 lane 由结算中途声明。
- [ ] `checkCanonicalLaneTag` 增一条:**含前缀分隔符的值不得声明为 lane**。机器命名空间(`compact:` / `invalidated:` / `delivery:`)由 hook 直接写库,不经这道闸。
- [ ] **遗留的自由 tag 值一律不清除**,只禁新写;它们未被声明,因此在归属计算里天然为零。
- [ ] **`declare` 在声明前报出会被追溯征召的既有 turn 数**(`spec` 153、`citation-edges` 124、`timeline` 123 是今天的实测),让「这个名字太泛」在声明当下就看得见。
- [ ] `declare`/`undeclare` **留在主 agent 的 `remember` 上**;改的是描述与 rubric 的提示:不需要主动声明,这里是为手动调整保留的。
- [ ] 两侧 `.describe()` 分别写,主 agent 那份不提结算的日常职责细节。

