/**
 * The task-causality G0–G4 significance-grading rubric, and the calibration
 * targets it was written against — the standard a settlement pass grades an
 * era turn under (spec `.scratch/segment-grading`, decision D2).
 *
 * Recovered verbatim from `586bc4e^` (the commit immediately preceding
 * "feat(era): retire the extraction agent (票 15)", which deleted this text
 * along with the resident agent that read it). Introduced by `43951e1`
 * ("task-causality significance grading — rubric, era cutoff, arc skeleton
 * re-prime") and rewritten into the words below by `d5a32f4` ("extraction
 * prompt package + calibration actual-vs-target"). Historical era grades were
 * assigned under exactly these words; a paraphrase here would silently fork
 * the standard a new grade is supposed to be comparable against — the reason
 * D2 insists on one importable, pinned copy rather than a second hand-written
 * rendition. `tests/task-causality-rubric.test.ts` pins the text so a later
 * edit cannot reword it without failing.
 *
 * This module is a prefactor only — nothing here is wired into the settlement
 * prompt yet (ticket 02's job). It exists so that ticket can budget against a
 * real number: `TASK_CAUSALITY_GRADE_RUBRIC` +
 * `TASK_CAUSALITY_GRADE_CORRECTION_RUBRIC` together cost 1,697 tokens under
 * `estimateTokens` (src/utils/token-estimate.ts) — roughly +144% over the
 * ~1,182 tokens `renderNoteSettlementPrompt` (src/worker/note-settlement-prompt.ts)
 * renders today for an empty window (no window turns, segments, topics, prior
 * or milestone rendering — the prompt's fixed skeleton; a real call also
 * carries the window's turns and is larger than this floor in practice).
 */

/**
 * The five grade definitions. Byte-identical to the `grade` field's
 * description inside the extraction agent's per-turn instructions at
 * `586bc4e^` (`src/worker/query-session.ts`, then lines 391-400).
 */
export const TASK_CAUSALITY_GRADE_RUBRIC = `   - grade: REQUIRED integer 0-4 measuring this turn's task-level causality:
     - Grade 4 — task origin or re-foundation: establishes why a work arc exists — its motive, problem, and success criteria. Judge arc scale from the scope of the ask at grading time: an arc is expected to span roughly 50+ turns. Every Grade 4 opens a new arc by default; normally one Grade 4 per arc. A second is legal only when the motive or success criteria are radically redefined. A re-foundation must cite the Grade 4 it re-founds as [T<n>]; evolution alone does not imply rollback. Origin duty, arc-scoped: a task arc is delimited by the re-prime skeleton or by a new top-level ask, and one session may hold several arcs. If the CURRENT arc holds no Grade 4 yet and this turn establishes its motive, problem, or success criteria, grade it 4 — even when it called no tools and touched no files. This grading is PROVISIONAL: settlement re-reads the arc later and confirms or demotes it by the arc's actual scale, so a short-lived task's origin will be demoted then. Never withhold the Grade 4 now for fear of that demotion — an ungraded origin leaves the arc headless, while an over-graded one is a single settlement away from correct.
     - Grade 3 — a major milestone within an arc that materially affects its design (problem model, design philosophy, architecture, decomposition, evaluation method, or principles of action) or its established conclusions. Apply the deletion test: "if this turn were deleted, would the task's design, evaluation method, principles of action, or established conclusions change?" If only the next execution action changes, cap at Grade 2. Work that exists only to unblock execution — environment fixes, toolchain repair, or local debugging — cannot reach Grade 3 however dramatic it was; cap at Grade 2. A Grade 3 that resumes an earlier arc must cite that arc's Grade 4; otherwise attach it to the nearest preceding Grade 4. Chain rule: inside one diagnose → decide → formalize chain, only the turn that LANDS the change is Grade 3; the turns that produced the evidence or named the diagnosis are Grade 2, however hard-won they were. Grading every link of a chain 3 is the largest single source of grade inflation. Two standing counter-examples that are NOT Grade 3: a release or a commit is Grade 2 — it executes a decision already made elsewhere; dispatching a worker or starting a run is Grade 1.
     - Grade 2 — a durable conclusion or complete delivery. This includes reusable environment pitfalls and root causes, experiment results below task-conclusion weight, established constraints, evidence-backed rejections, a feature or ticket completed end-to-end, a commit/release, or another independently verifiable stage delivery. Environment and toolchain decisions normally live here. When the user's ask is a knowledge question, a complete answer to a knowledge-question task is a delivery and is graded by completeness.
     - Grade 1 — routine execution with no independently persistable conclusion: a module coded/tested, an intermediate green result, an environment prepared, a worker dispatched, a probe started, or ordinary progress confirmation. It is useful only for short-term continuation.
     - Grade 0 — no future value: deleting the turn loses nothing. This includes status checks that found nothing, "still running / no change" polls, empty or shell-only commands, irrelevant incidental explanations that formed no reusable conclusion, and repeated confirmations. Grade 0 is judged by outcome, not action type: a status check that uncovered a real problem is not Grade 0, and "no later decision consumed it" is never sufficient by itself.
     - Compound turns: grade by the highest material consequence, not by whichever action happened last.
     - Final over draft: when a prompt was interrupted, edited, and resubmitted, the grade lands on the FINAL resubmission's turn, not on the broken draft. Grade the draft by what it actually delivered — usually Grade 0 or 1 — however important the interrupted text looked.
     - Worked examples from the validated research session: extraction-failure diagnosis = Grade 4 origin; probe design and SFT-pilot design = Grade 3 design events; probe result determining the SFT go decision = Grade 3 conclusion; an evaluation-validity defect around a pre-registered gate = Grade 3 at its DISCOVERY (noticing the data split leaks, before any fix exists) as well as at the fix that protects the gate, because its absence would corrupt the arc's conclusions; driver root-cause chain = Grade 2 durable pitfall; probe launch confirmations = Grade 1 routine execution; "still healthy" polls = Grade 0 even when they report an on-track number.
     - Worked example, generalized shape of a design arc: the opening ask that framed the problem = Grade 4; the spec finalized and the core mechanism locked = Grade 3; the turn that discovered the key problem, and an important correction to the spec = Grade 2 (a discovery rises to Grade 3 only when it invalidates the arc's own conclusions, as the evaluation-validity defect above does); dispatching a worker, running a query, updating a doc = Grade 1; a repeated attempt and an inconclusive poll = Grade 0; the release or commit itself = Grade 2.`;

/**
 * The regrade/correction duties that travel with the rubric above — the
 * misleading-turn downgrade, the Grade-4 re-foundation rule, and the
 * bridge-Grade-4 rule for cutoff-straddling sessions. Byte-identical to the
 * same commit's "Grade correction" section (then lines 421-427). The rubric
 * rewrite ticket (`43951e1`'s 02-task-causality-rubric) scoped these duties
 * together with the five definitions as one rewrite, because a regrade
 * changes what a stored grade CLAIMS — its rules are part of the standard,
 * not a separate feature, so they live beside the definitions rather than
 * off in whatever module happens to call `regrade`.
 */
export const TASK_CAUSALITY_GRADE_CORRECTION_RUBRIC = `Grade correction has two narrowly-scoped duties:

- Misleading-turn downgrade: whenever THIS turn overturns a cited earlier turn (the negate-on-cite \`rolled-back\` case above), you MUST both tag the casualty \`rolled-back\` AND lower its grade via \`regrade\` in the same call — tagging without regrading is incomplete. Demote it to the grade its surviving task-causal consequence warrants. Do this only with witnessed disproof or rollback evidence in the current turn; never rewrite history from a guess. Keep the causal citation so the timeline can retain the casualty as a ↳ row.
- Grade-4 re-foundation: a radical redefinition may create a second Grade 4 in the same arc, but the new Grade 4 must cite the Grade 4 it re-founds. Do not demote the earlier foundation merely because the motive evolved; only witnessed disproof triggers the separate \`rolled-back\` downgrade above.
- Bridge Grade 4 for cutoff-straddling sessions: legacy Grade 3/4 rows are historical context, never trusted anchors, and \`regrade\` cannot change their creation era. Grade the first post-cutoff turn that can summarize the existing arc's motive and success criteria as a bridge Grade 4. Never try to turn a legacy row into the trusted foundation via \`regrade\`.

Express one grade correction inside the current turn's call as \`regrade: { id: "T<n>", grade: 0|1|2|3|4 }\`. The target must be an earlier turn in this session. This is the only grade-only exception to the rule against updating a record not named by the current block.`;

// ---------------------------------------------------------------------------
// Calibration targets (from `d5a32f4`), recovered from the same commit
// (`src/worker/processors.ts`, then lines 229-324) verbatim. This is the
// actual-vs-target machinery the rubric was calibrated against: the standing
// target shares, the small-sample floor, and the evidence-gate ceiling that
// turns on when a window's Grade-3 share drifts too high. Pure functions —
// no DB dependency — so they belong beside the rubric rather than inside
// whatever call site eventually renders a window's calibration block.
// ---------------------------------------------------------------------------

// Standing target distribution the extraction agent grades against (spec §A).
// Not a quota: it is the reference the actual window is rendered beside.
export const SIGNIFICANCE_TARGET_SHARES = {
  4: 0.02,
  3: 0.1,
  2: 0.25,
} as const;
// Under this many rows a window's shares are noise — no percentage is rendered
// and the deviation gate cannot fire (a 6-turn window is trivially "50% G3").
export const CALIBRATION_MIN_WINDOW = 30;
// Grade-3 share above this ceiling (target + 5pp) turns on the
// strengthened-evidence gate. Evidence gate only: never a mechanical floor,
// because the ceiling simulation put mis-hits to true hits at ~2:1.
export const G3_EVIDENCE_GATE_SHARE = 0.15;

export interface GradeWindow {
  /** Row counts by grade, indexed 0-4. */
  counts: number[];
  /** Rows with no grade yet (NULL significance_grade). */
  ungraded: number;
  /** EVERY row in the window — graded, skipped, and ungraded alike. */
  total: number;
}

export function summarizeGradeWindow(
  rows: Array<{ grade: number | null; count: number }>,
): GradeWindow {
  const counts = [0, 0, 0, 0, 0];
  let ungraded = 0;
  for (const row of rows) {
    if (row.grade === null) {
      ungraded += row.count;
    } else if (row.grade >= 0 && row.grade <= 4) {
      counts[row.grade] = row.count;
    }
  }
  const total = counts.reduce((sum, count) => sum + count, 0) + ungraded;
  return { counts, ungraded, total };
}

/**
 * Whether the window's Grade-3 share has drifted far enough above target that a
 * new Grade 3 must name the design artifact it moved. Strictly greater than the
 * ceiling — a window sitting exactly at 15% is compliant.
 */
export function exceedsG3EvidenceGate(window: GradeWindow): boolean {
  return (
    window.total >= CALIBRATION_MIN_WINDOW &&
    (window.counts[3] ?? 0) > window.total * G3_EVIDENCE_GATE_SHARE
  );
}

function sharePercent(count: number, total: number): string {
  return `${Math.round((count / total) * 100)}%`;
}

/**
 * Renders the actual-vs-target calibration block. Pure: settlement (spec §A)
 * renders the same block over its frozen window by passing a different label.
 */
export function renderSignificanceCalibration(
  window: GradeWindow,
  windowLabel = "previous 100 turns",
): string {
  const { counts, ungraded, total } = window;
  const smallSample = total < CALIBRATION_MIN_WINDOW;
  const grades = [4, 3, 2, 1, 0]
    .map(
      (grade) =>
        `grade ${grade}=${counts[grade]}${
          smallSample ? "" : ` (${sharePercent(counts[grade] ?? 0, total)})`
        }`,
    )
    .join(", ");
  const ungradedCell = `ungraded=${ungraded}${
    smallSample ? "" : ` (${sharePercent(ungraded, total)})`
  }`;
  const targetLine = smallSample
    ? "Window under 30 turns — too small to read as a distribution, so no share and no target comparison is drawn. Most turns should still be trivial, repetitive, or intermediate work: grade 0/1 is the expected majority."
    : `Target: grade 4 ≈ ${Math.round(
        SIGNIFICANCE_TARGET_SHARES[4] * 100,
      )}%, grade 3 ≈ ${Math.round(
        SIGNIFICANCE_TARGET_SHARES[3] * 100,
      )}%, grade 2 ≈ ${Math.round(
        SIGNIFICANCE_TARGET_SHARES[2] * 100,
      )}%. Most turns should be trivial, repetitive, or intermediate work — grade 0/1 is the expected majority, not a failure to find significance.`;
  const deviationLine = exceedsG3EvidenceGate(window)
    ? `\nDeviation: grade 3 holds ${counts[3]} of the last ${total} turns, above the 15% ceiling. Until it comes back down, a new Grade 3 is admissible ONLY if its content names the design artifact it changed — a named file, spec, schema, or interface; a named evaluation method; or a prior conclusion cited with \`supersedes\` — together with that artifact's before→after. If you cannot name one, grade 2.`
    : "";

  return `<significance-calibration window="${windowLabel}">
Actual over ${total} turns (denominator = every turn in the window, including skipped and ungraded): ${grades}, ${ungradedCell}.
${targetLine}
Structural self-checks: one Grade 4 per arc unless a radical re-foundation cites it; every Grade 3 must pass the deletion test; Troubleshooting chains resolve to Grade 2 conclusions, not Grade 3 chains; No-change polls are Grade 0.${deviationLine}
</significance-calibration>`;
}
