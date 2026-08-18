# 03 — 笔记节奏改积压制

**What to build:** 逐 prompt 注入只剩当前 turn 地址;积压 ≥5 出提醒、降回 <5 停;时机契约单一归家。

规范:`.scratch/ownership-and-note-cadence/spec.md`「笔记节奏」节。

- **欠账后缀退役**:current-turn line 不再携带 owed 信息(结构性恒真——shift-0 全库实测 0 次,见 spec Problem 节)。地址供即时的段归属与边操作使用。
- **积压提醒**:阈值沿用 `NOTE_RELIEF_PENDING_THRESHOLD` = 5,持续重渲染直到降回 5 以下([S15069/T870])。
- **契约改写不叠加**:现行规则二(「欠账在本轮第一批工具调用里结清」)整体改为「积压提醒出现时开一批补写」;规则一(只给已完结 turn 写笔记)不变。措辞在工具描述与 SessionStart 文本中**只出现一次**——0.11.1 的事故即两处各说一套,测试须断言单一归家。

**Blocked by:** None — can start immediately.

**Status:** done

- [x] 0 条、4 条积压无提醒;5 条渲染;降回 4 条后停
- [x] current-turn line 无任何欠账后缀
- [x] 笔记时机措辞的单一归家断言(工具描述与 SessionStart 文本不得各说一套)

## Implementation record

`hooks/note-reminder.ts`: `formatOwedSuffix` (and its byte-level D3 shapes)
deleted outright — no replacement, no dead branch. `renderNoteBacklogRelief`
(threshold, display limit, re-render-while-≥5 behaviour) is UNCHANGED.

`hooks/handlers/session-init.ts`: the per-transaction `owedSuffix`
computation removed; the current-turn line is now the bare
`mnemo current turn: S<session>/T<prompt>` with nothing appended. The
`reliefText` computation (still gated on `NOTE_RELIEF_PENDING_THRESHOLD`)
is untouched.

`mcp/definitions.ts` (`MNEMO_TOOL_DESCRIPTIONS.note`): rule 2 rewritten from
"owed addresses settle in this turn's FIRST tool batch, last among its
calls" to "a batch of note/skip calls alone opens when backlog relief
appears, or to fix a note already written — never just to write one turn's
note early" (rule 1 unchanged, per spec). The address-source clause dropped
"its owed suffix" (both on the tool description and `noteInputShape.turn`'s
own describe) since the suffix no longer exists.

`hooks/handlers/context-note-taking.ts` (SessionStart block): already said
"Timing... live in the note tool's description" as of 0.11.1
(commit 8ed27ca, prior work) — the single home was structurally already
correct. This ticket's own change here is narrower: dropped "its owed
suffix" from the address-source line (the format it pointed at is gone) and
added the doc-comment cross-reference to the new single-home test.

Single-home test (NEW, `tests/hooks/context-note-taking.test.ts`): a
cross-file assertion, not two doc comments trusting each other — four timing
signature phrases ("note only FINISHED turns", "never the one in progress",
"backlog relief appears", "never just to write one turn's note early") are
each asserted present in `MNEMO_TOOL_DESCRIPTIONS.note` AND absent from
`NOTE_TAKING_INSTRUCTIONS`. This is the exact shape of check the 0.11.1
incident (two files, two rules, silently contradicting) would have caught.

Also fixed two stale doc-comment references (no behaviour change) in
`hooks/hook-command.ts` and `hooks/handlers/prompt-dispatch.ts`, both of
which described the retired owed-suffix mechanism in a comment.

Tests: `tests/hooks/note-reminder.test.ts` (formatOwedSuffix tests replaced
with a retirement regression guard), `tests/hooks/session-init.test.ts`
(the whole `describe("owed-notes injection")` block rewritten: 0/4/5/drop-
to-4 cases, all asserting a bare current-turn line below threshold and the
unchanged relief block at/above it).

Mutation demos (both restored after verifying red):
1. Reintroduced timing prose into `NOTE_TAKING_INSTRUCTIONS` (the literal
   0.11.1 shape) → the new single-home test in
   `tests/hooks/context-note-taking.test.ts` goes red.
2. `session-init.ts`'s relief-block gate changed from `>=` to `>` → the
   exact-5-owed-turns test AND the N/N-1-race test in
   `tests/hooks/session-init.test.ts` both go red (30 pass/0 fail baseline
   → 28 pass/2 fail mutated → 30 pass/0 fail restored).
