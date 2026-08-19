# 11 — 视图旧 API 退役(depth 二态 + truncate 字符参数)

**What to build:** 读工具的体量控制只剩 pageBudget/turn 两个 token 预算与 filter 字段选择;depth 与 truncate 从 schema 到渲染路径整体退役。

规范:spec「视图(读面)」预算 bullet([S15069/T972] 裁决)。

- `depth`(collapsed/expanded 二态)全仓退役:参数从 schema 移除,所有渲染路径改由 filter 字段选择表达细读(07 的 `filter.fields` 从加法机制升为唯一机制)。
- `truncate` 字符参数(默认 200/上限 2000)及字符上限机制退役:字段截断只由 `turn` token 预算驱动(词边界);obs 恒截断同样走 token 预算。
- 拒绝报文与工具描述随语法同步;既有测试按新契约改写。
- 07 票判断记录里「depth 保留」「truncate 双刀」的过渡状态由本票清算。
- `hooks/session-injection.ts` 及其测试(旧 elision 渲染路径)已于缝合针失去全部消费者,**物理删除归本票**(留而不用状态与 staging 引擎同款);`mcp/session-output.ts` 的 elision 机制若随 truncate 退役而无消费者,一并清算。

**Blocked by:** 07(渲染器内核,已 done)。

**Status:** done

- [x] schema 无 depth/truncate;传入被拒并回显新语法
- [x] 全部渲染路径字段截断仅由 turn token 预算驱动(构造性测试:同内容不同 turn 预算)
- [x] filter.fields 覆盖原 expanded 的全部信息面
- [x] 既有测试迁移,无 depth/truncate 残留引用(grep 断言)

## Implementation record (2026-08-19)

**Core mechanism (`src/mcp/format.ts`, rewritten):**
- `RenderDepth`/`depth`/`mode`(legacy vs unified) retired entirely from the render options — `renderNode` now takes `fields?: TurnRenderFields` (turn nodes) and applies `capRenderToTokenBudget` (renamed from `capTurnRenderToTokenBudget`, generalized) to EVERY node kind (session/turn/observation), keyed on the SAME `turn` budget, default `DEFAULT_TURN_TOKEN_BUDGET` = 150 (renamed from `..._COLLAPSED` — there is no more "expanded is uncapped" state).
- `DEFAULT_TURN_RENDER_FIELDS = {title, content, prompt}` — the exact field set the retired "collapsed" depth used to show (title+content unconditionally, prompt whenever a real title occupied the label). `filter.fields` (memory-filter.ts, unchanged from ticket 07) is now the SOLE selector; unset falls back to this default.
- Every per-field character cut retired: `DEFAULT_TRUNCATE`/`MAX_TRUNCATE`/`resolveExplicitTruncate`/`truncateCap`/`truncateLines`/`truncateCallHeader` all deleted. A field renders in FULL; `capRenderToTokenBudget` is the only thing that ever cuts it — it keeps the label line whole, keeps every subsequent line whole while it fits, WORD-BOUNDARY-cuts the one line that straddles the budget (new `truncateTextToTokenBudget`, binary search over `truncateText`'s own char limit against `estimateTokens`), then drops the rest with one marker.
- Six near-duplicate legacy convenience wrappers deleted (`formatSessionCollapsed/Expanded`, `formatTurnCollapsed/Expanded`, `formatObservationCollapsed/Expanded`, `formatTree` — zero production callers beyond one, replaced by `formatTurnCompact`).

**Public/worker schema (`src/mcp/definitions.ts`):** `view` (was accepted!) now rejected by `recallInputSchema`'s superRefine alongside `truncate`, both naming `filter.fields`/`pageBudget`/`turn` as replacements. `workerRecallInputShape` lost its `truncate`-stays-working exemption — now identical to the public shape.

**`src/mcp/recall.ts`:** every render function (`renderSession`, `renderTurnScope`, `renderObservationScope`, `renderSessionDetail`, `renderObservationDetail`, `renderGroupedSearchResults`, `renderRoutedId`, `renderBareOverview`, `recallMemoryBody`) had `depth`/`truncate`/`truncateCap` params replaced with `fields`/`turnBudget`. The bare browse feed (`buildBrowseFeed`/`renderBrowseTurnBlock`, ticket 07) was already fields+token-budget-driven — untouched.

**`src/mcp/segment-card.ts`:** `depth` dropped from `RenderSegmentCardOptions`/`RenderSegmentMembersOptions` — elision and the member index now key off `page` alone (`elides = page <= 1`; member index shows when `!elides`), collapsing what used to be 4 depth×page combinations onto page's own 2.

**Sanctioned deletions:** `src/hooks/session-injection.ts` + `tests/hooks/session-injection.test.ts` (0 consumers, confirmed via grep). `src/mcp/session-output.ts` + `tests/mcp/session-output.test.ts` (its only consumer WAS session-injection.ts — SessionStart stopped rendering session state in the 0.11.x session-field retirement, before this ticket; deleting it is this ticket's cleanup of the resulting dead chain). `getSegmentCitedTurnIds` (`src/db/segment-rank.ts`, 0 callers) + its now-unused `getOutgoingEdges` import.

**Settlement (`src/worker/note-settlement-context.ts`):** the full-render call now passes only `turn: SETTLEMENT_FULL_RENDER_BUDGET`; stitch test green.

**Judgment calls (flagged, not silently decided):**
1. `S<n>` session-DETAIL route (`recall(id="S<n>")`) now ALWAYS shows its turn preview + raw transcript pointer — the old default (`depth` unset ⇒ collapsed ⇒ summary only, no turns) is gone since there is no toggle left to suppress it. Chose "always show" over "never show" as the more useful default now that `turn`/`pageBudget` bound the result instead of a binary switch.
2. Segment card's old (depth="expanded", page=1) combination — full fields WITHOUT the member index — is no longer reachable; `page` alone now drives both. Reaching full detail is still one `page: 2` away.
3. `filter.fields` presence is NOT used as a surrogate "give me detail" signal anywhere — every route now behaves identically whether or not the caller sets fields (judgment call 1 folds the old session-route ambiguity into "always show", not into a fields-presence check), keeping `filter.fields`' meaning limited to exactly what it says: field selection.
4. `src/db/consulted-memories.ts`'s `isExpandedRead` heuristic (regex `"depth":"expanded"` over stored historical toolInput JSON) is UNTOUCHED — left out of scope, flagged: it will never match a NEW call after this ships (nothing emits that JSON shape any more), silently degrading "strong" read classification for future recall calls. Follow-up ticket should teach it the `filter.fields` shape instead.
5. `RenderNodeOptions` collapses what used to be four near-identical `*FormatOptions` interfaces into one shared shape — a consequence of `truncate`/`truncateCap`/`mode` retiring, not a separate redesign.
