# 02 — 七词:refute 并入 override,相位轴退出关系词表

**What to build:** 关系词表从八个降到七个,`refute` 的语义并入 `override`;写入判定不再做相位配对,`verify`/`override` 也不再要求引用方带取证 type。写入面、门面与全部教学面同批改口。

**Blocked by:** None — can start immediately.

**Status:** done

实测依据:「多相位 turn 任一配对合法」这个逃生口开着时,全库存活的人写边里**只有 1 条**不合法;关掉逃生口则 309/609(51%)不合法 —— 让图合法的是逃生口,不是相位轴。取证条件在 asserted 数据上 19/20 已经合规,而它抓到的唯一一条真违规(`S15069/T839`,一个 `["design"]` turn 去 refute 一次测量)在合并后按新语义是合法的。

- [x] `refute` 从词表消失,它的语义写进 `override`:主要结果被否决、撤回、替换。名字取覆盖面大的那个。
- [x] 相位配对与取证 type 条件从写入判定中移除;两者的文档注释一并重写,不留下为已废规则辩护的文字。
- [x] 主 agent 与结算两侧的工具描述、plugin skills、提示词副本同批更新。
- [x] 钉住旧规则的测试**就地替换**为钉住新许可的测试,而不是删掉后另起。
- [x] 数据迁移不在本票(见 03),但本票落地后旧的 `refutes` 行仍可读、不崩。

**File ownership:** 词表与写入判定所在的共享模块、两侧门面与工具描述、教学面。**不碰** checker 的报表与错误类(票 04 拥有),**不碰** 迁移(票 03)。

---

**Done (lane-model v12, ticket 02).** 词表 `EDGE_RELATIONS` 降到七词;`refutes` 转为
retraction-only(与 `supersedes` 同列于 `db/citations.ts` 的 `RETRACTION_ONLY_RELATIONS`),
存量行仍可读、可撤,断言字段整个消失。相位配对与取证条件从
`shared/turn-phase.ts` 删除(`RELATION_PHASE_REQUIREMENT` /
`isRelationLegalForPhases` / `explainRelationPhaseRejection` /
`SAME_PHASE_RELATIONS` / `EVIDENCE_SOURCE_RELATIONS` / `PHASE_CANONICAL_TYPE` /
`phase-illegal` 与输入里的 `citedPhases` 一并退役),三相位本身保留 ——
`db/edge-signals.ts` 与 `shared/lane-checker.ts` 仍按相位分桶。

教学面:rubric §Relations 的 **八词** 改 **七词**、删 **相位配对** 段、每条词条去掉
同/异相位前缀(版本仍 v11,票 12 整段替换时再 bump);两侧工具描述、结算提示词
Block B 第 2/3 步、`plugin/skills/mnemo-timeline/SKILL.md`、`CONTEXT.md`。
新增哨兵 `tests/shared/seven-word-teaching-surfaces.test.ts`。

**遗留给 04:** rubric 的 **自引** 段仍写着「其余七词不得自引」(八词时代的数法)与
「本 turn 须含落地相位」——整段属票 04 删除范围,未动。
