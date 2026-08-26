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
});
