# 11 — 统一 Memory Rubric:单源双渲染,与名册同块

**What to build:** 判断规则的唯一规范入口——一份 rubric 文件,SessionStart 与结算提示逐字渲染同一份;与段名册共享一个注入块。

三层分工([S15069/T933]/[T937]–[T939] peer 讨论收敛):**格式**住参数 describe,**时机频次**住工具描述,**判断**住本 rubric。

- rubric 文件(定稿全文见下,中文)入 shared 资产;头部带 version/hash 行。
- **双渲染逐字同源**:SessionStart 的 mnemo 块与结算提示嵌同一文件;hash 守卫测试断言两个消费者字节一致。不做 consumer-specific 子集。
- **与名册同块**([S15069/T941]):rubric 先渲染、定长、不参与省略;名册吃该块剩余预算(共享 2000)。与旧 RecentSessions+DiaryIndex 共享预算同构。实测今日名册 175 token(3 个在册段),余量充足。
- **超预算显式失败**:rubric 渲染不完整时整块标 incomplete 并报错;禁止静默截断——截尾丢的恰是排在后面的关系与归属规则。
- **describes 瘦身**:票 01 落入参数描述的判别问句迁移至 rubric,describes 只留格式;单一归家断言(判断性措辞只在 rubric 文件出现,grep 级守卫)。

**Blocked by:** 01、03(describes 与时机文本的落点先就位)。

**Status:** ready-for-agent

- [ ] rubric 文件为唯一源;SessionStart 块与结算提示渲染字节一致(hash 守卫测试)
- [ ] 名册与 rubric 同块:rubric 定长优先,名册吃余量;超预算显式失败,不静默截断
- [ ] 票 01 的判别问句从 describes 迁出,describes 仅格式
- [ ] 判断措辞单一归家(工具描述与其他注入不复述 rubric 语句)

## Rubric 定稿(唯一源内容,逐字)

```markdown
# Memory Rubric v2

## type
- 词表,每词一义:
  - discuss — 探讨问题与方案,产生理解但未落裁决;倾向/暂定而未承诺,仍是 discuss
  - research — 查外部资料/源码/文献,产出「世界/代码现状是什么」的事实
  - measure — 本轮跑出的可复核结果:实验、统计、查数
  - design — 做出或修订一个此后要遵守的承诺:机制、契约、阈值
  - correction — 纠正此前错误的结论或方向;错的是判断(代码缺陷归 fix;实现偏离设计而改码 = correction+fix)
  - implement — 把已定设计写成新工件:代码、文档、测试
  - refactor — 减法与重整:删除能力、迁移形态,不新增行为承诺(顺手修缺陷 = refactor+fix)
  - fix — 修复缺陷,让既有承诺重新成立
  - delegate — 派工给 subagent 或外部执行者(同轮验收返回 = delegate+review)
  - review — 核查工作产物是否达标;仅当否定了既有设计裁决才 +design/correction
  - ops — 交付(发布/提交/发 spec/开票)与运维(探活/重启/修数据);纯转写 spec = ops,兼有新裁决 = design+ops
- 阶段:取证 = research/measure · 决策 = design/discuss/correction · 落地 = 其余
- 跨阶段动摇必须双 type;多 type 的阶段是集合,存在合法对即可写边
- 没有词适配就留空,不硬贴

## tags
- 名词,命名物:项目优先,再子系统/工件;活动词属 type
- 小写连字符;优先复用既有 tag;发现同义分裂,归并到先到的词

## 关系(turn→turn;从引用方记向被引方)
每个完结 turn 过三步:
1. 有直接前驱吗?前驱 = 直接引起这一轮的节点;跳级指向弧起点是错标。
   没有 → 孤儿仅两类合法:未曾设想的子任务起点 / 无决策闲杂;不为消灭孤儿编边。
2. 有 → 哪条关系?判别问句,先中先得:
   ① 我检验了那条主张? → evidence-for / evidence-against
   ② 我的决策靠那个发现立足(它假则我塌)? → grounded-on
   ③ 被引结论整体是错的? → override;只是继续或改其中一段? → refines
   ④ 本轮工件承载那条决策? → encodes,只点名可推出最终结论的最小集
   ⑤ 纯工序因果,无决策内容? → depends-on
   ⑥ 都不是 → 不记
3. 被拒?合法性由校验器机器检查,拒绝信息说明缺哪一半 → 补足最小缺失的 type,或改判关系。
- override/encodes 是软断言:拿不准 override,用 refines。

## 归属
- turn 属于其内容服务的任务段,至多一个;闲杂无归属是合法状态
- (结算侧)值域 = 该会话已挂靠段 ∪ 无归属;只纠显性失配,存疑不动
  - 正例:turn 通篇修改 A 段的模块,却挂在 B 段 → 改派 A
  - 反例:标题与 A 段相关,但内容看不出服务它 → 不动
```
