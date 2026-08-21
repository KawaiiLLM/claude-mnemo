# 01 — 流派生模块:分支、定案、归属继承(纯函数)

**What to build:** A pure derivation module: given an in-memory list of turns
(id, type[]) and relation edges, compute the decision-layer flows (BRANCHES,
not connected components), each flow's settlement(s), and the inherited flow
membership of delivery/evidence turns. No database access in the core — a
pure function over inputs (the DB reader adapter is ticket 02's job). Flows
are derived views, never stored; the module must be cheap enough to recompute
per read (reference: 2.4 ms full-DB in the peer's Python prototype — 12304
turns, 849 edges, 174 flows).

The algorithm's derivation lives in the peer session's notes — recall
S21460/T93..T112 before designing (branch semantics at forks, the
override-terminated branch, inheritance direction). Key semantics to honor:
- A flow is one chain of decisions joined by narrows/extends; at a fork the
  directions are SEPARATE flows (T900 forks into three settlements — 23
  flows on the window where connected components count 21).
- An override TERMINATES a branch: T954's branch died of T958's override,
  its settlement set is EMPTY (the pinned special case — see the peer notes
  for how collects reaches it).
- A settlement is a branch node nothing further narrows/extends.
- Delivery and evidence turns hold no flow; they inherit through the
  grounds/consume edges they wrote (reverse direction).
- Retraction invalidates the view: the API shape must make "recompute before
  next read" natural (no caching that survives an edge change).

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] Pure-function core: zero DB imports; inputs are plain arrays.
- [ ] Real-data acceptance: extract the S15069 T900–T1001 edges from the
      production DB with `sqlite3 -readonly` ONLY (never any write path),
      map old words mechanically in the fixture (refines→extends,
      depends-on→consume, grounded-on/encodes→grounds,
      evidence-*→verifies/refutes), and assert the peer's measured shape:
      23 flows · homeless exactly {918, 925, 941, 977, 987} · T900's branch
      set has three settlements · T954's branch has an empty settlement set.
- [ ] Performance pin: full-window derivation under a generous ms budget in
      a test (no perf regression door).
- [ ] Full `bun test` green except the sanctioned stale-bundle guard.
