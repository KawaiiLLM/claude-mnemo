import { describe, expect, test } from "bun:test";

import {
  buildExtractionStatusSummary,
  buildMnemosynePrompt,
} from "../../src/mnemosyne/prompt";

describe("buildMnemosynePrompt", () => {
  test("documents stale re-evaluation and explicit undone handling", () => {
    const summary = buildExtractionStatusSummary([
      {
        promptNumber: 1,
        status: "stale",
        promptPreview: "Redo the branch",
      },
      {
        promptNumber: 2,
        status: "undone",
        promptPreview: "Old branch",
      },
    ]);

    const prompt = buildMnemosynePrompt(summary);

    expect(prompt).toContain('call save_turn with status="undone"');
    expect(prompt).toContain(
      "Do NOT re-process [extracted], [skipped], or [undone] turns",
    );
    expect(prompt).toContain('#2 [undone]: "Old branch"');
  });

  test("uses an approximately 80 character prompt preview", () => {
    const longPrompt =
      "This is a very long prompt preview that should stay readable for matching and remain close to eighty characters total";
    const summary = buildExtractionStatusSummary([
      {
        promptNumber: 1,
        status: "pending",
        promptPreview: longPrompt,
      },
    ]);

    expect(summary).toContain(
      '#1 [pending]: "This is a very long prompt preview that should stay readable for matching and...',
    );
  });

  test("forbids observer-self narration and records durable debugging evidence", () => {
    const prompt = buildMnemosynePrompt('#1 [pending]: "Investigate auth"');

    expect(prompt).toContain("Do not describe the observer's own behavior");
    expect(prompt).toContain("logs, queue state, DB rows, routing, request flow, or code-path inspection");
  });

  test("keeps field quality and concept/type separation guidance", () => {
    const prompt = buildMnemosynePrompt('#1 [pending]: "Fix auth"');

    expect(prompt).toContain("narrative: explain what was done, how it works, and why it matters");
    expect(prompt).toContain("Do NOT use the observation type as a concept");
  });

  test("keeps update_session, private-tag exclusion, and tool-call examples", () => {
    const prompt = buildMnemosynePrompt('#1 [pending]: "Fix auth"');

    expect(prompt).toContain("Call update_session if the session summary needs updating");
    expect(prompt).toContain("Content inside <private>...</private> tags must NOT be recorded.");
    expect(prompt).toContain('Good example: save_turn({');
    expect(prompt).toContain(
      'Bad example: save_turn({ session_id: 1, prompt_number: 2, title: "Analyzed auth flow"',
    );
    expect(prompt).toContain("Skip example: save_turn({ session_id: 1, prompt_number: 3 })");
  });

  test("keeps output discipline without duplicate prose-only rule", () => {
    const prompt = buildMnemosynePrompt('#1 [pending]: "Fix auth"');

    expect(prompt.match(/Never output prose/g)?.length).toBe(1);
  });
});
