import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";

import {
  CALIBRATION_MIN_WINDOW,
  exceedsG3EvidenceGate,
  G3_EVIDENCE_GATE_SHARE,
  renderSignificanceCalibration,
  SIGNIFICANCE_TARGET_SHARES,
  summarizeGradeWindow,
  TASK_CAUSALITY_GRADE_CORRECTION_RUBRIC,
  TASK_CAUSALITY_GRADE_RUBRIC,
} from "../src/task-causality-rubric";

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Historical era grades were assigned under the exact words recovered from
 * `586bc4e^` (segment-grading spec D2). A hash pin — rather than a literal
 * copy of the ~1,700-token text inline here — fails on ANY byte change
 * (rewording, retruncation, a dropped clause) without creating the second
 * copy the ticket's acceptance criteria explicitly forbid.
 */
describe("task-causality grade rubric — text pin", () => {
  test("grade rubric text is unchanged", () => {
    expect(sha256(TASK_CAUSALITY_GRADE_RUBRIC)).toBe(
      "25c0b7726e9752cb2daace81f560ea02be848b3d7e47eecaac750c5c70bd6c8b",
    );
  });

  // Re-pinned twice, both times deliberately. The first re-pin (previous hash
  // 0dd801cf7f3826ae9074bf71eebbca95c8069a4ce9fe52d9b45bf22418ef8624) covered
  // a clause that ORDERED the grader to tag a casualty `rolled-back`; a prior
  // ticket retired that word from the type vocabulary, but the clause named
  // the tag field, which carries no vocabulary check — so the instruction
  // kept being followed and the timeline kept reading the result as a
  // reversal role. The second re-pin (ticket 12, previous hash
  // 6dbb7a4018d18cc251ad3944a8cff7b1704399a6dbbd460bfb3238febe1bca82) retired
  // the `regrade` verb, which never had a real call-site counterpart, and
  // replaced it with the `supersedes` edge + direct-grade instruction the
  // settlement schema actually implements. That same re-pin ALSO dropped the
  // `rolled-back` prohibition, reading "no rolled-back remains" as a token
  // hunt; the third pin (previous hash
  // cd98a1d83ce9a44afed73718942b01f5f352600f0700d5f0402e910ddd4ea475) puts it
  // back, for the reason written above that test. Re-pinning a hash is not a
  // change to wave through, so every retirement is also asserted positively
  // below: a future re-pin that silently reintroduced one would pass this
  // hash and fail that.
  test("grade correction text is unchanged", () => {
    expect(sha256(TASK_CAUSALITY_GRADE_CORRECTION_RUBRIC)).toBe(
      "9579bb5129ac0e953af4b77cf1186086c5666b8d3a631cffc7910fc5d306eda3",
    );
  });

  test("the correction duty carries no retired mechanism (regrade verb)", () => {
    expect(TASK_CAUSALITY_GRADE_CORRECTION_RUBRIC).not.toContain("regrade");
    expect(TASK_CAUSALITY_GRADE_CORRECTION_RUBRIC).not.toContain(
      "you MUST both tag the casualty",
    );
  });

  // The `rolled-back` TAG is a different retirement from the `regrade` VERB,
  // and only the verb is safe to delete on sight. The verb had no call-site
  // counterpart, so an instruction naming it was inert. The tag still has a
  // live reader — `REVERSED_ROLE_TAGS` in mcp/timeline.ts — and the tag field
  // carries no vocabulary check, so a grader that writes it still changes
  // rendered output. 537 production turns carry it. This sentence is the only
  // thing standing between a grader and that write, which is why ticket 12
  // deleting the word (it read "no rolled-back tag remains in the rubric" as
  // "remove the token") was a weakening and got reverted here: the prohibition
  // must NAME the word, or a grader carrying the old habit has nothing to
  // recognise.
  test("the prohibition on tagging a casualty still names the retired word", () => {
    expect(TASK_CAUSALITY_GRADE_CORRECTION_RUBRIC).toContain(
      "Do NOT tag the casualty `rolled-back`, or any other reversal word",
    );
  });

  test("the misleading-turn downgrade writes a supersedes edge and grades by surviving consequence", () => {
    expect(TASK_CAUSALITY_GRADE_CORRECTION_RUBRIC).toContain(
      "write a `supersedes` edge to it and grade that turn by its surviving task-causal consequence",
    );
  });

  test("the witnessed-disproof / rollback-evidence guard survives verbatim", () => {
    expect(TASK_CAUSALITY_GRADE_CORRECTION_RUBRIC).toContain(
      "Do this only with witnessed disproof or rollback evidence in the current turn; never rewrite history from a guess.",
    );
  });

  test("five grade levels are still named, in order", () => {
    for (const marker of [
      "Grade 4 — task origin or re-foundation",
      "Grade 3 — a major milestone within an arc",
      "Grade 2 — a durable conclusion or complete delivery",
      "Grade 1 — routine execution with no independently persistable conclusion",
      "Grade 0 — no future value",
    ]) {
      expect(TASK_CAUSALITY_GRADE_RUBRIC).toContain(marker);
    }
  });

  test("grade correction duties are still named", () => {
    for (const marker of [
      "Misleading-turn downgrade",
      "Grade-4 re-foundation",
      "Bridge Grade 4 for cutoff-straddling sessions",
    ]) {
      expect(TASK_CAUSALITY_GRADE_CORRECTION_RUBRIC).toContain(marker);
    }
  });
});

describe("task-causality calibration targets", () => {
  test("target shares and thresholds match the rubric's calibration (d5a32f4)", () => {
    expect(SIGNIFICANCE_TARGET_SHARES).toEqual({ 4: 0.02, 3: 0.1, 2: 0.25 });
    expect(CALIBRATION_MIN_WINDOW).toBe(30);
    expect(G3_EVIDENCE_GATE_SHARE).toBe(0.15);
  });

  test("a window under the minimum reads as too small to compare", () => {
    const window = summarizeGradeWindow([
      { grade: 3, count: 2 },
      { grade: 1, count: 3 },
    ]);
    expect(exceedsG3EvidenceGate(window)).toBe(false);
    expect(renderSignificanceCalibration(window)).toContain(
      "Window under 30 turns",
    );
  });

  test("a window whose grade-3 share exceeds the 15% ceiling trips the evidence gate", () => {
    const window = summarizeGradeWindow([
      { grade: 3, count: 20 },
      { grade: 1, count: 80 },
    ]);
    expect(exceedsG3EvidenceGate(window)).toBe(true);
    expect(renderSignificanceCalibration(window)).toContain(
      "above the 15% ceiling",
    );
  });
});
