import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * Container-unification ticket 11 (spec D1): 段 -> 任务 (Task), `lane` (the
 * untranslated English word inside Chinese prose) -> 泳道. CONTEXT.md is
 * one of the five named reader-facing surfaces the ticket renames, and it was
 * found to have NO existing pin at all — a reversion mutation (putting
 * "Segment" back as the entry heading) left the full `bun test` suite at
 * 0 fail. This file is that missing pin.
 *
 * It also covers the ticket's second requirement on this file: the `Lane`
 * entry used to describe the v10/v11 identity ("its identity is its exact tag
 * SET", forks by proper superset, reopening by inheriting a tag set) — all
 * retired by lane-model-v12, where a lane is DECLARED via `remember` and its
 * identity is `(task, ONE tag)`. The ticket's instruction was to CORRECT the
 * entry while renaming it, not layer a new one on top of a stale one, so this
 * pins the corrected identity fact rather than merely the renamed heading.
 */

const CONTEXT_MD = readFileSync("CONTEXT.md", "utf8");

describe("CONTEXT.md — container vocabulary is 任务/Task and 泳道/Lane, not 段/Segment", () => {
  test("the container concept is named Task, not Segment", () => {
    expect(CONTEXT_MD).toContain("**Task**:");
    expect(CONTEXT_MD).not.toContain("**Segment**:");
    // The one Chinese-English seam this rename crosses: reader-facing text no
    // longer says the retired term anywhere as the concept's own name.
    expect(CONTEXT_MD).not.toContain("segment redesign");
  });

  test("the Lane entry states the v12 identity, not the retired v10/v11 exact-tag-SET model", () => {
    const start = CONTEXT_MD.indexOf("**Lane**:");
    const end = CONTEXT_MD.indexOf("**Convergence declaration");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const laneEntry = CONTEXT_MD.slice(start, end);

    // The corrected identity.
    expect(laneEntry).toContain("`(task, ONE tag)`");
    expect(laneEntry).toContain("DECLARED via `remember`");

    // The retired v10/v11 mechanics this entry used to teach.
    expect(laneEntry).not.toContain("its exact tag SET");
    expect(laneEntry).not.toContain("FORKS a new branch");
    expect(laneEntry).not.toContain("REOPENS a closed lane");
    expect(laneEntry).not.toContain("Single-node lanes do not exist");
  });

  /**
   * The Lane-entry slice above was scoped too tightly to be a guard (peer
   * review [S15069/T1771]): correcting ONE entry to v12 left the three
   * entries directly beneath it — Interpretation principle, Convergence
   * declaration, Lane state — still teaching v10/v11, so the file taught one
   * v12 paragraph followed by the model it replaced, and the slice could not
   * see any of it.
   *
   * The whole file is the unit, and the file's own format supplies the
   * boundary: an entry's DEFINITION runs from its heading to its `_Avoid_:`
   * line, and `_Avoid_` is the designated place to name a retired concept.
   * Scanning definitions only lets the retirement notices keep saying the
   * words they must say.
   */
  function definitionsOnly(): string {
    return CONTEXT_MD.split(/^\*\*/m)
      .map((entry) => {
        const avoid = entry.indexOf("_Avoid_:");
        return avoid === -1 ? entry : entry.slice(0, avoid);
      })
      .join("\n");
  }

  // Machinery lane-model-v12 deleted. `lastDeclarer` and lane valid/invalid
  // have ZERO occurrences in src/ — the glossary was describing a machine
  // that no longer exists, which is worse than describing it out of date.
  //
  // Matched on NORMALISED text, because the first version of this list was
  // the very archive it was built to prevent: it held camel-case
  // `lastDeclarer` and stayed green while Milestone election taught "an open
  // lane's last declarer" three entries further down (peer review
  // [S15069/T1772]). Stripping case and every separator collapses
  // lastDeclarer / last declarer / last-declarer to one string, which is the
  // whole spelling-variant class rather than the spellings someone thought of.
  const normalise = (text: string) =>
    text.toLowerCase().replace(/[^a-z0-9一-鿿]+/g, "");

  const RETIRED_MACHINERY = [
    "lastDeclarer",
    "closed-valid",
    "INVALID once the whole indexed core is dead",
    "repudiate-then-declare",
    "reopens that lane",
    "A tagged edge acts on a LANE",
    "an untagged edge acts on the cited TURN",
    "untagged-`indexes` writers",
    "same-lane tagged `index` edge",
    "its exact tag SET",
  ];

  test("no entry DEFINITION still teaches machinery v12 deleted", () => {
    const definitions = normalise(definitionsOnly());
    const offenders = RETIRED_MACHINERY.filter((phrase) =>
      definitions.includes(normalise(phrase)),
    );
    expect(offenders).toEqual([]);
  });

  test("the normaliser collapses the spelling that slipped through", () => {
    expect(normalise("lastDeclarer")).toBe(normalise("an open lane's LAST DECLARER").slice(-12));
    expect(normalise("closed-valid")).toBe(normalise("a closed valid lane").slice(1, 12));
  });

  // Milestone election is three entries below the ones rewritten, and it
  // described the tier-② seat as "a closed-valid lane's terminus or an open
  // lane's last declarer" — two seats and a quality qualifier, where ticket
  // 04 left ONE seat and no qualifier. A negative list alone cannot notice a
  // missing correction, so the current rule is pinned positively too.
  test("Milestone election states that tier ② now seats NOBODY, as the code elects it", () => {
    const start = CONTEXT_MD.indexOf("**Milestone election**");
    const end = CONTEXT_MD.indexOf("**Lane checker");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const entry = CONTEXT_MD.slice(start, end);

    // lane-state-retirement ticket 01 emptied the tier and left it empty on
    // purpose; ticket 02 rules its replacement. The entry must say BOTH — a
    // reader told only "empty" would think the tier was deleted.
    expect(entry).toContain("② NOBODY");
    expect(entry).toContain("ticket 02");
    // Tier ① is per-side too: an `indexes` edge with BOTH sides empty.
    expect(entry).toContain("BOTH side tags empty");
  });

  test("the definitions/_Avoid_ split is real, so the guard is not vacuous", () => {
    // If the split silently stopped working the test above would scan almost
    // nothing and pass forever. Both halves must be non-trivial, and a phrase
    // that lives ONLY in an _Avoid_ line must survive the strip.
    const definitions = definitionsOnly();
    expect(definitions.length).toBeGreaterThan(CONTEXT_MD.length / 2);
    expect(definitions.length).toBeLessThan(CONTEXT_MD.length);
    // An _Avoid_-only phrase, used to prove the strip really runs. The
    // `lastDeclarer` one left with the Lane state entry (lane-state-retirement
    // ticket 01); this ticket's own retirement line serves the same role.
    expect(CONTEXT_MD).toContain("open/closed as a property of a lane");
    expect(definitions).not.toContain("open/closed as a property of a lane");
  });

  test("the corrected entries state the rules they replaced", () => {
    expect(CONTEXT_MD).toContain("an\noverridden node stays valid");
    // LANE STATE IS GONE FROM THE MODEL (lane-state-retirement ticket 01), so
    // the entry that defined it is gone from the domain doc too — inverted
    // from "the entry exists and names `terminus === latestMember`".
    expect(CONTEXT_MD).not.toContain("**Lane state (open / closed)**");
    expect(CONTEXT_MD).not.toContain("`terminus === latestMember`");
    expect(CONTEXT_MD).toContain("A lane\nhas NO STATE");
    // …and the Convergence entry carries what replaced it: a per-TURN
    // declaration, the batch rule, and the warning that is never a refusal.
    expect(CONTEXT_MD).toContain("**Convergence declaration (阶段性收敛)**");
    expect(CONTEXT_MD).toContain("the phase was cut too fine");
    // An edge's ends are per-side, and an empty one is a draft.
    expect(CONTEXT_MD).toContain("UNSETTLED, which makes the edge\na DRAFT");
  });
});
