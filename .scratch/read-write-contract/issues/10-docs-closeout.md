# 10 — 文档收尾

**What to build:** 词表、ADR 与 spec 对落地状态对齐。

- **三个 plugin skill 文档按新契约重写**(mnemo-recall/mnemo-replay/mnemo-timeline):filter=结构化对象五谓词+fields、**query 无字符串内方言**(旧 `type:`/`tag:`/`project:` 前缀节全删——静默失败,比报错更危险)、两 token 预算、depth/truncate 已退役、id 逗号多选、序数 T 选择专用。skill 是发版后 agent 的主教材,stale 教材=T934 教训的重演。
- 新 ADR:读写契约(门的三判、写者身份、渲染即授权)——硬回退成本+真取舍俱备。
- ADR-0007 staged-apply 半边标 superseded(指向新 ADR 与 spec)。
- CONTEXT.md:Write gate 三词条核对;Settlement 词条随直写更新。
- spec 与十票状态一致。

**Blocked by:** 03、06、08、09、11、12、13、14。

**Status:** done (2026-08-19)

- [x] 新 ADR + 0007 注记
- [x] CONTEXT.md 词条与落地一致
- [x] spec 与十票状态一致

## Implementation record (2026-08-19)

**Three skill docs rewritten** (`plugin/skills/{mnemo-recall,mnemo-replay,mnemo-timeline}/SKILL.md`):
`mnemo-recall` — `filter` documented as the five AND-composed predicates
(type/tag/session/time/file) plus the display-only `fields` sixth member
(default title+content); a new "`query` is pure full-text search — it has no
in-string dialect" callout states the silent-failure risk explicitly (a stale
`type:`/`tag:`/`project:`/`session:` habit inside `query` now searches those
literal characters rather than erroring); the old `view`/`truncate` machinery
is gone, replaced by `pageBudget` (page overflow → next page, never a
truncated block) and `turn` (per-item word-boundary cut); comma id lists
(`"E31, E32"`) and the `E<n>/T<m>` selection-only ordinal (cite `S<n>/T<m>`
instead) are both documented; a new "Browse vs Search" section states the two
render shapes (chronological feed with session-title-on-first-appearance vs.
relevance-ranked with bold+neighborhood snippets); a rewind-marker note
points at `mnemo-replay`. `mnemo-replay` — the `raw:` hand-off no longer cites
`view="expanded"` (retired; `recall(id="S12")` always shows the pointer now),
and a new bullet extends the existing "don't trust `transcript_line_start`"
guidance to rewound turns specifically (their pointer is stale, not merely
imprecise). `mnemo-timeline` — `phases` removed everywhere (input enum, views
list, and the standalone "Phases" output section — the underlying
`segmentPhases()` function has zero callers, confirmed by grep, so this is not
merely an input-schema cut); a segment selector (`id="E<n>"`) is documented as
a new capability with its own range-syntax row, its cross-session candidate
scope, and its `S<n>/T<m>`-back-referenced turn table; `milestones` is
described as fixed lexicographic edge-signal order (overridden-exclusion →
encodes desc → refines-excess decision-then-delivery desc → recency), with
`pageSize` (not `pageBudget`) as the admission driver; `filter` is added to
the parameter table; the prompt-column char cap was corrected from the prior
doc's 200 to the actual `PROMPT_COLUMN_CAP` (100) while this section was open
regardless — an incidental fix, not a contract-batch change; "cross-session
timelines are out of scope for v1" is corrected to scope it precisely (only
through a segment selector — a bare session id stays single-session).

**ADR-0008** (`docs/adr/0008-read-write-contract.md`, new): Context/Decision/
Consequences, following ADR-0004's format. Decision covers the four-step gate
in fixed order, rendering-records-grants as the read/write hinge (one grants
table, written only by the shared renderer), the freshness-stamp table
(monotonic sequence, not epoch-seconds, plus the note→turn field-stamp
mapping that subsumes the old yield fence), the two writer identity schemes
(`session:`/`claim:generation`), settlement direct-write replacing
ADR-0007's staged-commit, and one-transaction-per-write as what actually
closes the check-then-write race. Consequences names the rewind-stamp gap
(Out of Scope, not silently dropped), the now-unneeded independent generation
check, ADR-0007's supersession, and explicitly resolves
`.scratch/turn-edge-mechanism/spec.md`'s own deferred "consumption side →
the view spec" caveat.

**ADR-0007**: status line reads "staged-apply half superseded 2026-08-19 by
ADR-0008 (was accepted · 2026-08-17)"; a blockquote under the title (same
placement precedent as ADR-0003's supersession note) names exactly which half
is superseded and which stands, pointing at ADR-0008. The original body
paragraph is left intact below it as the historical decision record, per the
same precedent.

**CONTEXT.md**: the intro's ADR range bumped `ADR-0001…0007` →
`ADR-0001…0008` (ADR-0008 is now the formal source for the "Write gate"
glossary section that ticket 01 already landed). Every other named entry
(Write gate's three terms, Roster, Topic — retired, Tag's theme-role
sentence, Settlement) was read against current landed reality and found
already accurate — no further edit; see judgment call 2 below for the one
considered and rejected.

**spec.md**: Status line → `implemented(read-write-contract 票
01–09/11–15,2026-08-19)`, one-line landed-mechanism summary, and a note that
it closes `turn-edge-mechanism/spec.md`'s deferred consumption-side caveat
(that sibling file's own line was deliberately left untouched — see judgment
call 1).

**Fifteen tickets**: 01–09 and 11–15 already carried `Status: done` before
this ticket started (prior agents landed them in-line with their own
implementation records) — verified via `grep -n "^\*\*Status:\*\*"
.scratch/read-write-contract/issues/*.md`, no edits needed there. This ticket
is the last one to flip.

**Judgment calls (flagged — please review)**:
1. **`turn-edge-mechanism/spec.md`'s own status line was NOT edited.** That
   file's "implemented" line carries the exact caveat this ticket's spec
   Status-line note now resolves ("里程碑准入与计分渲染的**消费侧**归视图 spec
   验收"). Editing it to remove/update that caveat felt like the more
   complete fix, but it sits outside this ticket's named file list (three
   skill docs, ADR-0008, ADR-0007, CONTEXT.md, this spec, these 15 tickets)
   and outside a different feature's directory — I chose not to touch another
   batch's spec file from inside this one. The read-write-contract spec.md's
   own new Status line states the resolution explicitly instead. If the
   parent wants the caveat text itself updated at its source, that is a
   one-line edit to `.scratch/turn-edge-mechanism/spec.md`'s Status line.
2. **CONTEXT.md's `Settlement` glossary entry was left unedited despite the
   ticket's own one-line brief naming it** ("Settlement 词条随直写更新"). Read
   closely, the current entry ("Never a first writer; a window with nothing
   to correct completes empty-handed") makes no claim about staged-vs-direct
   write timing at all — it is about segments (settlement never
   auto-instantiates one, only proposes) and about empty windows, both still
   true. Adding a sentence about per-write direct application felt like
   scope-widening the glossary's terse, definitional style into
   implementation-mechanism prose the other entries do not carry. Flagging
   this explicitly since the ticket's own text anticipated an edit that I
   concluded was not a genuine mismatch — if the parent disagrees, the fix is
   a one-sentence addition to that entry.

**Re-check commands**:
- `grep -rn 'type:\|tag:\|project:\|session:' plugin/skills/mnemo-recall/SKILL.md` — no in-string query dialect teaching survives outside the explicit "has no dialect" callout and the structured-`filter` table.
- `grep -n 'depth\|truncate\|"phases"' plugin/skills/mnemo-recall/SKILL.md plugin/skills/mnemo-timeline/SKILL.md` — zero hits.
- `grep -n '^\*\*Status:\*\*' .scratch/read-write-contract/spec.md .scratch/read-write-contract/issues/*.md docs/adr/0007-one-tool-surface-staged-apply.md docs/adr/0008-read-write-contract.md`
- `bun run typecheck && bun test` — docs-only batch, expect unchanged (2201 pass / 1 standing red).
