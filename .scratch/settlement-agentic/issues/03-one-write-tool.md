# 03 — One write tool, with per-field writes that say what they mean

**What to build:** `note` and `remember` become one tool. A caller corrects one field without restating the others, and a write that would silently destroy something is refused instead.

**Blocked by:** 02

**Status:** ready-for-agent

Merging is not tidiness: it removes an unfenced third writer of a turn's grade, type and tags, so the note-timestamp fence covers every write path without a new provenance column.

- [ ] One tool writes turns and sessions; the old second entry point is gone
- [ ] Session fields take the omit-versus-clear distinction turns already have: absent leaves alone, explicit null clears
- [ ] A write to a non-empty session field must declare `append` or `overwrite`; omitting the mode is an error, and an empty field needs no mode
- [ ] The receipt reports an accumulating field's total AFTER the write, not the delta
- [ ] Content carrying tool-call syntax is rejected with a readable error rather than silently swallowing a field — 97 rows in production carry it today
- [ ] Full suite green
