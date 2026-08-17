# 04 — Structured filter + dialect cuts

**What to build:** One filter grammar `{type, tag, session, time, file}` shared by recall and timeline, AND-composed with each other and with recall's `query`, which becomes pure FTS text — the in-query prefix dialect (`type:`/`tag:`/`file:`/`session:`/`project:`) is cut clean, not aliased. The character `truncate` parameter and timeline's `phases` view retire. Tool descriptions teach the new grammar.

**Blocked by:** 03 — recall segment card (parameter surface it edits).

**Status:** ready-for-agent

- [ ] The same filter object produces the same subset semantics on both tools
- [ ] A query containing old prefix syntax searches it as literal text — no hidden filtering
- [ ] `truncate` and `view:"phases"` are parse errors; descriptions document the replacement
- [ ] Segment field rows remain first-class FTS hits under the purified query
