# 01 — The reference parser matches whole tokens

**What to build:** A bracketed reference is only a citation when the whole bracket is one. Text a reader would never see as a citation stops creating one.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

Executed against the current implementation, `[[S1/T2]]`, `[foo [S1/T2]]` and `[[S1/T2] ]` all yield a citation to T2, contradicting the parser's own comment that a malformed bracket is skipped whole. Everything downstream that asks "does the body cite this turn" is only as strong as this.

- [ ] A nested or padded bracket yields no reference: `[[S1/T2]]`, `[foo [S1/T2]]`, `[[S1/T2] ]`
- [ ] A well-formed reference still parses, alone and mid-prose
- [ ] The address token itself must match whole, not as a substring
- [ ] Existing callers keep working; no existing citation behaviour regresses
- [ ] Tests state each malformed shape as its own case, so a future regex change fails loudly
