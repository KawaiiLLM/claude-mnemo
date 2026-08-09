# 06 — 段/主题/边 schema 与机械层（P2）

**What to build:** 结算的数据基座与全部纯码机件（spec D5/D6/D7/D11）。段表（与 turn 同 schema：title/content/type 多值/tag/status/revision）、主题注册表（name/aliases/status）、成员多对多边表、**通用边表**（节点=turn|段，provenance ∈ {retrieval, text-ref, rollback, judged}，主键幂等；既有 turn↔turn 边数据迁入）。S/T 引用解析器 + 曝光台账校验（非法引用进日志不进边表）。别名匹配器：title 前缀→type 草稿，匹配不上落 unknown；「回退」值仅结算可写。段写入 revision CAS 原语：冲突段写从主事务剔除、随最新段身返回（裁决 14）。FTS 摄取与 status 解耦：机械捕获时索引 turn 原文 + obs 截断原文（输入/输出各前 500 字符），skipped 不删索引（R2#4，需改现行删除行为）。consulted_memories 机械采集：recall/replay 实际命中的记录 id（带类型前缀命名空间），expanded/原文级读取标强命中。

**Blocked by:** None（可与 05 并行）。开工前提同 05：P1 达标裁决。

**Status:** done

- [x] 边表迁移保留全部既有引用边，数据零丢失
- [x] 解析器：三类合法格式通过；未曝光/不存在 id 拒收进日志
- [x] CAS 冲突路径单测：并发写同一开放段，后写被拒并取回最新 revision
- [x] skipped turn 的原文可被 FTS 命中；obs 截断原文入索引
- [x] consulted_memories 按命中类型与强度记录
- [x] type 草稿：前缀命中落枚举值、未命中落 unknown、回退值拒绝非结算写入

## Comments

**实现记录（本票落地时的取舍，后续票需知）**

- 「三类合法格式」按裁决 15 解读为：全限定 `[S/T]`、带注释 `[S/T 说明]`、段 `[E<n>]`；裸 `[T<n>]` 与逗号列表明确不解析（整个方括号丢弃，沿用旧文法「不做部分打捞」）。
- 曝光台账（`note_id_exposures`）只记 turn（列有 `REFERENCES turns(id)`），故段引用默认只查存在性；`validateReferences` 留 `exposedSegmentIds` 参数，调用方一旦能提供段曝光集即自动启用同一道闸。
- 通用边表 `memory_edges` 不进 `SCHEMA_SQL`：一次性迁移的闸门是「本次 open 前表不存在」。`migrateTurnCitationsToEdges` 另导出且幂等，P2 切换前可再跑一次补齐迁移后旧路径新写的边（本票不做双写——超出「只改 FTS + consulted_memories」的活行为边界）。
- 旧 `turn_citations` 行迁入时 provenance 落 `judged`（那批边只来自提取 agent 的显式 `cites`，是模型判定，不是作者文本引用）。
- provenance 不进主键：同一 (citing, cited, relation) 重复写只做**升级**（judged > text-ref > rollback > retrieval），`created_at_epoch` 保留首次。
- FTS 解耦的连带效应：recall 的 turn 查询本就没有 status 过滤，所以 `skipped`/`undone`/在途 turn 现在会进搜索结果（08 渲染票需补 status 过滤）；obs 读路径仍有 `status='extracted'` 过滤，故 obs 截断原文只在索引层可验证。
