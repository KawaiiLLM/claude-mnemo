# 01 — 字段定义进注入,预算硬拒改为回执提醒

**What to build:** 写笔记的 agent 能从注入里直接读到「每个字段是什么」——turn
的三个字段与段的八个可编辑字段各有一句定义;超预算不再拒收,而是每次都在回执里
提醒。

**Ruling base:** [S15069/T1073](title 是索引、content 是全部有用决策)、
[S15069/T1074](2× 不拒,超 1.5× 回执提醒;书写规则两处都要)、
[S15069/T1075](按种类分层,并把段字段一起说清)、[S15069/T1076](constraints
与 decisions 的分界;两个 content 不改名,靠定义分焦点)。

**Blocked by:** none。与 `.scratch/view-render-repair/05` 和
`.scratch/write-mode-edit-semantics/` 均无文件重叠。

**Status:** ready-for-agent

## A · 预算:硬拒退役,回执每次提醒

- `BUDGET_REJECTION_MULTIPLE = 2` 的**硬拒整条退役**。超 2× 的笔记允许存在。
- 任一字段超过 **1.5×** 其预算时,回执**每次**加一行提醒。**不是提醒一次就沉
  默**——裁决理由原话:「如果只提醒一次无法抑制一直超写」。不要为此建任何状态。
- 回执现有的比值行(`content 168/100 → 191/120 (1.6×)`)保留,提醒是它之外的一
  行,措辞要让人知道:偶尔超可以,长期超不行。
- 现有那些断言「超 2× 被拒、什么都不存」的测试要翻;逐条列出翻了哪些、为什么。

## B · 字段定义,三处分层

**注入(rubric 块)**:只放下面这份定义表,不放书写细则。放进 rubric 是因为它已
经是「数据怎么判」的家(type/tags/关系/归属/建段);注入的 note-taking 块继续只
管地址规范,不动。

定义表**逐字使用下文,不要改写**:

```
## Fields

Turn note — three fields, three jobs:
- title   — the INDEX. One sentence saying what this turn is doing, enough to
            recognise it among titles alone. Not the conclusion.
- content — the CONCLUSIONS. Every useful decision this turn produced, each
            rejected option with its reason. Assumes the title was just read.
- insight — REUSABLE experience. A lesson still true once this turn is
            forgotten, in this project or beyond. Not a conclusion of this turn.

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
```

**工具字段描述**(`definitions.ts` 的 note 与 remember):完整书写契约仍在这里,
但要与新定义一致——`title` 的描述现在说「这一轮的结论」,必须改成索引语义;
`content` 要写明「本轮产生的全部有用决策,含被否选项及其理由」;`insight` 要写明
「可复用经验,不是本轮结论」。段字段的描述同样逐个对齐上表。

**SKILL.md 不动**:它是读面文档,当前没有写面字段教学,不要凭空加。

## C · 单一家守卫要改,不是绕过

`tests/hooks/context-note-taking.test.ts` 有一条守卫(「timing contract has
exactly one home」),拿注入串直接比对工具描述,防止复述。它保护的是
[S15069/T781] 的裁决,而那条裁决有真实事故背书:当年两个家的措辞漂移成互相对立
的两句话,agent 反复做了规则明令禁止的事。

**本票不是推翻它,是按种类分层。** 守卫改为断言两件事:

1. 注入块含这份字段定义表(存在性)。
2. 注入块**不含**书写细则——细则只在工具描述里。

时间规则(timing)的单一家**不变**,仍只在工具描述,守卫的这一半原样保留。

## D · 注入体积

这份表进 rubric 会撑大那个 hook 槽(它已与 memory policy 同槽,有硬字符上限)。
**报告里必须给出改动前后的字节数与上限余量**。超限就回来报告,不要自行删减定义
文字——那是裁定过的措辞。

## Acceptance criteria

- [ ] 超 2× 的笔记能写入成功。
- [ ] 任一字段超 1.5× 时,回执带提醒;连续三次超,三次都带。
- [ ] 未超 1.5× 时不带提醒。
- [ ] 注入的 rubric 块含上面那份定义表,逐字一致。
- [ ] 注入块不含书写细则;工具描述含完整契约且与定义表不冲突。
- [ ] note 的 `title`/`content`/`insight` 三条描述已按新语义改写。
- [ ] 段八个可编辑字段的描述与定义表一致。
- [ ] 单一家守卫按 C 改写并通过;timing 的那一半不变。
- [ ] 报告给出注入块字节数变化与上限余量。
- [ ] typecheck 干净;全套绿,只余既定的陈旧包守卫红。

## Ground rules

- NO git write commands。报出改动文件清单,主会话提交。
- 不碰 `~/.claude-mnemo/`、`plugin/scripts/`、版本号、`src/worker/`、
  `src/mcp/timeline.ts`(另一张票的 worker 正在其中)。
- 不要自行重建 bundle。
- 定义表的措辞是裁定过的,**一个字都不要改**。觉得有问题就回来报告。
