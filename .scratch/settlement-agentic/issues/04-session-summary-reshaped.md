# 04 — The session summary describes now, and says who each field is for

**What to build:** A resumed session reads its own state in one screen without re-reading the transcript, and the fields that exist for other sessions stop competing with the fields that exist for this one.

**Blocked by:** 03

**Status:** ready-for-agent

Seven fields split by reader: `title`/`content`/`insight` are a compressed global view for a session browsing this one; `next_steps`/`decision`/`done`/`reference` cover recent events for the present one. `current` is deleted — it duplicated `content` at a different compression.

- [ ] `current` is gone from the write path, the injection and the renderers
- [ ] Each field carries a guidance value, reported in the receipt, never enforced by truncation (spec D9 has the numbers)
- [ ] Going over budget is a signal to the writer, not a loss to the reader
- [ ] The injected block no longer silently drops its tail
- [ ] Full suite green
