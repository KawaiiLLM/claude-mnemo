# v10 概念稿:lane 模型(草案 rev 6)

替换 rubric v9 §Relations 的概念与程序层:只定义概念,行为由概念涌现;三原则为基底。
修订史:用户六轮修订(T1284→T1304)+ 两次实测 + peer round 1(Codex,16 findings)+ round 2(Codex,#17–27)+ round 3(mnemo review,#28–39)。round 3 六 P1 由 T1304 裁决关闭:#28→边行不可变 tag-set 入身份;#29→子集不变量,无协写;#30→跨段带 tag 边合法仅警告;#31→exact set 为机器身份、层级为解读;#32→一切按 turn 序,工具不追加检查;#33→统一原则:带 tag 作用于 lane,不带 tag 作用于 turn 本身。

## 统一解读原则(概念完整性的锚)

**带 tag 的边作用于某条 lane;不带 tag 的边作用于被引 turn 本身。** 所有词共用此解读,无特例:
- 带 tag 的 override 废除目标**在该 lane 中的地位**;不带 tag 的 override 废除目标 turn 的结论本身(全局)。
- 带 tag 的 indexes 宣告**该 lane** 收敛;不带 tag 的 indexes 索引一组 turn 本身(自由聚合)。
- 带 tag 的 consume/narrows/extends 在该 lane 的工作线内取用/纠正/延伸;不带 tag 则作用于目标结论本身,不牵涉 lane。

## 概念

- **lane**:同一相位内、段之下明显可分离的子工作流。**一组 tags(exact set)唯一标识一条 lane,范围为段**——同段内相同 tag 组即同一条 lane。lane 不跨相位,只经跨相位关系与其他相位的 lane 相连。
  - **层级是解读,不是机制**:{P}→{P,c1} 的分叉、{A}+{B}→{A,B} 的合流,都只是 tag 集合的叠加;机器只认 exact set({P,c1} 与 {P} 是两条独立 lane),父子/合流关系由人阅读 tag 集合得出,检查工具可按子集关系提供分组视图但不赋予语义。
  - **跨段**:带 tag 边的两端可以分属不同段——这只说明段边界与工作线不重合,检查工具告警;段间偶尔耦合允许,不应是常态。
  - **单节点 lane**:一次发散对话等孤立产出不需要 tag、不入机器模型,照常被跨相位关系消费;"有效 lane 必有终点"的必要条件不适用于它。
- **边上的 lane tag**:同相位边(override/narrows/extends/consume/indexes)都**可以**携带 lane tag,均非必须。**子集不变量(写入强制)**:边上的每个 tag 必须已存在于两端 turn 的 tags 集合中——正向流程里成员轮记笔记时自然带上 lane tag,子集自动成立;违反即拒收,回执点名缺失的 tag,写入者经正常笔记编辑路径补齐后重写。无任何自动协写。
- **边的身份**:一条边行 = (citing, cited, relation, 不可变 tag-set)。同一 pair/relation 可多行并存:无 tag 行(自由连接)、{A} 行、{B} 行各自独立;{A}+{B} 两行与 {A,B} 一行是不同事实(前者=分别服务两条 lane,后者=服务合流 lane)。重述与撤销以行为单位,永不并集。
- **起点**:lane 的初始节点——在本 lane 的结构边中无出边。多条 lane 可以共享一个起点(自此分叉)。
- **终点**:lane 的收敛节点,以**带本 lane tag 的 indexes 边**显式宣告收敛,索引本 lane 的核心有效节点;收敛不因沉默成立。**一切 lane 事件(宣告、override、结构延续)按 turn 序归约**,多次宣告以最后一次为准;宣告之后 lane 继续延伸是常态,下一次宣告自然取代上一次,无须任何中间标记。
- **终点被 override(解读,非机制)**:携带同 lane tag 的 override = lane 内纠正,lane 重开继承——同一条 lane 进入无终点态,直到新宣告;不带 tag 的 override = 对该 turn 结论的全局否决,所有以它为现任终点的 lane 一并失去终点;异 tag 的 override = 另一条 lane 的行为,不继承本 lane。被否决的 lane 可由后续成员以新宣告复活。
- **有效节点**:相对于 lane 判定——节点在 lane L 中有效,当它未被 skip/rewind 移出、未被**全局**(无 tag)override 推翻、未被**带 L tag** 的 override 废除地位,且 L 被采纳。带异 tag 的 override 不影响它在 L 中的地位。(skip/rewind 的 turn 不是节点;被推翻的节点留在图中,作为死节点承载纠正叙事。)
- **有效 lane**:被采纳、落地的 lane。采纳态是动态人工判断,不用标记记录,最强证据是进入落地时其终点被**外部**节点引用(自引是形式边,不作采纳证据)。图上的必要条件(工具报告事实,采纳判断在调用者):有效 lane 必须有 indexes 终点;单节点 lane 豁免。
- **复合节点**:同一节点可属多条 lane、跨多个相位;相位合法性从宽,任一配对合法即边合法。自引无实质语义,只为满足连通性等校验而存在;自引门对**写后图**校验(同一调用先宣告终点再自引是合法序列)。

## 八词

- **override** → 同相位(可带 tag):其主要结果不再适用,本节点完全替代之。
- **narrows** → 同相位(可带 tag):其部分结果不再适用,本节点作出纠正。
- **extends** → 同相位(可带 tag):其结果仍然适用,本节点拓展、补充。
- **consume** → 同相位(可带 tag):本节点使用了其产出,不为其正确性担责。
- **indexes** → 同相位(可带 tag):表达收敛、汇聚、索引——本节点作为代表,索引一组同相位节点,外部经本节点到达它们。已被索引的节点不再另写 consume——索引蕴含取用。
- **grounds** → 异相位:本节点的成立依赖其成立,它若倒下,本节点随之倒下。
- **verifies** → 异相位:本节点以本轮产出的检验结果支持其结论;源节点须含取证相位。
- **refutes** → 异相位:本节点以本轮产出的检验结果反驳其结论、削弱其可信;源节点须含取证相位。

(各词的 lane 语义由统一解读原则给出,不逐词重复。)

## 校验体系

**写入时强制拒绝——只拒明确非法**:
- 相位合法性:八词的同相位/跨相位域;
- tag 合法性:词的可带性(仅同相位词)、子集不变量(边 tag ⊆ 两端 turn tags);
- 自引门:对写后图校验。

**检查工具——三原则的归宿,供结算 agent 与复核者主动调用,只报事实、永不强制**:
- **连通性**:给定 lane 标识(段+tag 组),从终点沿本 lane 结构边回溯是否到达每个成员(死节点亦在内,带 tag 的 override 边即通往它们的路);终点是否被异相位以 grounds/verifies/refutes 引用、接力至价值链天然汇(落地终点豁免;自引不计)。
- **连通分量**:一个 lane 标识是否分裂为多岛;多条 lane 是否被意外连通(按 exact set 投影;共享起点/合流节点是设计内形状)。
- **最小连通**:是否存在多余路径。追求而非违例;作证以事实为单位、indexes 名册合法,均不算冗余。
- 附带事实报告:跨段边、有效 lane 必要条件(有无终点宣告;单节点 lane 豁免)。

## 公理(显式最小立法,peer 证明不可由原则推出)

- **发布链**:发布 consume 前一发布;首个发布是链的合法根。
- **canonical 承担者**:一条决策的跨相位引用优先经其 spec(独立 spec 轮存在时),其余工件 consume 该承担者;无 spec 时工件直接 grounds。偏好惯例,判断执行。

## 人工判断词(显式标注)

"明显可分离"(lane 划分)、"核心"(indexes 目标集裁量)、"被采纳"(有效 lane,动态)、"天然汇/价值链"(引用接力止点)、"主要结果/部分结果"(override vs narrows)、"偶尔耦合"(跨段边)、父子/合流叙述(tag 集合的人类阅读)。

## 迁移决策(15 项,含 round 3 修订)

1. **存储与身份**:边行获得代理 id;行 = (citing, cited, relation, 不可变 canonical tag-set),tag-set 参与唯一性;同 pair/relation 多行合法。`memory_edge_tags(edge_row_id, tag)` 仅作查询索引,语义以行上的 set 为准,永不跨行并集。
2. **子集不变量取代协写**:写入校验边 tag ⊆ 两端 turns.tags;不满足即拒。无自动协写,无 provenance 问题。
3. **tag 改名**:预检碰撞报告(如 A→B 使 {A,B} 塌缩为 {B})→ 人工裁决 merge/reject/新名;裁决后同一独占事务重写节点 tags、边 tag-set 与索引表。
4. **lane 身份**:段 + exact tag set;检查工具按此枚举,跨段边在两侧扫描中出现并告警。
5. **存量无 tag 同相位边**:不自动归类;backfill 逐窗判断补 tag(以新行重述)或留作自由连接。**耐久处置**:每段完成写一行处置记录(与该段判断同事务),崩溃重启不重判。
6. **lane tag 铸造**:backfill 先给成员轮补节点 tags(迁移自身权限,不走写入合同),再写边行。
7. **终点宣告 backfill**:已收敛 lane 由其定案轮补写带 tag 的 indexes 行;existing 无 tag indexes 行零改动(自由聚合语义回溯成立)。
8. **事件全序**:citing turn 的 (session, prompt_number) 序,宣告与 override 同轴。
9. **重开窗口读语义**:旧终点保持可读代理、带死标记。
10. **自引门**:staged 校验,对本调用全部边落库后的图判定。
11. **工具失败后果**:只报事实,永不回滚、永不中止。
12. **backfill 可恢复性**:按段分批,处置行即断点,幂等。
13. **验证**:backfill 前后 recall/tag 检索成员 diff 报告(lane tag 进入 turns.tags 是设计内可见性变化,报告供人审)。
14. **deriveFlows v2**:exact-set 子图推导(全相位),统一解读原则的 override 语义(带 tag 入 lane、无 tag 全局杀),终点=turn 序最新宣告。
15. **下游清单**:self-grounds 门、mid-flow warning 回执、timeline/UI、edge signals(策展键 grounds ∪ indexes 不变)、settlement writer(获得检查工具)、迁移 guard、测试基线。
