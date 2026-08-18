# 07 — 主题别名匹配退役

**What to build:** `findTopic` 只精确匹配主题名，`upsertTopic` 去掉 `aliases` 参数。不加任何替代机制——防碎片化交给花名册/主题清单的可见性。

**用户裁决：** 「从没说过要别名表，就不要乱加机制」。

**它是什么：** `src/db/segments.ts` 的 `findTopic` 先精确比主题名，再扫每个主题的别名数组。命中别名时返回的是**另一个**主题，而 `remember(create)` 的回执只打印最终名字，不说明发生过重定向。实测：请求 topic `semantic-container`，拿到 `observation-pipeline`。

**它从哪来：** 不是本次加的，也没有任何现役代码在写它。全仓唯一 `upsertTopic` 调用在 `src/mcp/remember.ts:318`，不传 aliases；除 `db/segments.ts` 自身与建表语句外，`src/` 内再无一处提到 `aliases`。这是上一代提取管线留下的数据，而 `findTopic` 仍在照它改判。

**它已经坏到什么程度：** 生产库 24 个主题中 17 个带别名。`observation-pipeline` 一个主题吞了 10 个名字，其中包括仓库名本身：

```
observation-render, claude-mnemo, memory-hygiene, diary-milestone-layers,
segment-grading, type-vocabulary, settlement-architecture, citation-edges,
semantic-container, segment-as-semantic-container
```

别名越多的主题越容易捕获下一个新名字，然后再多一个别名——正反馈。

**顺带：** `src/mcp/definitions.ts:329-335` 的 `topic` 参数描述把别名表写进了工具契约，一并删除。

**Blocked by:** None

**Status:** ready-for-agent

- [ ] `findTopic` 不再读别名列
- [ ] `upsertTopic` 不再接受 aliases
- [ ] 工具描述不再提及别名合并
- [ ] 请求一个新主题名时必定得到该名字，或明确的「已存在同名」
- [ ] `aliases` 列保留但无人读写；是否清理数据另开票
