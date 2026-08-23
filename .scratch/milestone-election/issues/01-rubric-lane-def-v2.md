# 01 — Rubric lane definition v2: ≥2 nodes, DAG form, fork/reopen, lane states

**What to build:** the injected Memory Rubric teaches the ruled lane definition
(T1360): a lane is a DAG of tagged edges over at least two nodes, every node's
tags containing the lane's; a lane may fork from another lane's node by adding
a tag, or inherit the exact set to reopen a closed lane; a lane whose latest
node is its declared terminus is CLOSED (valid while any indexed core node
lives, invalid once the core is all dead — the abandonment burial), otherwise
OPEN. The single-node clause stays as-is (an isolated product joins no lane).

**Blocked by:** None — can start immediately. Main-agent-authored (rubric text
is not offloaded, per the v10 ticket-03 precedent).

**Status:** done (main agent)

- [x] §Relations lane paragraph replaced; closed/open/valid reach the
      convergence paragraph in writer-facing terms (declare on convergence,
      bury on abandonment, leave fizzled lanes open)
- [x] Rendered block measured under the 9500 cap with real margin: 9435/9500,
      65 spare — paid by compressing Fields' length paragraph, ruling
      supplement, segment examples, roster/create bullets and the redundant
      phase-local tail, every guarded semantic kept (machine-knows-exact-sets
      reinstated compactly after a first-pass loss)
- [x] All guards green (103 tests across rubric + consumers); pins updated
      only where the law or its wrapping changed, each annotated with the
      ruling
