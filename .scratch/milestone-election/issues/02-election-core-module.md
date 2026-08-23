# 02 — Election core module: exclusion, five identity tiers, lexicographic rank

**What to build:** a pure shared module that, given a window's turns, edges and
lane interpretation, produces the milestone election ordering of spec
`.scratch/milestone-election/spec.md`:

1. Candidacy exclusion — rolled-back, skipped, and every node with an override
   or refutes in-edge (any tag state).
2. Identity tiers — ① untagged-indexes writers; ② closed-VALID lane termini
   and open lanes' last declarer; ③ nodes indexed by elected ①/② (two-stage
   fill); ④ correctors; ⑤ rest.
3. Within a tier: positive in-degree (narrows/extends/consume/indexes/grounds/
   verifies, +1 each, self-edges included), ties by out-degree (all edges),
   ties by later turn.
4. The module returns the full ordered candidacy with per-node tier/state
   metadata; budget cutting stays the renderer's (ticket 03).

Also mints the shared **lane-state helper** in the interpretation core
(closed/open, valid/invalid, last declarer — derived from the existing event
reduction, additive only): the election consumes it here, the checker (ticket
04) consumes the same helper later. No parallel derivations anywhere.

**Blocked by:** None — can start immediately.

**Status:** done (mutation-verified: closure conjunction → 2 red, tier-3 budget boundary → 1 red)

- [ ] Golden: on the T900-1001 fixture
      (.scratch/rubric-v10/fixtures/t900-1001-lane-sim.json) the top nine are
      exactly {922, 929, 939, 946, 981, 984, 990, 998, 1001} in that displayed
      time order, with 925/957 (override victims) and 935 (refuted by 941)
      excluded, write-gate reading open-with-no-declarer. A differing result is
      STOP-AND-REPORT, never golden adjustment.
- [ ] Unit: exclusion (each negative word, tagged and untagged), each tier's
      qualification incl. open-lane last declarer and invalid-lane demotion,
      two-stage tier-③ fill, lexicographic order incl. the later-wins tie, the
      edgeless-window degradation to recency ordering
- [ ] lane-state helper unit-tested against reopened (post-declaration
      continuation) and abandoned (dead-core) shapes
- [ ] Report declares the load-bearing property per criterion with verbatim
      re-check commands; typecheck clean
