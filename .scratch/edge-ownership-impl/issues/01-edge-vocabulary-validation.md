# 01 — 关系词表迁移与写入校验

**What to build:** note 工具的关系面切换为边 spec 的六词闭集,带阶段校验;主 agent 从此按新词表记边。

规范:`.scratch/turn-edge-mechanism/spec.md`(Implementation Decisions 全节)。

- 新关系参数 `refines`、`override`、`encodes`、`groundedOn`(存储词 grounded-on;引用方决策阶段、被引方取证或落地阶段;判别问句=「被引发现若假,本决策塌」;[S15069/T935] 补入,**不入任何计分面**),与既有 `evidenceFor`/`evidenceAgainst`/`dependsOn` 并列(存储词 evidence-for/evidence-against/depends-on 不变)。闭集七词。`supersedes` 参数移除:再传 = strict 解析错;既有 supersedes 边**冻结可读**,不迁移、不映射——局部替换 ≠ 整体作废([S15069/T926])。
- **关系两端仅限 turn**:`E<n>` 目标 = 参数错误,报文指明段联系走归属与 cites([S15069/T926])。既有 segment 端点旧边不动。
- **阶段派生一处成文**(取证=research/measure;决策=design/discuss/correction;落地=implement/refactor/fix/delegate/review/ops),供校验与票 07 计分共用。
- **校验**:一条边合法 iff 存在(来源阶段,目标阶段)对在关系表中允许该关系;多 type 用阶段集 exists-规则([S15069/T926]);拒绝时说明缺哪半(如「refines 需要来源含决策阶段 type,补 design」)。
- override/encodes 的**判别问句**进参数描述(「前驱任一子结论仍成立 → refines」;「只点名可推出最终结论的最小集」),声明为软断言,不机检。

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] 六词闭集是唯一可写关系集;`supersedes` 与 `E<n>` 目标以显式报错拒绝
- [ ] 每个阶段对的合法/非法关系各至少一例;纯 review 记 `refines` 被拒且提示补 `design`,补后放行
- [ ] 双 type turn 在 exists-规则下两端各自合法(`design`+`ops` 轮可被 refines 亦可发 encodes)
- [ ] 旧 `supersedes` 边的读取路径不变(timeline 注记照旧渲染)
- [ ] 参数描述含两条判别问句,definitions 的既有 token-cap 测试不超
