# 01 — The settlement system prompt permits every tool revision 7 demands (peer P1-1)

**What to build:** the system-prompt sentence "Work entirely through the
remember/note/commit tools" (src/worker/note-settlement-prompt.ts
~196-201) contradicts the same prompt's user half, which now MANDATES
per-batch `recall` (Block A) and a finalization `lane_check` (Block B
step 5). System instructions win, so a compliant agent could refuse the
reads that earn its write grants. The sentence becomes the full
allowlist: remember, note, recall, timeline, lane_check, commit — with
the same one-line role note the current sentence carries.

Plus the guard the gap exposed: a test asserting the system half's tool
list is a superset of every tool name the user half instructs calling
(mechanical extraction from both strings), so the two contracts can
never drift apart silently again.

**Blocked by:** None.

**Status:** ready-for-agent

- [ ] System sentence lists all six tools; no other system-half change
- [ ] Cross-contract superset guard test red on the pre-fix text
- [ ] Territory: src/worker/note-settlement-prompt.ts (system sentence
      only — the authored user blocks are untouchable),
      tests/worker/note-settlement-prompt.test.ts
- [ ] Load-bearing properties declared for mutation acceptance
