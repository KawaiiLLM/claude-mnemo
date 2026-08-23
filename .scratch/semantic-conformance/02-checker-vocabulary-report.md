# 02 — Checker reports out-of-vocabulary types and relations as facts

**Ruling (S15069/T1396):** 校验器加语义检查——是否存在语义外的边、节点 type 等。

**What to build:** the lane checker gains a vocabulary-conformance fact
block (reported, never enforced, like everything else it says):

- Turns among the loaded scope whose `type` contains words outside the
  current closed vocabulary, or whose type is EMPTY — these are phase-empty
  and nearly edge-illegal, the exact condition that starved job 76's window
  to 9 edges. Report count + offending ids (capped list) + the offending
  words.
- Edges among the loaded turns whose relation lies outside the current
  eight-word vocabulary (e.g., the frozen-legacy `supersedes`). If the
  loader's SQL currently filters these OUT before the checker sees them,
  surface them as a count/list through the loader rather than widening the
  graph semantics — out-of-vocabulary edges stay out of every graph/report
  computation; they are reported, not admitted.
- Both surfaces: the CLI render and the settlement compact output (within
  its budget discipline); the settlement lane_check description names the
  new facts in one clause so the agent knows to read them (pairs with
  ticket 01's re-annotation duty — the checker points, settlement re-annotates).

**Blocked by:** None (parallel with 01).

**Status:** done (mutation-verified: edge partition → 3 red, loader query → 1 red; compact-marker exemption ruled at acceptance)

- [ ] Unit fixtures: legacy-typed turn, empty-typed turn, supersedes edge —
      each reported with ids/words; a fully-conforming fixture reports clean
- [ ] Golden T900-1001 fixture: record whatever is true (current types are
      conforming; any stored supersedes edges appear in the report) — no
      golden adjustment, discrepancies are STOP-AND-REPORT
- [ ] Existing reports 1-4 byte-stable; typecheck clean; load-bearing
      properties declared per criterion
