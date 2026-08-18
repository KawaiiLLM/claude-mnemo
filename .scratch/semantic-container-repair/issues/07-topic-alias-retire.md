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

**Status:** done

- [x] `findTopic` 不再读别名列 — 别名扫描分支整段删除，只剩精确（大小写/宽度不敏感）名字匹配
- [x] `upsertTopic` 不再接受 aliases — `UpsertTopicInput` 去掉 `aliases?: string[]`，合并/redirect 逻辑整段删除，INSERT/UPDATE 都不再写 `aliases` 列（该列靠 schema 默认值 `'[]'`）
- [x] 工具描述不再提及别名合并 — `definitions.ts` 的 `topic` 参数描述由「Reused verbatim or by alias when it already exists」改为「Reused verbatim when it already exists」
- [x] 请求一个新主题名时必定得到该名字，或明确的「已存在同名」 — 精确匹配下，一个未被精确复用的新名字必定 INSERT 出新 topic；无重定向可能
- [x] `aliases` 列保留但无人读写；是否清理数据另开票 — **裁量**：字面上「无人读写」我理解为「无人再用它做匹配/合并判断」；`TopicRecord.aliases`/`mapTopicRow`/`listTopicsByFrequency` 仍然 SELECT 并映射该列供内省读取（未删除该字段），因为它是现有公开类型的一部分，删除会是未被要求的额外收窄。列本身与生产数据完全未动
