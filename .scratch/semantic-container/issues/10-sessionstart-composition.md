# 10 — SessionStart injection composition

**What to build:** A session with bindings opens with **two independent blocks per
attached segment**: recall's collapsed card and timeline's milestone view, each
invoked with an explicit `pageBudget: 2000` (both tools' interactive defaults stay
1000 — the injection parameterizes, never re-renders). Both blocks self-identify
(`[E31] #topic · fields` / `[E31] #topic · milestones`). Roster follows: title +
derived facets with counts, coarse project tag as group header, recency-ordered,
budget-truncated, legacy arc-segments frozen out. Proposals last (≤3).
RecentSessions and the diary index leave SessionStart. The hook red line stands:
nothing floats on tool-adjacent channels.

Transport constraint (ADR-0006 amended): Claude Code persists an oversized hook
output to a file with a 2KB preview at roughly 10K characters — the mechanism
that already swallows today's milestones block (a known live defect this ticket
replaces). Every emitted block therefore asserts its rendered size below ~9.5K
characters and demotes further on breach. Whether blocks ride separate hook
registrations (fixed pool) or one command's `additionalContexts` array is decided
by an empirical test of the persist granularity — array if per-element, pool if
per-command.

**Blocked by:** 03, 05 (the two renderers); 08 (proposals to render); 09
(RecentSessions retirement).

**Status:** done — roster + proposals + a 3-slot fixed segment-block pool (6 hook
commands, `segment<k>-fields`/`segment<k>-milestones`) replace the old bare
`context`/`recent`/`milestones` sections. New module `src/hooks/session-
composition.ts` (pure composer: `renderAttachedSegmentBlock`,
`composeWithDemoteLadder`, `renderSegmentRoster`, `renderProposalsBlock`) +
handler file `src/hooks/handlers/context-segments.ts`; `context.ts`'s bare
`sessions` section keeps every side effect unchanged and now emits the roster
instead of the retired per-session state block. `context-milestones.ts` (the
old single-timeline SessionStart handler) deleted — `hooks/milestone-
injection.ts` itself stays, still used by settlement
(`worker/note-settlement-context.ts`). Full suite 2069/1 (the pre-existing
release-artifacts stale-bundle guard); typecheck clean. Four mutations
demonstrated live (see report): demote-ladder early-return removed (3 red),
roster's `status='open'` filter removed (1 red), the block-slot pool's
resume/compact gate removed (3 red), and a PreToolUse/tool-adjacent
registration injected into hooks.json (1 red, the existing red-line guard) —
all restored to green after.

**Persist-granularity verdict: POOL, and it is not actually a choice.**
Traced the CC source checkout (`~/Projects/claude-code-main/src`) end to end:
`SessionStart`'s `hookSpecificOutput.additionalContext` is `z.string()` in
the wire schema (`types/hooks.ts:77-165`, every hook-event variant) — one
hook invocation can only ever emit ONE string, never an array. The "array"
the ticket's ambiguity ruling names is entirely internal to Claude Code:
`processSessionStartHooks` (`utils/sessionStart.ts:50-172`) accumulates every
registered hook COMMAND's single string into one `additionalContexts: string[]`
across the WHOLE SessionStart batch, then `messages.ts`'s
`normalizeAttachmentForAPI` (the actual wire-message builder, called from
`normalizeMessagesForAPI` at `messages.ts:2270`) joins that array with `"\n"`
into ONE user message (`messages.ts:4117-4129`, case `'hook_additional_context'`).
I could find NO size-based branching anywhere in that path for SessionStart:
`MAX_HOOK_OUTPUT_LENGTH` truncation is UserPromptSubmit-only
(`processUserInput.ts:227-240,272-279`, confirmed — the established prior
fact), and `persistToolResult`/`maybePersistLargeToolResult`
(`utils/toolResultStorage.ts`) is only ever called from `Tool.ts` and
`mcpOutputStorage.ts`'s MCP client — never from `sessionStart.ts` or
`normalizeAttachmentForAPI`. So today's live milestones-only-persisted
behavior this ticket's brief names as an established fact is real, but its
mechanism is NOT reachable from this checkout's SessionStart code path — my
best account is that it depends on something outside what a static source
read can pin (a different/newer CC build, or a GrowthBook-gated path).
**Given that genuine gap between the documented empirical fact and what the
source shows, and given the ticket's own instruction for exactly this case:
took the pool.** It is also the only implementable shape (see above) and it
matches the live prior (today's 4-of-6-inline pattern is itself a pool).
**Cap: 3 attached segments** (`ATTACHED_SEGMENT_BLOCK_SLOTS`), 6 hook
commands (`segment1-fields` … `segment3-milestones`), activity-ordered
(`listAttachedSegmentsByActivity`); attachments beyond the cap get a recall
pointer from the roster (`overflowAttachedSegmentIds`), never a rendered
block.

**Newly discovered limitation (not solvable from the plugin side): declared
hooks.json order does not control final message order.** Claude Code's own
SessionStart executor (`utils/generators.ts`'s `all()`, used by
`executeSessionStartHooks`) races every registered hook COMMAND concurrently
via `Promise.race` and yields results in COMPLETION order, not declaration
order — this was already true of the pre-ticket-10 six-command setup and is
unrelated to the pool-vs-array question. hooks.json's declared sequence
(`context` (roster) → `persona` → `digest` → `notes` → `proposals` →
`segment1..3`) states the INTENDED reading order and is what a human sees in
the config, but Claude Code does not guarantee it survives into the joined
SessionStart message the model receives. Flagging for review — out of this
ticket's power to fix (it would need a Claude Code change, or collapsing back
to one synchronous hook command, which reopens the size-persist problem this
ticket exists to solve).

**Judgment calls flagged for review:**
1. **Legacy/frozen exclusion marker** = `segments.status != 'open'`
   (`listLiveSegmentsByActivity`, `db/segments.ts`). No dedicated column
   exists; I read ticket 02/06's actual deliverables and found neither left
   one. Reasoning: `createSegment`'s only production call site
   (`mcp/remember.ts`'s `create` verb) never passes a non-default `status`,
   and no verb in the current tool surface ever transitions a segment off
   `open` (ticket 08's own follow-up note: "no writer anywhere can set...
   close its status... an open spec gap"). So today, structurally, a
   non-open segment can only be one of the 47 pre-redesign rows ADR-0005
   named ("legacy arc-segments freeze as-is... absent from the roster").
   This is exactly the exclusion ADR-0005 asks for, derived rather than
   stored — accepted as reading the ADR correctly, but genuinely inferred,
   not stated verbatim anywhere.
2. **Roster/proposals/segment-block gating** = resume/compact only, same as
   the two sections they replace (old bare `sessions`, old `milestones`).
   `persona`/`digest`/`notes` stay ungated (unchanged). A fresh `startup`
   session cannot have pre-existing attachments, so segment blocks are moot
   there either way; the roster/proposals choice to also stay silent on
   `startup`/`clear` is more debatable — ADR-0002's "roster in view before
   create" arguably wants it visible on a cold start too. Kept conservative
   (matches prior behavior's gating boundary) rather than expanding scope;
   flagging as reversible if the user wants roster/proposals ungated.
3. **Roster shape** (topic-group header format, per-row facet display) is
   new content this ticket originates (not byte-composed from a reader).
   Chose `### <topic> (<segment count>)` for the group header and
   `#<tag>×<count>` for row-level facets (matching `segment-card.ts`'s own
   existing facet convention) — the ticket's own `claude-mnemo(32)` example
   maps ambiguously onto either the header or a row facet; I read it as
   illustrative shorthand, not a literal format pin, and reused the
   already-established `×`-count style for internal consistency instead of
   introducing a second facet notation.
4. **Corpus header retired, not relocated.** The old bare `context` output
   opened with `claude-mnemo: N sessions, M observations | current: S<n>` +
   an axes reminder line. ADR-0006's injection description does not mention
   it, and it read sessions/observations — axes this project demoted. Not
   reproduced inside the roster. If wanted back, it is a one-line addition.
5. **Proposals boilerplate wording**: `"ask the user before adopting this —
   never auto-create"`, appended per row in `renderProposalsBlock`. Ticket 08
   explicitly left this to ticket 10 as free text; no wording was pinned
   anywhere upstream.
6. **`ATTACHED_SEGMENT_BLOCK_SLOTS = 3`** — no number was pinned by the spec
   or ADR; chosen to match the "at most three" convention proposals already
   use, and to keep the hooks.json pool (11 total commands) close in size to
   today's 6. Easy to raise later; `plugin-config.test.ts` pins the hooks.json
   pool size to this constant so a future bump cannot desync the two.

**Review (accepted, with one judgment call overturned):** named re-checks
63/63; demote-ladder mutation independently re-run (never-demote → exactly
the claimed 3 red, all three the ladder's own pins; restored green); full
suite 2070/1 (stale-bundle guard only); typecheck clean; git status matched
the worker's file list exactly. Judgment calls 1, 3, 4, 5, 6 accepted as
flagged. **Call 2 overturned at review: the roster and proposals are now
UN-gated (render on every source), only the segment blocks keep
resume|compact.** Grounds: the roster's job — every segment's title+facets
"方便挂靠" — serves the session with no attachments yet, which is a cold
start; and ticket 08 stores a proposal "for the next session's injection",
which opens cold. Alongside, the proposals HANDLER now stays silent when
nothing is pending (the renderer's "(none pending)" line remains for direct
calls) — matching the slot handlers' "silent, not an empty block" convention
rather than charging every session a standing empty block. The injection
matrix now seeds a proposal and asserts roster+proposals on all four sources.
**Persist-granularity addendum (live evidence the static trace lacked):** the
reviewer's own running session persisted an oversized SessionStart block this
very day — "Output too large (17.5KB). Full output saved to:
…/hook-…-5-additionalContext.txt, Preview (first 2KB)" — and the file name
indexes a single `additionalContext` ELEMENT. So the running CC build does
persist per element (= per command, since each command emits one string),
even though the checkout's source shows no such path: the checkout predates
the running build. Both readings land on the pool; the <9.5K assertion is
what keeps every element under the line either way.

- [x] Each attached segment yields two blocks, byte-composed from the readers' outputs at pageBudget 2000 (wiring test — no dedicated renderer; tool defaults unchanged)
- [x] The persist-granularity experiment is run and recorded; the chosen emission keeps every hook output under the persist line, verified by constructing an overflow
- [x] Every block carries a post-render character assertion (<9.5K) that demotes on breach
- [x] Roster excludes frozen legacy segments and truncates on budget with a recall pointer
- [x] RecentSessions and diary index no longer render at SessionStart
- [x] Total injection scales linearly with attachment count and nothing else
