# Relation matrix — the nine-cell grammar

Ruled S15069/T1163–T1171 (2026-08-21). Replaces the seven hand-carved
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

## Constraints and dispositions

- **同流约束只压立场对**:override/refines 两端必须同一工作流。工作流 =
  一条可分离、可命名的子任务链路(例:边关系设计、note 回执裁剪、recall
  渲染裁剪是三条工作流)。判不清同流 → 降级用 depends-on。工作流未实体化,
  该约束由 rubric 层判断执行,校验器只查相位。
- **计分四裁决**(转录入计分三改档案;幅度/排序与取证桶留给三改):
  override 归零(已是现行实现)、refines 加分、encodes 加分、depends-on 不涉分。
- **新格边的选举可见性**:入图但暂不入选举——refinesExcess 只有决策/落地两桶,
  非此两相的 refines 源在计分处显式跳过(不崩不误计),等三改在回填后的真图上裁。
  override 归零与 encodes 加分全相位立即生效(现行实现已通用)。
- **override 不传染**:归零只打被点名节点;其 refines 后代改指替代者还是作废,
  逐个判断,后见结算处理。
- **supersedes 保持机器专用**(153 条判官写入),与写者的 override 双词并存。
- **零迁移**:五处放宽(立场对+depends-on 同相位化、evidence 靶+L、encodes 靶+E)、
  零收紧;全部现存边类别是新格子集,已逐类核对。
- **存量 24 条 refines 的分叉合规**并入 /settle 回填顺路纠,不开专门 pass。
- **A2(补丁发布当轮裁当轮修、无 encodes 靶)明确出范围**——turn 粒度问题,
  非词表问题。

## Tickets

01 校验器开九格(无阻塞) → 02 rubric v6(阻塞 01,主 agent 亲做+用户审文本)
/ 03 选举护栏(阻塞 01) → 04 教学面清扫+档案转录(阻塞 01+02)
