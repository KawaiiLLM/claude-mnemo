# 02 — 遗留段的冻结判据必须记录，不能从 status 反推

**What to build:** 花名册只列本次重设计纪元之后的段。冻结判据改为记录事实（纪元时间戳或迁移时落状态），不再从 `status` 的当前值反推。

**证据：** `src/db/segments.ts:1336-1360` 用 `WHERE s.status = 'open'` 当 live 判据，其注释自陈前提：「no writer moves a segment created under this redesign off `open`, so `status != 'open'` today uniquely identifies those legacy rows」。**该前提对生产数据为假**——旧管线建的段同样默认 `open`。

生产库实测（只读）：14 个 `status='open'` 段中只有 **E48** 属于本次重设计，其余全是带活动前缀的旧 arc 段，且多数来自其他项目：

```
E9  measure+card-extraction-pipeline    E31 implement+intranet-llm-tunnel
E13 implement+engine-wiring-v2          E33 ops+san11-live-demo-ops
E18 implement+scene-data-v2             E45 implement+san11-mapc-terrain-research
E24 measure+quota-cache-economics       E46 research+san11-mapc-terrain-research
```

**文档：** ADR-0005「legacy arc-segments freeze as-is — readable via recall, **absent from the roster**」「Fragmented legacy topics never pollute the new layer」。这正是它要防的事，而防线没建成。

**注意：** 这条包含了此前被判为「以后再优化」的项目过滤——即使加了项目过滤，本项目的旧段照样漏进来。两者不可互相替代。

**消费者：** `src/hooks/session-composition.ts:180`、`countLiveSegments`（`segments.ts:1363`）。

**Blocked by:** None

**Status:** done（判据已修好并测过；生产落地还差一行——见下方裁量说明）

- [x] 冻结判据来自记录的事实（纪元或迁移落状态），不是对 `status` 的推断 — 新增 `SEGMENT_CONTAINER_ERA_CUTOFF_EPOCH = 1_786_981_737`（`db/segments.ts`，锚定 commit `e709279`「docs: semantic-container ADRs 0001-0007…」落地的秒级时间戳，2026-08-17 15:48:57 UTC；生产库验证：E1-E47 全部早于它，E48（本次重设计诞生的第一个新段）及以后全部晚于它，两者之间无其它段，故该值在证据缺口区间内不敏感）+ `isLiveSegmentEra(createdAtEpoch, cutoffEpoch)` 判据函数
- [x] 花名册候选集与溢出计数用同一判据 — `liveSegmentWhereClause` 一处生成 WHERE 片段，`listLiveSegmentsByActivity`/`countLiveSegments` 共用，物理上不可能给出不同总数
- [ ]（生产未激活，见裁量）花名册在生产数据上不再出现任何带活动前缀的旧 arc 段 — **裁量（超出票面字面，且是本票最大的偏离）**：`listLiveSegmentsByActivity`/`countLiveSegments` 新增的第三参数 `eraCutoffEpoch` 默认值是 **`null`（惰性，等价于本票之前的纯 status 判据）**，不是 `SEGMENT_CONTAINER_ERA_CUTOFF_EPOCH`。原因：本票在 `消费者` 一节点名的唯一生产调用方 `src/hooks/session-composition.ts:179-180`（`renderSegmentRoster`）在协调指令里被列为绝对不可改的文件（另一个 worker 正在那里工作）。第一版实现把默认值设成真实纪元，`session-composition.ts` 的两处裸调用（未传第三参数）因此自动继承新判据——但这直接改变了一个我不能碰、也不能修的文件的运行时行为，把它自己的测试套件（`tests/hooks/session-composition.test.ts`，用小纪元 fixture）打出 9 个红，而那个测试文件同样不在我的改动范围内。故改为惰性默认（与本文件里 `computeSegmentMemberFacetCounts`、`segment-era.ts` 的 `isSegmentEra` 同一惯例：`null` = 该判据关闭，行为与本票之前完全一致），保证 `session-composition.ts` 不被间接改写行为、其测试套件保持绿色。**后果**：本票的核心验收标准（生产花名册排除旧 arc 段）在今天的 SessionStart 注入里还没生效，直到 `session-composition.ts` 的 `renderSegmentRoster` 显式把 `SEGMENT_CONTAINER_ERA_CUTOFF_EPOCH`（或它自己的等价常量）传给这两个函数——这是一行改动，但落在我不可编辑的文件里，留给下一步集成。底层判据本身已完整实现并在 `tests/db/segments.test.ts` 里用显式传参验证（含直接用生产常量验证分类正确性的用例）
