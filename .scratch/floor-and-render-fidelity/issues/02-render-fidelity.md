# 02 — Recall renders only what the caller selected: no prompt fallback, budgeted prompt field

**What to build:** the turn label renders the stored title when `title` is
selected and present, else the bare address + status marker — the structural
prompt fallback and the `Untitled` placeholder both die. `prompt` is a field
like any other (user ruling S15069/T1477: 「prompt不也是字段，如果不选就应该
忠实留空，而不是替调用者决定」): it renders solely as its own explicit field
row, when selected or when an FTS match hit the prompt text
(`MATCH_CONDITIONAL_TURN_FIELDS` — the query asked for it), and in BOTH
channels it obeys the same per-item `turn` token budget as every other field.
Today the fallback bypasses that budget entirely — one synthetic notification
prompt starves the whole page and the delivery envelope behind it, so
requested fields (relations included) never deliver and the write gate then
rightly refuses (the S15069/T1469 incident).

Consequences inside this ticket:

1. A note-less turn's read runs the NORMAL field-render path: requested
   fields deliver and record their grants — a relations read of a zero-edge
   note-less turn must grant the relations gate.
2. Fixed-shape surfaces (timeline views, segment member listings) are
   callers too: they DECLARE `prompt` in their own field set where they want
   note-less turns legible, rather than inheriting a hidden fallback. Keep
   their current visible behavior by explicit selection, now budget-capped.
3. Settlement Block A coverage amendment: note-less turns in the writable
   set must be read with `prompt`+`response` fields, or backfill windows
   judge blind. The amendment text is AUTHORED BY THE DELEGATOR (standing
   rule: prompt text is hand-written), handed to this ticket verbatim;
   production copy re-syncs word-for-word and the verbatim guard plus pins
   update with it.

**Blocked by:** None — can start immediately (01 is independent; this
ticket's Block A amendment serves the noteless-extracted turns 01 creates,
but neither gates the other).

**Status:** ready-for-agent

- [ ] Unselected/absent title → bare `[T<n>]` + status marker; no prompt
      leakage on any surface that did not select it
- [ ] Selected `prompt` renders as its own field row, cut at the per-item
      `turn` budget; match-conditional prompt render likewise capped
- [ ] A giant-prompt note-less turn no longer starves the page: sibling
      turns and subsequent fields still deliver within `pageBudget`
- [ ] Relations read of a note-less zero-edge turn records a grant the
      relations gate accepts
- [ ] Settlement production prompt matches the amended authored file
      word-for-word (guard test reads the file)
- [ ] Territory: src/mcp/format.ts, the recall/timeline render call sites,
      .scratch/tag-mandate/issues/06-prompt-text.md +
      src/worker/note-settlement-prompt.ts sync, their tests. NOT
      src/db/turn-completion.ts (ticket 01's)
- [ ] Load-bearing properties declared for mutation acceptance
