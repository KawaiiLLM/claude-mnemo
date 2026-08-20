# Edge mechanism revision — 脱钩、多关系、结算重武装

**Status:** ready-for-agent(拆票见同目录 01–06)
**Ruling base:** [S15069/T1109]、[S15069/T1111]、[S15069/T1113]、[S15069/T1115]、
[S15069/T1116]、[S15069/T1118]、[S15069/T1121](peer 评审轮)、
[S15069/T1122]–[S15069/T1124](grilling 六裁)。
**Evidence base:** T900–T1000 边重建报告(`.scratch/edge-rebuild-t900-1000/report.md`)
的 A1–A11 表达力缺口与 B1–B7 选举限制;排水统计 1/21。
**Companion artifact:** Rubric v5 定稿草案(`rubric-v5-draft.md`,peer 一轮评审
+ 裁决轮已并入)。

## Problem Statement

图没长出来,而且长不出来。101 个 turn 的窗口里,重建前只有 2 条关系边;54/96
条笔记因为「关系必须由正文引用承载」+ 内容预算,连补边的资格都没有;发布收拢率
0/21。结算管线每天健康地跑完窗口,却一条关系边都不挂——它的窗看不见弧、它的
权限只许升级不许造、它的目标是存疑不动。同一对 turn 只能有一条关系,落地 turn
说不出自己既被工序依赖又承载裁决。用户的愿景「从发布出发追溯它固化的每条决策」
在当前机制下结构性不可达。

## Solution

正文与边彻底脱钩:content 回归纯散文,边由关系参数独立声明,唯一的机器检查是
被写(citing)turn 的既有写门与阶段合法性。同对 turn 允许多条关系(删边检验防
通胀),错边可硬删。发布形成自己的链。结算拿到主 agent 的全部写权限(50-turn
窗、窗内全笔记、建段改派、造边撤边),判断规则与主 agent 共享同一份 Rubric v5
文本,任务框架只在结算专有提示词里。插件更新时存量不自动结算,全走手动。

## User Stories

1. As the main agent, I want to declare an edge without touching any prose field, so that graph maintenance never competes with the content budget.
2. As the main agent, I want to write prose without any citation format obligation, so that content stays readable and inside budget.
3. As the main agent, I want a pair to carry depends-on AND encodes at once, so that a landing turn can state both its process cause and the ruling it carries.
4. As the main agent, I want to hard-delete a wrong edge, so that a false assertion does not outlive its refutation.
5. As the main agent, I want the release turn's edges to gather what it shipped and cite the previous release, so that the release chain reads as the project's chapter list.
6. As a settlement agent, I want the same tools, modes and gate as the main agent plus commit, so that I am not a second write surface anyone must reason about separately.
7. As a settlement agent, I want a 50-turn window, so that the arcs I am asked to connect fit inside what I can see.
8. As a settlement agent, I want to modify any note content in my range, so that hindsight corrections are not limited to four structured fields.
9. As a settlement agent, I want to mint edges on edge-less nodes and retract false ones, so that check-or-rebuild is a real capability, not a euphemism for upgrading leftovers.
10. As a settlement agent, I want to create segments and reassign turns across segments, so that membership repair does not stop at the session's own roster.
11. As a settlement agent, I want the judgment text I read to be byte-identical with the main agent's, so that the two writers cannot drift into two rubrics.
12. As the user, I want the plugin update to trigger zero automatic settlement over already-finished turns, so that a reload never becomes a token storm.
13. As the user, I want backfill to be an explicit manual command, so that from-zero rebuilds happen when I choose, at the scope I choose.
14. As the user, I want to trace from any release to every decision it solidified, so that "what did 0.12.0 ship" has a true answer.
15. As a future election design, I want multi-relation edges and honest phase supplementation in place, so that scoring reruns on a graph worth scoring.
16. As a reader of recall/timeline, I want prose turn-mentions still surfaced as display hints, so that historical text-refs stay visible without pretending to be relations.
17. As the write gate, I want edge writes attributed to the citing turn's writer under the existing grant rules, so that no new permission machinery exists for edges.
18. As a maintainer, I want the C7-era co-occurrence machinery deleted, not bypassed, so that the retired contract cannot half-fire.

## Implementation Decisions

**D1 — 脱钩(C7 双通道退役)。** 关系参数不再要求同调用触碰引用字段;不再要求
正文写后状态含目标地址;结算侧「pair 须先存在」栅栏同废。机器保留的检查只有:
被写(citing)turn 的写门(既有 read grant 机制,[S15069/T1124]:被引 turn
**不做**读检查)、地址存在、阶段合法、自引拒绝。

**D2 — 多关系。** 同对 turn 可并存多条关系。存储形态(spec 阶段定案,原型级):
bare pair 一行(relation NULL,partial unique index 保至多一行),每 (pair,
relation) 一行(五列 unique);自引 CHECK 入表。旧「relation 非空即覆盖」的
upsert 语义废除:关系写入是增行,纠错靠撤边+重写。

**D3 — 撤边。** 双写者同权,硬删([S15069/T1124]);按 (pair, relation) 定位。
审计走既有 dump 备份先例,不建墓碑。

**D4 — text-ref 降级。** `[S/T]` 解析保留为尽力采集,产物只作渲染提示(↳、被
引计数);任何代码路径不得再把 text-ref 当关系升级底座。

**D5 — Rubric v5。** 共享文本四节(Fields 含 type 词表+并列补相+tags;关系含
脱钩声明、逐问多前驱、删边检验、发布仪式含首发布合法根;段含结算同权款;
Policy 四条含中性末句),定稿在 companion 草案,逐字入 `MEMORY_RUBRIC_TEXT`;
Memory Policy 独立块退役并入;hash 守卫机制照旧。review 词条改「本轮产生或否
定裁决时,按并列补相加 design/correction」。

**D6 — 结算重武装。** consecutive 阈值 25→50(仅此触发器有阈值,其余事件驱动
不变);facade 对 title/content/insight 的硬拒撤销——显式回收 settlement-
agentic 批次「结算不再重建笔记」的裁决;归属动作开放建段与跨段改派;边动作 =
主 agent 同一套(D1–D3)。同门同要求:结算的上下文渲染须记 field completeness
(关闭 write-mode 票 07 留的豁免口)。commit 不变:唯一多余工具、认领校验、
终态标记。

**D7 — 结算提示词。** 共享 Rubric v5 之外的结算专款重写:任务框架(后见之明,
检查或重建;补结算从零重建)、权限声明、程序款(重建=调和:补缺/纠错/撤伪)、
commit 终检。差异化栅栏措辞(「pair 须先存在」「no append」残留类)删除。

**D8 — 过渡水位线。** 迁移时打水位:该时点已完结的 turn 一律不进自动结算计划
([S15069/T1124]);手动 backfill(既有 backfill trigger_type)是它们唯一的
结算通道。新纪元 turn 照常走 50-turn/compact/sessionend 自动触发。

**D9 — 发布仪式零机制。** 发布链纯属 Rubric 教学(D5),无新代码;首环
T1001→T998 已挂。

**D10 — 挂起区。** 计分三改(出度键、override 受害者、grounded-on 第四键)与
一切选举权重变更,等边补齐后拿真图再裁;本批次不触碰 edge-signals 的计分逻辑。

## Testing Decisions

好测试只测外部行为:工具调用进、回执/存储状态出,不测内部函数序。

- **最高缝 = 三个既有缝,零新缝**:(1) note/remember 工具处理器(prior art:
  tests/mcp/note.test.ts 的调用级测试);(2) 结算 facade 的 evaluate 函数与注
  册面奇偶性测试(prior art:tests/worker/note-settlement-parity.test.ts,断
  言差集恒为 {commit},本批次它必须**不改而绿**);(3) db 层边原语(prior
  art:tests/db/citations.test.ts 的触发器/级联测试)。
- Rubric v5 用既有 hash 守卫双渲染测试钉逐字节一致,并列补相措辞用文本断言钉。
- 迁移测试:旧五列表→新形态的重建,含 bare-pair 唯一性、多关系并存、自引拒
  绝、水位线落库。
- 变异纪律沿用本会话惯例:每票交付后主会话做一次针对承重声明的变异验证。

## Out of Scope

- 计分/选举任何改动(D10 挂起区)。
- 实际的补链执行:T998 排水、54 条超线笔记、旧纪元存量重建——全是发版 reload
  后的手动 backfill 运行,不是本批次代码。
- 发版本身(用户口令触发)。
- recall/timeline 渲染改版(text-ref 降级只删「升级底座」语义,不动展示)。

## Further Notes

- 字节账(peer 实测):主 agent 注入较现状 +805 B(约 +16%),结算面 +28%,
  远低于 hook ~10K 坍缩线。
- 本 spec 落地后签入 bundle 需重建;在发版 rebuild + /plugin 更新 + 冷重启前,
  线上插件仍教旧契约(2× 硬拒、C7 共现、25-turn 窗)。
- A 系列缺口中 A2(responds-to 缺词)、A3(grounded-on 源锁)、A7(预注册)本
  批次未裁,留作后续词表议题;A5/A10/A11 由 D2/D4/既往裁决消解或接受。
