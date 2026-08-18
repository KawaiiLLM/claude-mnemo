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

**Status:** ready-for-agent

- [ ] 冻结判据来自记录的事实（纪元或迁移落状态），不是对 `status` 的推断
- [ ] 花名册在生产数据上不再出现任何带活动前缀的旧 arc 段
- [ ] 溢出计数与候选集用同一判据，二者不会给出不同的段总数
