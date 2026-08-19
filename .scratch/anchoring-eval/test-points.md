# 锚定召回测试点(从真实丢失实例收集,2026-08-19)

**目的**:发版+补结算后,检验三条召回通道——段记忆(卡片/Working State)、里程碑选择(含拟议的 grounded-on 入度键)、recall 检索——能否在决策点等价物上召回这些事实。每个测试点都是用户在 [S15069] 真实抓到的一次丢失,不是构造样本。

**流程**:发版 reload → 手动 `/settle` 补结算覆盖窗口(上限 100/次)→ 逐点评测 → 数据裁决 grounded-on 是否入字典序第四键。

## 测试点

### P1 · hook 单槽 ~10K 坍缩(канон案例,单会话丢 4 次)
- 事实链:[S1730/T931] 实测 25KB→2KB;[S15069/T844-845] 机制定位;[T969] 成文。
- 决策点:[T989] 批准 rubric+roster 拼接同槽(错);[T990] 用户抓出、拆槽修复。
- 期望:injection/hook-limits 所属段的里程碑含事实 turn(需 grounded-on 入度键——现三键下取证 turn 入度恒零,预期 FAIL 后 PASS);T990 对 T989 的 override 边成立;`recall(query="hook 坍缩 collapse")` 一发命中。
- 备注:[S1730/T931] 旧纪元不进里程碑——检验「事实需在纪元内再编码」边界([T844-845] 即再编码)。

### P2 · pageBudget=分页而非截断(帧错误连纠两轮)
- 事实链:[T919-T921] 视图裁决(filter/双预算/分页);压缩丢失。
- 决策点:[T956-T957] 我用旧渲染器机制答预算问题(错);[T958] 用户「你理解之前的设计吗」纠正,override T957。
- 期望:recall-view 段里程碑含 T919 裁决 turn;T958→T957 override 边;里程碑纠正链(T958 为锚、T957 降级)。

### P3 · 20 轮段维护提醒的出处(建段指导词之问)
- 事实链:[T825] 「每 20 轮还没更新提醒一次」裁决(nudge 起源)。
- 决策点:[T977] 用户问「之前的设计是每 20 turn 提醒一次…指导提示词放在哪里」——我靠 grep 代码而非召回 T825。
- 期望:段记忆(cadence/injection lane)Working State 或里程碑含 T825;`recall(query="20 turn 提醒 maintenance")` 命中。

### P4 · truncate/depth 的裁决谱系
- 事实链:[T919-T921] 双预算裁决 → [T972] truncate 字符整体退役。
- 决策点:[T956] 我仍按 200/2000 字符刀作答。
- 期望:与 P2 同段;T972 refines T919(或 override 部分);谱系在段视角 timeline 连续可读。

### P5 · 稳定教材=skill 文档的旧戏重演
- 事实链:[T934] stale 插件教旧 title 前缀整会话无人发觉(教训成文+memory)。
- 决策点:[T986-T987] 「Agent 知道怎么用吗」——skill 文档仍教 depth/truncate/query 方言,静默失败风险;靠我人工联想到 T934。
- 期望:docs/release lane 的段记忆含 stale-teacher 教训;T987 grounded-on T934。

### P6 · propose 幂等键:裁决落了 brief 漏了 spec
- 事实链:[T971] D 的 brief 里修正 key=session+addresses(job 键不能跨重认领)。
- 决策点:[T983] peer P2-4 抓出 spec 文本未随裁决更新。
- 期望:settlement lane 段记忆/里程碑含该裁决 turn;编辑 spec 的会话挂靠该段时开场可见。

### P7 · rewind turn 的标记缺失
- 事实链:检测早已落库(was_rolled_back)。
- 决策点:[T914] 我把五个 rewind turn 误诊为指针异常;[T915] 用户「这是 rewind 的 turn,为什么没有标记」。
- 期望:T915 override T914;渲染契约(标记+replay 不信任)turn 进 view lane 里程碑。

### P8 · createdAtEpoch 与 turn 1 同秒(新收录,预防性)
- 事实:[T985] G 发现裸用 createdAtEpoch 作回退标记每个新会话少数一轮(严格 `>` 边界),`-1` 修正。
- 未来决策点:任何 cadence/计数改动。
- 期望:cadence lane 段记忆含此 fact;此点无丢失史,作阳性对照(写入即锚定 vs 丢过才锚定)。

### P9 · 裸「可以」孤儿化:徽章废除裁决跨压缩失传(新收录,2026-08-20)
- 事实链:[T921] 裁决原文=对 grill Q2 的裸「可以」(计数徽章废除,状态标记留 title 尾);[T944] /compact;[T959] spec 凭上下文摘要撰写,该裁决零痕迹,票 07/08 与实现随之全遗漏;[T1026] 查证:T921 结算 desc 全程保有自足句 "count badges out with status markers kept at title tail"。
- 决策点等价物:写视图类 spec/票时问「T918–921 的 grill 各答裁了什么」。
- 期望:三通道均应召回徽章废除。对照:同回合的自足句裁决(session 首现带 title)存活入 spec——裁决在压缩摘要中是否自足不该是存活变量,记忆检索是补偿通道;此点同时是 memory-policy 物化规则([T1025])的验证点。

## 判据

每点三通道分别记 PASS/FAIL:
1. **里程碑**:事实/裁决 turn 是否入其段的里程碑选择(现三键 vs +grounded-on 键各测一次——差分即该键的证据);
2. **段记忆**:挂靠该段的 SessionStart 注入(卡片字段/Working State/里程碑块)是否含该事实的可辨认表述;
3. **recall**:以决策点语境的自然关键词一发命中(≤1 次重试)。

预登记的预期:P1/P3/P5 类(取证型事实)在现三键下里程碑 FAIL、+grounded-on 后 PASS——这个差分就是第四键的立项证据;P2/P4/P7(决策+纠正链)现键应已 PASS(override/refines 有分)。若取证型在 +键后仍 FAIL,归因排查顺序:边没写出来(写入纪律)> 段没挂靠(lane 边界)> 键序不足(设计)。
