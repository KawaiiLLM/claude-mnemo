# 02 — A turn states its own type, and a turn may have more than one

**What to build:** The writing agent names what a turn did when it writes the note, and a turn that did two things says both. The timeline shows real activity words again instead of the placeholder every row has carried since the extraction agent was retired.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

Vocabulary is eleven peers: `discuss`, `research`, `design`, `implement`, `refactor`, `fix`, `measure`, `review`, `ops`, `delegate`, `correction`. `write` and `chat` and `rolled-back` leave; see spec B2-B4 for each word's definition and the boundaries that measurement showed failing.

- [ ] `turns.type` holds a list, as a segment's already does; a single value still round-trips
- [ ] The write tool accepts `type` and `tags` from the caller
- [ ] The mechanical title-to-type derivation is gone, not kept as a fallback
- [ ] An illegal or absent activity word leaves the type empty; empty is never a claim
- [ ] Tags are bare topic words — no `topic:` prefix is applied to new writes; existing prefixed rows are left alone
- [ ] The timeline renders a turn's activity, and a multi-valued turn renders sensibly
- [ ] recall's `type:` filter matches within the list
- [ ] Full suite green
