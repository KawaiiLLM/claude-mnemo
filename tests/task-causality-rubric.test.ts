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

  // Re-pinned once, deliberately. The previous hash
  // (0dd801cf7f3826ae9074bf71eebbca95c8069a4ce9fe52d9b45bf22418ef8624) covered
  // a clause that ORDERED the grader to tag a casualty `rolled-back`. Ticket
  // 02 retired that word from the type vocabulary, but the clause named the
  // tag field, which carries no vocabulary check — so the instruction kept
  // being followed and the timeline kept reading the result as a reversal
  // role. Re-pinning a hash is not a change to wave through, so the
  // prohibition is also asserted positively below: a future re-pin that
  // silently dropped it would pass this hash and fail that.
  test("grade correction text is unchanged", () => {
    expect(sha256(TASK_CAUSALITY_GRADE_CORRECTION_RUBRIC)).toBe(
      "6dbb7a4018d18cc251ad3944a8cff7b1704399a6dbbd460bfb3238febe1bca82",
    );
  });

  test("the correction duty forbids the retired reversal tag rather than requiring it", () => {
    expect(TASK_CAUSALITY_GRADE_CORRECTION_RUBRIC).toContain(
      "Do NOT tag the casualty `rolled-back`",
    );
    expect(TASK_CAUSALITY_GRADE_CORRECTION_RUBRIC).not.toContain(
      "you MUST both tag the casualty",
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

  test("regrade duties are still named", () => {
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
