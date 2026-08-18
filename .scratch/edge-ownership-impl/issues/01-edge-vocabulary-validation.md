# 01 — 关系词表迁移与写入校验

**What to build:** note 工具的关系面切换为边 spec 的六词闭集,带阶段校验;主 agent 从此按新词表记边。

规范:`.scratch/turn-edge-mechanism/spec.md`(Implementation Decisions 全节)。

- 新关系参数 `refines`、`override`、`encodes`、`groundedOn`(存储词 grounded-on;引用方决策阶段、被引方取证或落地阶段;判别问句=「被引发现若假,本决策塌」;[S15069/T935] 补入,**不入任何计分面**),与既有 `evidenceFor`/`evidenceAgainst`/`dependsOn` 并列(存储词 evidence-for/evidence-against/depends-on 不变)。闭集七词。`supersedes` 参数移除:再传 = strict 解析错;既有 supersedes 边**冻结可读**,不迁移、不映射——局部替换 ≠ 整体作废([S15069/T926])。
- **关系两端仅限 turn**:`E<n>` 目标 = 参数错误,报文指明段联系走归属与 cites([S15069/T926])。既有 segment 端点旧边不动。
- **阶段派生一处成文**(取证=research/measure;决策=design/discuss/correction;落地=implement/refactor/fix/delegate/review/ops),供校验与票 07 计分共用。
- **校验**:一条边合法 iff 存在(来源阶段,目标阶段)对在关系表中允许该关系;多 type 用阶段集 exists-规则([S15069/T926]);拒绝时说明缺哪半(如「refines 需要来源含决策阶段 type,补 design」)。
- override/encodes 的**判别问句**进参数描述(「前驱任一子结论仍成立 → refines」;「只点名可推出最终结论的最小集」),声明为软断言,不机检。
- **校验器是共享域层**(peer 讨论定案,[S15069/T939]):闭集常量+阶段映射+合法性判定住一个共享模块,**不内联于 note 工具**;note 面与票 08 的结算纠错面必须消费同一校验器与同一常量——「主 agent 被拒、结算能绕」的双标准由构造排除。schema enum、reader 分支、提示词表都从这一个常量派生或由守卫测试同步。

**Blocked by:** None — can start immediately.

**Status:** done

- [x] 七词闭集是唯一可写关系集(六词起步,[S15069/T935] 补入 `groundedOn`);`supersedes` 与 `E<n>` 目标以显式报错拒绝
- [x] 每个阶段对的合法/非法关系各至少一例;纯 review 记 `refines` 被拒且提示补 `design`,补后放行
- [x] 双 type turn 在 exists-规则下两端各自合法(`design`+`ops` 轮可被 refines 亦可发 encodes)
- [x] 旧 `supersedes` 边的读取路径不变(timeline 注记照旧渲染)
- [x] 参数描述含两条判别问句,definitions 的既有 token-cap 测试不超
- [x] 校验器从 note 面之外可直接调用且拒绝语义一致(为票 08 的共享消费铺路的种子测试)

## Implementation record

Shared domain module `src/shared/turn-phase.ts` (new): `TYPE_PHASE`
(type→phase, three phases), `EDGE_RELATIONS` (seven-word closed set —
`evidence-for`/`evidence-against`/`grounded-on`/`refines`/`override`/
`encodes`/`depends-on`), `RELATION_PHASE_REQUIREMENT` (relation → one OR
more legal (source,target) phase pairs — `grounded-on` alone carries two),
`isRelationLegalForPhases`, `explainRelationPhaseRejection` (names the
missing half), `validateRelationTarget` (THE shared judgment: segment-target
refusal + phase-pair legality, called by `mcp/note.ts` today and available
for ticket 08's settlement correction surface unchanged), `RELATION_FIELD_NAME`
(relation → camelCase parameter name, exhaustive `Record` so drift is a
compile error), `UNSCORED_RELATIONS` (`grounded-on` excluded from ticket 07
scoring).

`db/citations.ts`: `CITATION_RELATIONS` widened to eight storage-legal values
(seven new-vocabulary + `supersedes`, kept for frozen reads/settlement).
`attachTurnRelations` itself is UNTOUCHED — the ticket-01 narrowing
(segment-target refusal, phase gate) lives one layer up in `mcp/note.ts`,
so `tests/db/citations.test.ts`'s existing segment-target-eligible test
needed no change.

`db/schema.ts`: `memory_edges.relation` CHECK widened to the eight values
(comment-only elsewhere). KNOWN GAP: no `ensureSegmentStatusVocabulary`-style
rebuild migration for an EXISTING database's physical CHECK constraint —
`CREATE TABLE IF NOT EXISTS` only applies the widened list on first creation.

`mcp/note.ts`: `RELATION_FIELD_ENTRIES` now DERIVED from `EDGE_RELATIONS`/
`RELATION_FIELD_NAME` (compile-time exhaustiveness, not a second literal).
`checkRelationTargetPhase` resolves an address/DB lookup locally, then
delegates the judgment to `validateRelationTarget`.

`mcp/definitions.ts`: `noteInputShape` gained `groundedOn`/`refines`/
`override`/`encodes`; `supersedes` field OBJECT stays defined (unexported
from the schema) only because `settlementNoteInputShape` still reuses it by
reference — `noteInputSchema` is built via `.omit({ supersedes: true
}).strict()`, which is what actually retires it from the wire. Tool
description's relation ladder is now six ordered questions (dependsOn moved
question 3→5); note cap held at 420 unchanged.

Tests: `tests/shared/turn-phase.test.ts` (new, direct-validator seed tests
included), `tests/mcp/note.test.ts` (relation-attach block rewritten with
phase fixtures + one test per phase pair + dual-type + pure-review + segment-
target), `tests/mcp/definitions.test.ts` (guard test pinning
`RELATION_FIELD_ENTRIES` against `EDGE_RELATIONS`), `tests/db/memory-edges.test.ts`
(frozen-read regression + storage-legality of the four new words).

Mutation demos (both restored after verifying red):
1. `isRelationLegalForPhases` forced to always return `true` →
   `tests/mcp/note.test.ts` 86→81 pass (5 phase-gate tests red).
2. `validateRelationTarget`'s segment-target branch disabled →
   `tests/shared/turn-phase.test.ts` AND `tests/mcp/note.test.ts` both go
   red on the identical assertion, proving the ticket-08 hand-off is real
   (one shared function, not two copies that happen to agree today).
