# 01 — Long prose fields move last, and the syntax rejection names what it saw and when it loops

**Ruling (S15069/T1428-T1429):** 1+2 as one ticket; auto-recovery (server-side
un-gluing) explicitly declined — the write gate stays loud-failure.

**What to build:** two defenses against the glued-tool-call failure
(S15069/T1426-T1427 forensics: field-name closing-tag drift at long-value
boundaries, then exemplar lock-in making every retry identical):

1. **Parameter order** — in the shared note input shape (the ONE set of zod
   objects both the main `note` tool and the settlement facade consume):
   structural short params first (turn, title, skip, crossSession, segment,
   type, tags, mode), then the relation/retraction arrays, then `insight`,
   then `content` dead last. Rationale: the drift trigger is next-field
   salience at a long value's closing boundary; the longest field gets the
   successor-free boundary, the second-longest sits beside it. Zero semantic
   change; property order must survive into the serialized JSON schema the
   model sees.
2. **Rejection message upgrade** in the tool-call-syntax guard path:
   - *Shape echo*: when the guard fires, split the offending field at the
     first fake field-name closing tag and parse the glued tail (same
     recovery parse the T1426 repair used); the message then names, in
     PROSE, which fake closing was written and which parameters rode in as
     literal text ("content ends with a closing tag named after the field
     itself; insight, type and tags were glued on as literal text — they
     did not land"). RED LINE: the message must never reproduce
     angle-bracket markup verbatim — it returns into the caller's context
     and every quoted fragment is another exemplar feeding the attractor.
   - *Loop naming*: the MCP server process keeps a consecutive
     syntax-rejection counter keyed by turn address (in-memory is fine —
     the server lives as long as the session that could loop). From the
     SECOND consecutive rejection for the same address, the message
     escalates: this exact failure repeated N times means the context is
     reproducing the malformed serialization — stop retrying; leave this
     note to settlement, or write it once after a compact. A successful
     write (any field, that address) resets the counter.

**Blocked by:** None — can start immediately. Independent of the
tag-mandate batch.

**Status:** done (mutation-verified: order swap → 2 red note-surface only; charset widening → adversarial red; strictness removal → 3 red; threshold 2→99 → 4 red)

- [ ] Schema order pin: the serialized JSON schema's property order for the
      note tool lists content last and insight second-to-last; the
      settlement facade sees the same order (shared objects, one edit site)
- [ ] Guard message pins: fires on a glued fixture naming the glued
      parameters in prose; the message string itself PASSES
      containsToolCallSyntax (self-referential no-markup guarantee)
- [ ] Loop escalation pins: first rejection = shape echo; second
      consecutive rejection same address = loop-naming message; success
      resets; a different turn address does not inherit the counter
- [ ] Recovery parse is strict: a tail that does not parse as
      field-blocks-plus-call-end falls back to the generic message (no
      misattributed echo)
- [ ] Typecheck + targeted suites green; control-byte scan on touched files
