# Rubric v11 — the lane sections, as authored by the user [S15069/T1562]

Ticket 08 reproduces this wording rather than paraphrasing it.

**lane**: 段任务下明显可分离、周期较长、可持续进行的子任务，例如 #release / #rubric-design ，而不是破碎、短期、做完就没有后续的任务如 #ticket-06-implement / #rubric-v5-design 。以一个 tag 唯一标识，范围为段，形式为带 tag 边的 DAG。lane 至少有两个节点，且图内所有节点的 tags 子集都必须包含 lane tag。一个节点可以属于多个 lane。

**复合节点**：同一节点可能拥有多个 type、多个相位，多相位 turn 任一配对合法即边合法。

**closed lane**: 一条 lane 的最新节点为终点，终点即通过 indexes 宣告收敛的节点。一个 lane 可能有多个中间 indexes 节点，但只有最新节点为 indexes 时才是终点。

**open lane**: 一条 lane 的最新节点不是终点，表示仍然未收敛。

**汇聚 lane**：一个节点可以存在多个 lane；多个 lane 可以共用一条边，此时这条边带上每个 lane 的 tag。

**八词**（均可带 tag）:

- **override** → 同相位：其主要结果不再适用，本节点完全替代之。带 tag = lane 内纠正，lane 重开待新宣告；无 tag = 对该结论的全局否决，所有以它为现任终点的 lane 一并失去终点。
- **narrows** → 同相位：其部分结果不再适用，本节点作出纠正。
- **extends** → 同相位：其结果仍然适用，本节点拓展、补充。
- **consume** → 同相位：使用其产出，不为其正确性担责。
- **indexes** → 同相位：表示收敛、汇聚、索引，达成阶段性成果。带 tag = 宣告该 lane 收敛，本节点即终点，索引 lane 的核心有效节点；无 tag = 自由聚合（如发布索引所运工件）。已被索引的节点不再另写 consume。
- **grounds** → 异相位：本节点的成立依赖其成立，它若倒下，本节点随之倒下。有独立 spec 轮时由 spec 承担 grounds、其余工件 consume 该承担者；无 spec 时工件直接 grounds。
- **verifies / refutes** → 异相位：以本轮产出的检验结果支持/反驳其结论；源节点须含取证相位。

**自引**：自引边（citing 与 cited 是同一节点）不得带 tag。带 tag 意味着点名一条 lane，而单节点自环不构成 lane（lane 至少两个节点）。

**示例**（边由引用方指向被引方）:

- **#release**:每次发布 `consume{release}` 上一次发布——lane 由这条边串起,永不收敛。同一个节点另写**无 tag** 的 `indexes` 聚合本次所交付的工件:两个 indexes 用途不同,只有带 tag 的那个才宣告收敛。
- **跨相位的一条线**:`实现 —consume{rubric-design}→ spec —grounds{rubric-design}→ 设计终点`。同一个 tag 贯穿决策与落地,不拆成两条 lane。
- **汇聚**:一批同时落地 A/B/C 三条 lane 时,这批的边同时带 `{A,B,C}`,单看任一条仍是完整的一条线;而针对其中一条的纠正写**只点名那条**的 `override{B}`,否则一次修理会重开整批。

**原则**（不强制）:

- **有效性**: 无有效产出、重复的 turn 应该 skip，被 skip/rewind 的 turn 不参与连接。
- **连通性**: lane 的所有成员在段的全图上应连成一体；indexes 不参与连通性计算。
- **最小连通**: 任意两个节点之间的路径应该只有一条，除非节点通过多余的路径获取了额外的信息。如 A -> B -> C 表达 A 依赖的 B 依赖于 C，则 A -> C 表达需要通过 C 获取 B 处没有的必要信息。如果 A -> C 无必要则冗余。
