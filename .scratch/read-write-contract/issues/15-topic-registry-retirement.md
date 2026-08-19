# 15 — topic 注册表退役

**What to build:** topic 的信息折入 tags,注册表整体退役;段只以 `E<n>` 寻址。

规范:spec 视图节 roster 重建条 + [S15069/T979-981] 裁决(「tag 本就是记录 topic 的」——同类信息两套机制=机制层同义分裂)。

- `remember(create)` 去掉必填 `topic` 参数;`attach` 只认 `E<n>` 地址,按名解析退役(传名字→拒绝并回显 `E<n>` 语法)。
- **迁移**:每个段的 topic 名折入该段 tags(bare tag,小写连字符归一,去重)——信息在幸存机制中存续;随后 `topics` 表与 `segments.topicId` 退役(rebuild 迁移,schema.ts 既有惯例)。
- 消费面清理:结算 roster 条目去 topic 字段;段卡片头 `(topic)` 去除;`getTopic`/`getSegmentsForTopic`/`listTopics` 等注册表读面随消费者清理。
- 风险背书:全库无计分/过滤依赖 topic,纯展示+解析。

**Blocked by:** 14(roster/attach 同域)。

**Status:** done

- [x] create 无 topic 参数可用;attach 传名被拒回显地址语法
- [x] 迁移后每段 tags 含原 topic 名(归一、去重);行数零丢失
- [x] fresh 库无 topics 表;legacy 库迁移幂等
- [x] topic 无功能性引用(grep;历史注释豁免)

## Implementation record

**create/attach (requirement 1/2).** `remember(create)` no longer reads or
requires `topic` (`src/mcp/remember.ts`). `topic` stays *declared* on
`rememberInputShape` (`src/mcp/definitions.ts`) purely so `rememberInputSchema`'s
new `superRefine` can reject a caller still sending it with a message naming
the retirement and pointing at tags — the same precedent `recallInputSchema`'s
retired `truncate`/`view` already set. `resolveSegmentTarget` (shared by
attach/append/replace/close/assign) now accepts ONLY a bare `E<n>` address;
a non-address `id` is rejected echoing the `"E<n>"` grammar. Verified live:
`bun -e` against `rememberInputSchema.safeParse({verb:"create",title:"x",topic:"y"})`
returns `success:false` with message `` `topic` has retired — the topic
registry folded into tags; tag the segment's member turns instead. ``

**Migration (requirement 3, the flagged tricky part).** `retireTopicRegistry`
(`src/db/schema.ts`, wired into `initializeSchema` after
`retireTurnCitesRecordedColumn`, before `repairDerivedSegmentFacets`):
1. `foldTopicNamesIntoSegmentTags` — for a segment WITH members, the topic
   name (normalized: NFKC, lowercase, whitespace collapsed to `-`) is folded
   into every MEMBER TURN's own `tags` (deduped, case-insensitive), then
   `recomputeSegmentFacets` re-derives `segments.tags` immediately in the
   same pass — this is the durable home, since `segments.tags` is DERIVED
   and a direct write would be overwritten by the next membership event.
   For a ZERO-member segment there is no such source; this writes the tag
   **directly** onto `segments.tags` — the one write in this migration NOT
   proof against a future recompute (if that segment later gains its first
   member, the membership event's own recompute supersedes the seeded tag).
   Flagged prominently in the function's own doc comment; no new machinery
   invented to close this gap, per the ticket's own instruction.
2. `segments` rebuilds without `topic_id` (SQLite 12-step ALTER TABLE,
   `retireTurnCitesRecordedColumn`'s own precedent), then `DROP TABLE IF
   EXISTS topics`. `PRAGMA foreign_keys OFF/ON` wraps the rebuild, same
   reasoning as `ensureSegmentStatusVocabulary`.
`SCHEMA_SQL`'s `topics` table and `segments.topic_id`/`idx_segments_topic_status`
are gone — a fresh install never creates either.

**Judgment call — `ensureSegmentStatusVocabulary` left untouched.** That
function's own rebuild DDL (`segmentsStatusVocabularyRebuildDdl`,
`SEGMENTS_INDEXES_DDL`) still declares `topic_id` and
`idx_segments_topic_status`. Deliberately NOT stripped: it is ticket 05's own
hand-kept legacy-shape rebuild for a database that predates the `closed`
status, and such a database (being older) still HAS `topic_id` for real.
Stripping it there would either silently discard a legacy segment's
`topic_id` before `retireTopicRegistry` gets to fold it, or entangle two
independent migrations. `retireTopicRegistry` runs strictly after it in
`initializeSchema`'s sequence and cleans up regardless. Two more
`topic`-bearing lines are equally deliberate: `resetSchema`'s
`DROP TABLE IF EXISTS topics` (a "nuke everything" utility that already
carries other retired table names, e.g. `memories`) and
`tests/db/schema.segment-status-vocabulary-migration.test.ts`'s own downgrade
fixture (needed a `topic_id INTEGER` column added back so
`ensureSegmentStatusVocabulary`'s INSERT has somewhere to read from — the
column is otherwise unpopulated by that fixture).

**Consumers (requirement 4).** `NoteSettlementSegmentRosterEntry.topic`
dropped; `renderSegmentRoster` (`note-settlement-prompt.ts`) drops the
`(topic)` suffix. `segment-card.ts`'s header drops `#<topic>`/`(no topic)`.
`session-composition.ts`'s `segmentBlockHeader`/`renderAttachedSegmentBlock`
drop their `topicName` parameter (`[E<n>] · <kind>`, no more `#<topic>`);
`topicNameForSegment` retired along with its only caller
(`hooks/handlers/context-segments.ts`). `db/segments.ts` retired
`upsertTopic`/`findTopic`/`getTopic`/`listTopics`/`listTopicsByFrequency`/
`getSegmentsForTopic`/`TopicRecord`/`TopicStatus`/`TOPIC_STATUSES`/
`SegmentWithTopic`; `listRecentSegments`/`listLiveSegmentsByActivity` now
return plain `SegmentRecord[]` (their topic-name join is gone). `recall.ts`
updated its one caller and its "mints one from a topic" message.

**Tests.** `tests/db/segments.test.ts`'s whole "topic registry" describe
retired with its consumer; `tests/mcp/remember.test.ts`'s topic-based
attach/close tests replaced with E&lt;n&gt;-only rejection tests;
`upsertTopic`/`topicId` scaffolding dropped from
injection-matrix/session-composition/context-segments/segment-spine tests.
New `tests/db/schema.topic-registry-retirement-migration.test.ts` (6 tests)
covers: fresh install has neither `topics` nor `topic_id`; fold+dedupe+derive
for a segment with members, zero row loss; case-insensitive dedup against an
existing tag; the zero-member direct-write case; idempotency; and acceptance
criterion 5 (`recall(filter:{tag:"segment-redesign"})` finds a segment whose
topic was folded).

**Verification.** `bun run typecheck` clean. `bun test` (full suite):
2201 pass, 1 fail — exactly the standing `tests/shared/release-artifacts.test.ts`
stale-bundle guard (never rebuilt bundles, per this ticket's constraints).
`grep -rn "topic" src/` functional hits are zero outside: the retired
`topic:` tag-namespace machinery (`shared/tag-stripping.ts` and its
consumers, a different retired concept per the ticket's own carve-out), this
migration's own necessary `topic_id`/`topics` reads while the column/table
still exist, and the two deliberately-untouched legacy-shape exceptions
above.
