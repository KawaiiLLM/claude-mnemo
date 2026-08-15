# 04 — The session summary describes now, and says who each field is for

**What to build:** A resumed session reads its own state in one screen without re-reading the transcript, and the fields that exist for other sessions stop competing with the fields that exist for this one.

**Blocked by:** 03

**Status:** ready-for-agent

Seven fields split by reader: `title`/`content`/`insight` are a compressed global view for a session browsing this one; `next_steps`/`decision`/`done`/`reference` cover recent events for the present one. `current` is deleted — it duplicated `content` at a different compression.

- [ ] `current` is gone from the write path, the injection and the renderers
- [ ] Each field carries a guidance value, reported in the receipt, never enforced by truncation (spec D9 has the numbers)
- [ ] Going over budget is a signal to the writer, not a loss to the reader
- [ ] An accumulating field's receipt reports its total AFTER the write, not the delta
- [ ] The receipt also reports how many turns have passed since the summary was last updated — the one figure of the two that names an action
- [ ] That figure travels WITHOUT its healthy band: a field's guidance value ships with its usage because meeting it is the goal, but the cadence target stays operator-side, because a writer that knows the number updates to reset the counter and the diagnostic reads healthy by construction (spec D8a)
- [ ] The injected block no longer silently drops its tail
- [ ] Full suite green
