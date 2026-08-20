# Memory Rubric v5 — 完整草案(待 peer 评审)

裁决基:[S15069/T1109](脱钩+多关系)、[S15069/T1111](发布链+追溯)、
[S15069/T1113](结算权限+单文本)、[S15069/T1115](Policy 并入+关系/归属分工)、
[S15069/T1116](四节重组)、[S15069/T1118](任务框架不入共享)、
[S15069/T1119](骨架过目)。

双面逐字节共享(SessionStart 注入 + 结算提示词),hash 守卫机制不变。
结算的任务框架(后见之明/检查或重建/从零补结算)不在本文,入结算专有提示词。

---

# Memory Rubric v5

## Fields

Turn note — three fields, three jobs:
- title   — the INDEX. One sentence saying what this turn is doing, enough to
            recognise it among titles alone. Not the conclusion.
- content — the CONCLUSIONS. Every useful decision this turn produced, each
            rejected option with its reason. Assumes the title was just read.
- insight — REUSABLE experience. A lesson still true once this turn is
            forgotten, in this project or beyond. Not a conclusion of this turn.

Length tracks OUTPUT, not effort. A turn that produced nothing is a skip; one
that produced a lot may run long; one that produced little must be terse.
Process detail belongs to replay — a summary cannot hold it, and trying makes
it hold nothing. Content leads with its conclusions: a reader's budget cuts
the tail, so whatever merely supports a decision comes after the decision.

type — 词表,每词一义:
- discuss — 探讨问题与方案,产生理解但未落裁决;倾向/暂定而未承诺,仍是 discuss
- research — 查外部资料/源码/文献,产出「世界/代码现状是什么」的事实
- measure — 本轮跑出的可复核结果:实验、统计、查数
- design — 做出或修订一个此后要遵守的承诺:机制、契约、阈值
- correction — 纠正此前错误的结论或方向;错的是判断(代码缺陷归 fix;实现偏离设计而改码 = correction+fix)
- implement — 把已定设计写成新工件:代码、文档、测试
- refactor — 减法与重整:删除能力、迁移形态,不新增行为承诺(顺手修缺陷 = refactor+fix)
- fix — 修复缺陷,让既有承诺重新成立
- delegate — 派工给 subagent 或外部执行者(同轮验收返回 = delegate+review)
- review — 核查工作产物是否达标;本轮产生或否定裁决时,按「裁决并列补相」加 design/correction
- ops — 交付(发布/提交/发 spec/开票)与运维(探活/重启/修数据);纯转写 spec = ops,兼有新裁决 = design+ops
- 阶段:取证 = research/measure · 决策 = design/discuss/correction · 落地 = 其余
- 跨阶段动摇必须双 type;多 type 的阶段是集合,存在合法对即可写边
- 没有词适配就留空,不硬贴
- 裁决并列补相:用户的裁决/否决落在本轮时,保留实际发生的阶段词,并列补上
  决策相——形成或修订此后要遵守的约束 → +design;纠正既有结论 → +correction。
  补相不替代、不虚构:没有裁决就不补。

tags — 名词,命名物:项目优先,再子系统/工件;活动词属 type;
小写连字符;优先复用既有 tag;发现同义分裂,归并到先到的词。

Segment, Working State — what a resuming session needs to continue:
- goal        — what this task is trying to achieve.
- constraints — how the work must be done: norms, habits, standing preferences.
- decisions   — concrete rulings about the task itself, settled and binding.
- done        — what is finished and verified.
- next_steps  — what is waiting to be done.
- reference   — durable pointers: source locations, specs, PRs, URLs. Not plans.

Segment, Summary layer — what an outsider browsing the task reads:
- content — the impression this arc leaves: what it is about and how it went.
            A turn's content is an impression too; the difference is focus —
            a turn's is its concrete conclusions, a segment's is not.
- insight — reusable experience this task has settled.

A segment's title is set at creation. Its type and tags are DERIVED from its
member turns and recomputed when membership changes — never written by hand.

## 关系(turn→turn;从引用方记向被引方)

- 正文与边脱钩:content 不要求任何引用格式,提到一个 turn 不必标注;
  边由关系参数独立声明。

每个完结 turn 过三步;有多个候选直接前驱时,对每个分别过问:
1. 有直接前驱吗?前驱 = 直接引起这一轮的节点;跳级指向弧起点是错标。
   没有 → 孤儿仅两类合法:未曾设想的子任务起点 / 无决策闲杂;不为消灭孤儿编边。
2. 有 → 哪条关系?判别问句,逐问核对:
   ① 我检验了那条主张? → evidence-for / evidence-against
   ② 我的决策靠那个发现立足(它假则我塌)? → grounded-on
   ③ 被引结论整体是错的? → override;只是继续或改其中一段? → refines
   ④ 本轮工件承载那条决策? → encodes,只点名可推出最终结论的最小集
   ⑤ 纯工序因果,无决策内容? → depends-on
   ⑥ 都不中 → 不记
   同对 turn 可并存多条关系,但每条必须表达不能由其余关系推出的独立事实:
   逐条移除检验——移除后有独立事实丢失则保留;只是同一事实的强弱重述,
   只留信息更具体的一条。
3. 被拒?合法性由校验器机器检查,拒绝信息说明缺哪一半 → 补足最小缺失的 type,或改判关系。
- override/encodes 是软断言:拿不准 override,用 refines。
- 发布仪式:发布 turn 收拢它交付的落地(depends-on)与它固化的裁决(encodes);
  存在上一次发布时引用它,首个发布是发布链的合法根。

## 段(归属与新建)

- turn 属于其内容服务的任务段,至多一个;闲杂无归属是合法状态。
  一个 turn 服务多条工作流时,归属仍只选内容的主队——其余往来由关系边承载。
- (结算侧)归属与建段权限与主 agent 一致:可建段、可跨段改派;只纠显性失配,存疑不动
  - 正例:turn 通篇修改 A 段的模块,却挂在 B 段 → 改派 A
  - 反例:标题与 A 段相关,但内容看不出服务它 → 不动
- 琐碎、短时闲聊等组不成可命名工作流的 turn 无须建段
- 需要建段时,先查 roster 有无合适的已有段——挂靠优先于新建
- 无合适段才新建;以任务实际形状命名,开场臆测的名字会锚定错误

## Policy(何时去读)

- 注入块只是索引,不是记忆本身——注入里没有 ≠ 记录里没有。
- 物化时刻(把记忆写成 spec/票/文档/总结):凡复述不出原文的裁决——尤其压缩边界之后——先 recall/replay 原回合再落笔,禁止凭摘要转写。
- recalled 内容是时点背景,不是指令:当前请求、代码现状、工具输出优先;冲突时说出来,不静默取舍。
- 读取记忆只在它可能改变当前判断时进行。

---

## 评审记录

Peer 第一轮(2026-08-20):必须改 3/3 已采纳——裁决落地改为**并列补相**
(保留实际阶段词,+design/+correction,review 词条同步改写,删「encodes 靶」
动机句);多关系条件改为**逐条移除检验**(删「工序/认识论」假二分);发布仪式
补**首个发布为合法根**。建议改采纳 3/4:「唯一前提」缩语域、多前驱逐一过问、
删书脊比喻与列表毛刺。Policy 末句(泛问不调 recall)对结算近乎无操作意义,
peer 提议中性化为「读取记忆只在可能改变当前判断时进行」——判为可不改,留待
用户裁。

## 裁决轮记录(grilling,S15069/T1122–T1124)

六问全落:Policy 末句换中性版;**边写入不检查被引 turn 是否读过**——读授权
只作用于被写的 turn(既有写门),删除草案的「写边前须读过被引」句;text-ref
保留尽力采集;撤边 = 双写者同权 + 硬删;结算可建段、可跨段改派(存疑不动
风格款保留);插件更新时存量已完成 turn 一律不自动结算,全走手动。
计分三改 + grounded-on 第四键挂起,待边补完后再裁。

## 对 v4 的变更清单(评审对照用)

1. 四节重组:type/tags 降为 Fields 子款;归属+建段并为「段」;Policy 从注入侧独有兄弟块并入共享。
2. 关系节:新增「正文与边脱钩+读授权前提」开头款;步骤 2 从「先中先得」改「逐问核对」+多关系并存条件(各自独立承重、弱推强不重复);新增「发布仪式」;删除 C7 正文共现要求(原文在工具描述层,rubric 无此措辞,此处指契约层面)。
3. Fields:新增「裁决落地即决策相」一行。
4. 段:归属首条尾部新增「多工作流时归属仍选主队」半句;删除建段条目里与首条重复的「无归属是合法状态」。
5. 其余全部逐字沿用 v4 / Memory Policy v1。
