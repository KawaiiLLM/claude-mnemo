# 04 — `remember` can correct a single field, on any turn

**What to build:** A caller can fix one field on a turn without restating the others, on segment-era turns as well as legacy ones, and can *clear* a field that holds a wrong value rather than only overwrite it with a different one.

Two things block that today. Era turns are refused outright by a write gate added when the extraction agent was retired, so the review pass has no write path at all. And an omitted field is indistinguishable from a cleared one, because the write coalesces against the existing row — which means a value can be replaced but never removed.

Per-field patching itself already exists and is kept; this ticket removes the refusal and adds the missing "clear" expression.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] A segment-era turn is writable through `remember`
- [ ] A single field can be patched with every other field left exactly as it was
- [ ] A field can be explicitly cleared, and clearing is distinguishable from omitting — both at the tool surface and in what lands
- [ ] An out-of-range grade or an unrecognised type is rejected rather than written
- [ ] Guardrails unrelated to the era — caller identity, cross-session writes — keep working unchanged, with their existing tests still green and untouched
- [ ] Tests cover patch, clear, omit, and the era turn, at the tool boundary rather than against the row writer
- [ ] Full suite green
