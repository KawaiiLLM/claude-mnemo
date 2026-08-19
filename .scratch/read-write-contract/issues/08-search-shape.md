# 08 — 搜索形态

**What to build:** recall 有 query 时按分数排序、匹配词加粗并带邻域文本、词边界截断均摊。

规范:spec「一工具两形态」搜索半边。

- 分数序替代时序;匹配词**加粗**+邻域优先展示,替代默认字段均摊截断;尾部词边界切、两侧均分。
- 命中后的深入=用户用选择器自取 turn ±N(不做 ±N 参数,已裁决撤回)。
- 报错完善随 filter/选择器语法回显。

**Blocked by:** 07(渲染器内核)。

**Status:** done

- [x] 有 query:分数序+加粗邻域;无 query 行为不变(07 的浏览)
- [x] 邻域截断词边界、两侧均分
- [x] 搜索形态同样记录授权

## Implementation record (2026-08-19)

`renderGroupedSearchResults` (src/mcp/recall.ts) gained:

- `boldSearchSnippet(text, terms, windowChars, signal)` (exported, pure):
  finds the earliest case-insensitive occurrence of any query term, centers a
  window on it, cuts each side independently at a word boundary, bolds EVERY
  term occurrence inside the window (`**term**`), not just the anchor match.
  No term found falls back to the pre-existing plain word-boundary truncate.
  Applied to every search hit's `content` field (session/turn/observation)
  via `withSearchSnippet`, which shallow-clones the formatted view rather
  than mutating it.
- Score order preserved through rendering: turns within a session group now
  sort by their RELEVANCE RANK (index in the already-relevance-sorted
  `results` array), not `getTurnsForSession`'s chronological order.
- A session-level hit (matched by its own title/content, no specific
  turn/observation) now renders its own snippet-bolded collapsed line instead
  of the old full nested-session render — matches the ticket's "命中后的深入
  =用户自取,不做±N" ruling (dragging every turn along under a session hit was
  exactly the kind of automatic surrounding-context expansion that ruling
  withdrew).
- Read-grant recording: the query/search branch of `recallMemoryBody`
  recorded NOTHING before this ticket (the flagged gap named in the parent
  brief). Now every segment/session/turn shown accumulates into a `grants`
  array and is recorded via one `recordReadGrants` call at the end of
  `renderGroupedSearchResults`.

**Judgment calls**:
1. Segment hits (`renderSegmentSummary`) get a read-grant recorded but NOT
   bold/neighborhood snippet treatment — that renderer builds its lines via
   `renderSegmentHeaderLines` (segment-spine.ts), not a `FormattedX` view
   `withSearchSnippet` can patch; retrofitting it is a larger, separate
   change than this ticket's search-shape scope.
2. "±N 参数已裁决撤回" — confirmed no `±N` context parameter was added; a
   hit's own render is exactly what the existing turn/observation depth
   switch already shows, nothing more.

**Re-check commands**:
- `bun test tests/mcp/recall.search-shape.test.ts`
- `bun test tests/db/write-gate.test.ts`
