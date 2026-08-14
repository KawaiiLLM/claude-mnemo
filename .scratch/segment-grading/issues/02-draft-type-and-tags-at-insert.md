# 02 — Type and tags are drafted the moment a note lands

**What to build:** As soon as a turn has a note, that turn carries a drafted `type` and `tags`, parsed from the note title's own `<activity>+<topic>: <text>` shape — the activity half read against the closed type vocabulary, the topic half taken as the tag. A reader of the turn table sees the real activity glyph instead of a generic dot, and the settlement subagent later reviews a draft instead of inventing from nothing.

The draft is explicitly a draft: right often enough to be worth having, wrong often enough that ticket 05's review pass exists to correct it. So it must never guess. An activity word outside the closed vocabulary leaves the type column empty rather than writing an unrecognised word, because an empty column is reviewable while a wrong one silently poisons a `type:` filter.

One implementation only. The settlement context already derives this draft for its own prompt; the write path must call that same function rather than grow a second derivation that can disagree with it.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] Writing a note leaves its turn carrying a drafted type and tag
- [ ] The activity half is resolved against the closed vocabulary; an unrecognised word leaves type empty rather than written
- [ ] The topic half becomes the tag as written
- [ ] A title that does not match the `<activity>+<topic>:` shape yields neither, and is not an error
- [ ] The derivation is a pure function of the title — no database, no model — and is the single implementation the settlement context also uses
- [ ] Re-sending a note with `replace` re-drafts, so a corrected title never leaves a stale type behind
- [ ] Notes written mechanically by settlement backfill draft exactly as agent-written ones do
- [ ] Unit tests over titles cover the vocabulary hit, the vocabulary miss, the malformed title, and the replace path
- [ ] Full suite green
