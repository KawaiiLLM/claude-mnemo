# 01 — 选举纪元发版钉值，否则评分比改之前更主观

**What to build:** 发版时把选举纪元钉到真实 cutover 时刻，并让 release-artifacts 守卫拒绝一个仍是占位值的纪元。在钉值之前，这次改动让评分**退化**而不是改善。

**证据链（三条同时成立才构成退化）：**
- `src/election-era.ts:20` `ELECTION_ERA_CUTOFF_EPOCH = 1_950_000_000`（约 2031），所以每个生产 turn 都读作 legacy。
- legacy turn 走 grade 路径：`src/worker/note-settlement-turn-facade.ts:503-514` 对 legacy turn 拒收 `tier`，要求 `grade (0-4)`。
- 而 0-4 标尺已从提示里删除：`src/worker/note-settlement-prompt.ts:53-59` 自陈「the long TASK_CAUSALITY_GRADE_RUBRIC text this file used to inline here is gone … a legacy turn still states grade, exactly as before, just without the rubric text taught here」。`TASK_CAUSALITY_GRADE_RUBRIC` 现在只被自己的测试引用。
- 同时 `grade` 已移出主 agent 的 `note` 工具（`src/mcp/definitions.ts:150-155`「grade simply left this tool」），天花板只校验 A/B tier，不校验 grade。

**用户裁决：** T816「turn等级是我觉得很别扭的设计，主agent打的等级是不准确的，现在的评价方式也很主观，想法是只走结算+分布限制」；T818「现在的等级太主观了，打分漂移严重…差额选举，分为3个等级 A B C，然后限制A B 分布为10% 30%」。净效果与裁决相反：结算继续打 0-4，**既无标尺也无分布约束**。

**先例：** `src/task-causality-era.ts:7` 的纪元就是发版时钉的，照抄那套。

**Blocked by:** None — 但必须与版本 bump 同批落地。

**Status:** ready-for-agent

- [ ] 纪元常量在发版时钉到真实 cutover epoch，不再是未来占位值
- [ ] release-artifacts 守卫在纪元仍为占位值时失败，使「忘记钉值」无法发版
- [ ] 钉值后跑一个真实窗口，确认 turn 走 tier 路径而非 grade 路径
- [ ] 若决定暂不启用选举：把 0-4 标尺重新装回结算提示，二者必居其一，不得两头皆空

> **⚠ 条件失效**：`.scratch/turn-edge-mechanism/spec.md` 取消一切评分，纪元没有可钉的对象。**但在该 spec 落地之前本票仍然有效**——现状是结算继续打 0-4 而标尺已删、天花板不管 grade，发版即退化。二者必居其一：先落边 spec，或先按本票钉纪元。
