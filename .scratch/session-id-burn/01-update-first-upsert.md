# 01 — Stop the session-id burn: update-first, insert only when missing

**What to build:** the session upsert stops consuming an AUTOINCREMENT id on
every capture touch. Today `INSERT ... ON CONFLICT(content_session_id) DO
UPDATE` burns one sequence number per conflicting call (empirically verified
on bun:sqlite: three upserts on one key leave `sqlite_sequence` at 3, the
next new key gets id 4) — production census: sessions **221 rows, max id
23327, sequence 23484** (~105× burn), while turns 13135/12762, observations
86172/86172, segments 66/66, memory_edges 3636/3515 are all healthy. Session
ids render into EVERY address surface (`[S<n>/T<m>]` citations, injection
blocks, notes, edges, timeline), so the burn is a compounding token tax: at
the current touch rate the ids cross six digits within months (user ruling
S15069/T1481: the token cost is real; my "cosmetic, don't fix" verdict at
T1480 is overruled).

Fix shape: rewrite `upsertSession` as UPDATE-first, INSERT-only-when-no-row,
inside the existing transaction; the INSERT may keep its ON CONFLICT clause
purely as a race guard (it then fires ~never, so no steady-state burn). The
merge semantics must be preserved EXACTLY as the current DO UPDATE states
them: `project` last-writer-wins; `transcript_path` FIRST-non-null (a later
cwd must not move it); `title`/`content`/`insight`/`next_steps`/
`last_compact_turn`/`summary_updated_at_epoch`/`completed_at_epoch`
non-null-last-writer (`COALESCE(excluded.x, sessions.x)`);
`created_at_epoch`/`updated_at_epoch` overwritten. The RETURNING contract
(same columns, same shape) survives unchanged for callers.

Out of scope: renumbering existing sessions (stored citations pin them —
forbidden), resetting `sqlite_sequence` (saves 156 dead numbers, worthless),
the other `ON CONFLICT` sites (their tables' ids never render into
agent-facing text).

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] Repeated touches of an existing session leave `sqlite_sequence`
      unchanged; a genuinely new session advances it by exactly 1
- [ ] Merge semantics pinned field-by-field per the list above, including
      transcript_path's reversed COALESCE direction
- [ ] RETURNING shape identical; existing callers untouched
- [ ] Territory: src/db/sessions.ts and its tests only
- [ ] Load-bearing properties declared for mutation acceptance
