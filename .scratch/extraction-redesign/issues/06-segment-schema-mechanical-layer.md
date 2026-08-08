# 06 — 段/主题/边 schema 与机械层（P2）

**What to build:** 结算的数据基座与全部纯码机件（spec D5/D6/D7/D11）。段表（与 turn 同 schema：title/content/type 多值/tag/status/revision）、主题注册表（name/aliases/status）、成员多对多边表、**通用边表**（节点=turn|段，provenance ∈ {retrieval, text-ref, rollback, judged}，主键幂等；既有 turn↔turn 边数据迁入）。S/T 引用解析器 + 曝光台账校验（非法引用进日志不进边表）。别名匹配器：title 前缀→type 草稿，匹配不上落 unknown；「回退」值仅结算可写。段写入 revision CAS 原语：冲突段写从主事务剔除、随最新段身返回（裁决 14）。FTS 摄取与 status 解耦：机械捕获时索引 turn 原文 + obs 截断原文（输入/输出各前 500 字符），skipped 不删索引（R2#4，需改现行删除行为）。consulted_memories 机械采集：recall/replay 实际命中的记录 id（带类型前缀命名空间），expanded/原文级读取标强命中。

**Blocked by:** None（可与 05 并行）。开工前提同 05：P1 达标裁决。

**Status:** ready-for-agent

- [ ] 边表迁移保留全部既有引用边，数据零丢失
- [ ] 解析器：三类合法格式通过；未曝光/不存在 id 拒收进日志
- [ ] CAS 冲突路径单测：并发写同一开放段，后写被拒并取回最新 revision
- [ ] skipped turn 的原文可被 FTS 命中；obs 截断原文入索引
- [ ] consulted_memories 按命中类型与强度记录
- [ ] type 草稿：前缀命中落枚举值、未命中落 unknown、回退值拒绝非结算写入
