#!/usr/bin/env python3
"""Round-2 arm construction. Applies exactly ONE change per arm to a pristine
copy of src/shared/milestone-election.ts. Run after:
    for a in A B C D; do cp -Rc /tmp/mnemo-r2-snap /tmp/mnemo-r2-arms/$a; done
Arm A is left pristine by construction.
"""
import sys, pathlib

BASE = pathlib.Path("/tmp/mnemo-r2-arms")
REL = "src/shared/milestone-election.ts"

REST_BLOCK = """    if (indexedByElected.has(id)) {
      tier = 3;
      reason = "indexed-by-elected";
    } else if (correctors.has(id)) {
      tier = 4;
      reason = "corrector";
    } else {
      tier = 5;
      reason = "other";
    }"""

# ---------------- Arm B: corrector promotion only ----------------
B_REST = """    if (correctors.has(id)) {
      tier = 3;
      reason = "corrector";
    } else if (indexedByElected.has(id)) {
      tier = 4;
      reason = "indexed-by-elected";
    } else {
      tier = 5;
      reason = "other";
    }"""

# ---------------- Arm C: type decision tier only ----------------
C_TIER_TYPE = ("export type MilestoneTier = 1 | 2 | 3 | 4 | 5;",
               "export type MilestoneTier = 1 | 2 | 3 | 4 | 5 | 6;")
C_REASON = ('  | "indexed-by-elected"\n  | "corrector"\n  | "other";',
            '  | "type-decision"\n  | "indexed-by-elected"\n  | "corrector"\n  | "other";')
C_SET = ("  const stage1Ids = new Set(stage1.map((c) => c.id));",
         """  // ---- ARM C — type decision tier: `type` intersects {design, correction} ----
  const typeDecision = new Set<number>();
  for (const turn of turns) {
    if ((turn.type ?? []).some((word) => word === "design" || word === "correction")) {
      typeDecision.add(turn.id);
    }
  }

  const stage1Ids = new Set(stage1.map((c) => c.id));""")
C_REST = """    if (typeDecision.has(id)) {
      tier = 3;
      reason = "type-decision";
    } else if (indexedByElected.has(id)) {
      tier = 4;
      reason = "indexed-by-elected";
    } else if (correctors.has(id)) {
      tier = 5;
      reason = "corrector";
    } else {
      tier = 6;
      reason = "other";
    }"""

# ---------------- Arm D: relation-weighted in-degree only ----------------
D_OLD = """  const inDegree = new Map<number, number>();
  const outDegree = new Map<number, number>();
  for (const edge of edges) {
    if (IN_DEGREE_RELATIONS.has(edge.relation)) {
      inDegree.set(edge.citedId, (inDegree.get(edge.citedId) ?? 0) + 1);
    }
    outDegree.set(edge.citingId, (outDegree.get(edge.citingId) ?? 0) + 1);
  }"""
D_NEW = """  const inDegree = new Map<number, number>();
  const outDegree = new Map<number, number>();
  // ---- ARM D — relation-weighted in-degree over DISTINCT citing turns.
  // narrows/verifies 2, grounds/consume 1, extends 0.5, `indexes` excluded
  // (it already drives tier assignment). A (citing, cited) PAIR contributes
  // exactly once, at the MAX weight among the relations that pair carries,
  // no matter how many edge rows / lanes duplicate it.
  const ARM_D_WEIGHT: Record<string, number> = {
    narrows: 2,
    verifies: 2,
    grounds: 1,
    consume: 1,
    extends: 0.5,
  };
  const pairBest = new Map<string, { cited: number; weight: number }>();
  for (const edge of edges) {
    const weight = ARM_D_WEIGHT[edge.relation];
    if (weight === undefined) continue;
    const key = `${edge.citingId}>${edge.citedId}`;
    const prior = pairBest.get(key);
    if (prior === undefined || weight > prior.weight) {
      pairBest.set(key, { cited: edge.citedId, weight });
    }
  }
  for (const { cited, weight } of pairBest.values()) {
    inDegree.set(cited, (inDegree.get(cited) ?? 0) + weight);
  }
  for (const edge of edges) {
    outDegree.set(edge.citingId, (outDegree.get(edge.citingId) ?? 0) + 1);
  }"""


def sub(text, old, new, arm, label):
    if text.count(old) != 1:
        sys.exit(f"arm {arm}: anchor {label!r} matched {text.count(old)} times (expected 1)")
    return text.replace(old, new)


def main():
    for arm in ("B", "C", "D"):
        path = BASE / arm / REL
        text = path.read_text()
        if arm == "B":
            text = sub(text, REST_BLOCK, B_REST, arm, "rest-tier-block")
        elif arm == "C":
            text = sub(text, *C_TIER_TYPE, arm, "tier-union")
            text = sub(text, *C_REASON, arm, "reason-union")
            text = sub(text, *C_SET, arm, "stage1Ids-anchor")
            text = sub(text, REST_BLOCK, C_REST, arm, "rest-tier-block")
        else:
            text = sub(text, D_OLD, D_NEW, arm, "degree-tally")
        path.write_text(text)
        print(f"arm {arm}: patched {path}")


if __name__ == "__main__":
    main()
