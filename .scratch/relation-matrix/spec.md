# Relation matrix — the nine-cell grammar

Ruled S15069/T1163–T1180 (2026-08-21). Replaces the seven hand-carved
per-word phase tables with one grammar: two reading rules cover all nine
source-phase × target-phase cells.

## The matrix

| 源 \ 靶 | →取证 E | →决策 D | →落地 L |
|---|---|---|---|
| **取证 E** | refines / override / depends-on | evidence-for / -against | evidence-for / -against |
| **决策 D** | grounded-on | refines / override / depends-on | grounded-on |
| **落地 L** | encodes | encodes | refines / override / depends-on |

Reading rule 1 — **same phase (diagonal): pick by guarantee strength**
- `override` — 被引主要结论错,本节点可替代它;被 override 的节点分数归零。
- `refines` — 被引主要结论对,在其上改进/补充/拓展,不可替代;被 refines 的
  节点分数增加。改进链是**分叉**:每条链 = 从起点分出的一个方向,refines 指向
  你真正基于的节点,不同方向不按时间顺序串连。
- `depends-on` — 仅担保逻辑依赖:本节点建立在被引方**完成**的基础上,不问
  工作流、不担正确性。派工→验收→提交等工序链合法。

Reading rule 2 — **cross phase: the word is determined by the SOURCE row**
- 取证源 → `evidence-for` / `evidence-against`(裁断:我检验了那条主张)。
- 决策源 → `grounded-on`(立足:它假则我塌)。
- 落地源 → `encodes`(承载)。被 encodes 的节点都会加分,所以点名逻辑是
  策展:哪些 turn 包含本次落地的核心决策/关键验证、值得被展示——最小集,
  行级通用(L→D 与 L→E 同纪律)。

## Multi-phase turns and self-reference (T1178/T1180)

- **多相位 turn 逐相位独立判边**:它是几步合成一轮,每半步各按自己的身份对
  同一靶判边,都成立就都写(多关系并存 + 删除检验防冗余)。peer 评审发现的
  双相位歧义(research+review 源对 research 靶可走 E→E 也可走 L→E)由此
  溶解:两条都真就两条都写,各自独立成立。
- **自引用**(定向推翻 T1111 的自环全禁):跨相位词在 turn 自身相位集合横跨
  源行相位与合法靶相位时可引自己——research+review 自 encodes(review 半
  处理本轮 research 半)、measure+design 自 evidence-for 或自 grounded-on。
  **单相位 turn 不可自引;对角线词永不可自引**(同相位对自己是空话)。
  自引边**参与计分**(自 encodes 计入 encodesCount,用户明裁)。
  副产品:**A2 溶解**——当轮裁当轮修的补丁发布(correction+fix+ops)自
  encodes 本轮裁决,T1001 类空缺从此有词。
  代价:memory_edges 的自环 CHECK 需重建为「裸自环仍禁、带词自环放行」,
  相位门在校验器——本 spec 唯一的真 schema 迁移(票 05),数据无损。

## Constraints and dispositions

- **同流约束只压立场对**:override/refines 两端必须同一工作流。工作流 =
  一条可分离、可命名的子任务链路(例:边关系设计、note 回执裁剪、recall
  渲染裁剪是三条工作流)。判不清同流 → 降级用 depends-on。工作流未实体化,
  该约束由 rubric 层判断执行,校验器只查相位。
- **计分五裁决**(转录入计分三改档案;幅度/排序与取证桶留给三改):
  override 归零(已是现行实现)、refines 加分、encodes 加分、depends-on
  不涉分、自引边参与计分。
- **新格边的选举可见性**:入图但暂不入选举——refinesExcess 只有决策/落地两桶,
  非此两相的 refines 源在计分处显式跳过(不崩不误计),等三改在回填后的真图上裁。
  override 归零与 encodes 加分全相位立即生效(现行实现已通用)。
- **override 不传染**:归零只打被点名节点;其 refines 后代改指替代者还是作废,
  逐个判断,后见结算处理。
- **supersedes 保持机器专用**(153 条判官写入),与写者的 override 双词并存。
- **迁移**:九格开放是纯放宽零迁移(五处放宽、零收紧,现存边类逐类核对为新格
  子集);自引用的 CHECK 重建(票 05)是唯一真迁移,数据无损、可演练。
- **存量 24 条 refines 的分叉合规**并入 /settle 回填顺路纠,不开专门 pass。
- ~~A2 出范围~~ → **A2 由自引用溶解**(见上节)。

## Tickets

01 校验器开九格(DONE 197b34d) → 02 rubric v6(阻塞 01;主 agent 亲做+用户
审文本;peer 冷眼评审已过一轮,修订稿待终审) / 03 选举护栏(DONE f09dc3a)
/ 05 自引用迁移(阻塞 01) → 04 教学面清扫+档案转录(阻塞 01+02+05)
