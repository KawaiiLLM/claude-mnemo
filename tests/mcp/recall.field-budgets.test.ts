import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { estimateTokens } from "../../src/utils/token-estimate";
import { recallMemory } from "../../src/mcp/recall";
import { saveTurnFixture as saveTurn } from "../support/turn-fixtures";

/**
 * Ticket 11 (per-field recall budgets, USER RULING S15069/T2106):
 * `filter.fieldBudgets` — one mechanism covering BOTH of this codebase's
 * truncation paths (the bare browse feed's per-field equal split, and an
 * addressed render's whole-block line ladder). A field named in
 * `fieldBudgets` spends exactly that many tokens on its own word-boundary
 * cut instead of sharing the ambient split/ladder; an unnamed field is
 * byte-identical to before this ticket.
 */
describe("recall filter.fieldBudgets", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  function makeSession(contentId: string, title: string, createdAtEpoch: number): number {
    return upsertSession(db, {
      contentSessionId: contentId,
      project: "/tmp/field-budgets",
      title,
      content: null,
      insight: null,
      createdAtEpoch,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    }).id;
  }

  /** `count` short, distinct words — long enough in aggregate to cost real tokens, never a single unbroken run a word-boundary cut could not land inside. */
  function words(count: number, prefix: string): string {
    return Array.from({ length: count }, (_, i) => `${prefix}${i}`).join(" ");
  }

  function completenessRow(
    entityId: number,
    field: string,
  ): { complete: number } | null {
    return db
      .query<{ complete: number }, [string, string, number, string]>(
        `SELECT complete FROM write_gate_field_completeness
         WHERE writer = ? AND entity_type = ? AND entity_id = ? AND field = ?`,
      )
      .get("session:1", "turn", entityId, field);
  }

  describe("motivating shape (S15069/T2104) — the bare browse feed", () => {
    test("a content field that exceeds the OLD equal split renders COMPLETE, and prompt is cut to at most 50 tokens, in one call", () => {
      const sessionId = makeSession("browse-motivating", "Motivating shape", 1_000);
      // 110 words: sits ABOVE the old equal split (turn=200 / 2 fields ≈ 100
      // tokens each) but BELOW the new remaining split once prompt carves out
      // its own 50 (turn=200 - 50 = 150, over the one remaining field ≈ 150
      // tokens) — the exact window this ticket's mechanism opens.
      const contentText = words(110, "c");
      const promptText = words(400, "p");
      saveTurn(db, {
        sessionId,
        promptNumber: 1,
        userPrompt: promptText,
        assistantResponse: "r",
        title: "motivating shape turn",
        content: contentText,
        insight: null,
        filesRead: [],
        filesModified: [],
        createdAtEpoch: 1_001,
        updatedAtEpoch: null,
        observations: [],
      });

      // BASELINE (no fieldBudgets): the same content, at the same `turn`,
      // gets cut by the OLD equal split — proving the "exceeds the old
      // equal split" premise is real, not assumed.
      const baseline = recallMemory(db, {
        filter: { fields: ["content", "prompt"] },
        turn: 200,
      });
      const baselineContentLine = baseline.split("\n").find((line) => line.includes("- content:"));
      expect(baselineContentLine).toContain("…");

      // WITH fieldBudgets: content renders whole, prompt is cut to <=50
      // tokens — in this SAME one call.
      const withBudgets = recallMemory(db, {
        filter: { fields: ["content", "prompt"], fieldBudgets: { prompt: 50 } },
        turn: 200,
      });
      const contentLine = withBudgets.split("\n").find((line) => line.includes("- content:"));
      const promptLine = withBudgets.split("\n").find((line) => line.includes("- prompt:"));
      expect(contentLine).not.toContain("…");
      expect(contentLine).toContain(contentText);
      expect(promptLine).toBeDefined();
      const promptValue = promptLine!.replace(/^\s*- prompt:\s*/, "");
      expect(estimateTokens(promptValue)).toBeLessThanOrEqual(50);
    });
  });

  describe("motivating shape — an addressed render (id=\"S<n>/T<m>\")", () => {
    test("content renders complete and prompt is cut to at most 50 tokens, independent of a generous shared turn budget", () => {
      const sessionId = makeSession("addressed-motivating", "Addressed shape", 1_100);
      const contentText = words(80, "c");
      const promptText = words(400, "p");
      const turn = saveTurn(db, {
        sessionId,
        promptNumber: 1,
        userPrompt: promptText,
        assistantResponse: "r",
        title: "addressed motivating turn",
        content: contentText,
        insight: null,
        filesRead: [],
        filesModified: [],
        createdAtEpoch: 1_101,
        updatedAtEpoch: null,
        observations: [],
      });

      // `turn` here is generous enough that, WITHOUT fieldBudgets, prompt
      // would render in FULL (nothing forces the whole-block ladder to cut
      // anything) — isolating fieldBudgets' own exact cut from the ladder.
      const withoutBudgets = recallMemory(db, {
        id: `S${sessionId}/T${turn.promptNumber}`,
        filter: { fields: ["title", "content", "prompt"] },
        turn: 2000,
      });
      expect(withoutBudgets).toContain(promptText);

      const withBudgets = recallMemory(db, {
        id: `S${sessionId}/T${turn.promptNumber}`,
        filter: { fields: ["title", "content", "prompt"], fieldBudgets: { prompt: 50 } },
        turn: 2000,
      });
      expect(withBudgets).toContain(contentText);
      const promptLine = withBudgets.split("\n").find((line) => line.includes("- prompt:"));
      expect(promptLine).toBeDefined();
      const promptValue = promptLine!.replace(/^\s*- prompt:\s*/, "");
      expect(estimateTokens(promptValue)).toBeLessThanOrEqual(50);
      expect(promptValue).not.toContain(promptText);
    });
  });

  describe("no-fieldBudgets byte-compatibility", () => {
    test("an ordinary call with no fieldBudgets at all is unaffected by the mechanism existing", () => {
      const sessionId = makeSession("no-budgets", "Unaffected", 1_200);
      saveTurn(db, {
        sessionId,
        promptNumber: 1,
        userPrompt: "short prompt",
        assistantResponse: "r",
        title: "plain turn",
        content: "short content",
        insight: null,
        filesRead: [],
        filesModified: [],
        createdAtEpoch: 1_201,
        updatedAtEpoch: null,
        observations: [],
      });

      const withoutFieldBudgetsKey = recallMemory(db, {
        filter: { fields: ["title", "content", "prompt"] },
      });
      const withExplicitUndefined = recallMemory(db, {
        filter: { fields: ["title", "content", "prompt"], fieldBudgets: undefined },
      });
      expect(withExplicitUndefined).toBe(withoutFieldBudgetsKey);
    });
  });

  describe("completeness records at the signal seam", () => {
    test("browse feed: a field clipped by its OWN fieldBudgets records incomplete; an unnamed, whole field records complete", () => {
      const sessionId = makeSession("browse-completeness", "Completeness", 1_300);
      const turn = saveTurn(db, {
        sessionId,
        promptNumber: 1,
        userPrompt: "prompt text",
        assistantResponse: "r",
        title: "completeness turn",
        content: words(200, "c"),
        insight: "a short insight line",
        filesRead: [],
        filesModified: [],
        createdAtEpoch: 1_301,
        updatedAtEpoch: null,
        observations: [],
      });

      recallMemory(db, {
        filter: {
          fields: ["content", "insight"],
          fieldBudgets: { content: 5 },
        },
        turn: 5000,
        readerId: "session:1",
        now: () => 5_000,
      });

      expect(completenessRow(turn.id, "content")?.complete).toBe(0);
      expect(completenessRow(turn.id, "insight")?.complete).toBe(1);
    });

    test("addressed render: a field clipped by its OWN fieldBudgets records incomplete even though the whole-block ladder never fires", () => {
      const sessionId = makeSession("addressed-completeness", "Completeness", 1_400);
      const turn = saveTurn(db, {
        sessionId,
        promptNumber: 1,
        userPrompt: "prompt text",
        assistantResponse: "r",
        title: "completeness turn",
        content: words(200, "c"),
        insight: "a short insight line",
        filesRead: [],
        filesModified: [],
        createdAtEpoch: 1_401,
        updatedAtEpoch: null,
        observations: [],
      });

      // `turn` generous enough that the whole-block ladder itself never
      // cuts anything (bodyComplete stays true throughout) — isolating
      // fieldBudgets' own completeness contribution.
      recallMemory(db, {
        id: `S${sessionId}/T${turn.promptNumber}`,
        filter: {
          fields: ["title", "content", "insight"],
          fieldBudgets: { content: 5 },
        },
        turn: 5000,
        readerId: "session:1",
        now: () => 5_000,
      });

      expect(completenessRow(turn.id, "content")?.complete).toBe(0);
      expect(completenessRow(turn.id, "insight")?.complete).toBe(1);
      expect(completenessRow(turn.id, "title")?.complete).toBe(1);
    });

    test("addressed render: a field whose OWN budget left it whole still records incomplete when the whole-block ladder cuts it anyway", () => {
      const sessionId = makeSession("addressed-ladder-wins", "Ladder still wins", 1_500);
      const turn = saveTurn(db, {
        sessionId,
        promptNumber: 1,
        userPrompt: "prompt text",
        assistantResponse: "r",
        title: "ladder turn",
        content: words(200, "c"),
        insight: null,
        filesRead: [],
        filesModified: [],
        createdAtEpoch: 1_501,
        updatedAtEpoch: null,
        observations: [],
      });

      // `fieldBudgets.content` is generous (never cuts content on its own),
      // but the shared `turn` is tiny — the whole-block ladder still cuts
      // the assembled render, and content must record incomplete because of
      // that, never overclaiming complete just because its own budget was
      // never the reason.
      recallMemory(db, {
        id: `S${sessionId}/T${turn.promptNumber}`,
        filter: { fields: ["title", "content"], fieldBudgets: { content: 5000 } },
        turn: 10,
        readerId: "session:1",
        now: () => 5_000,
      });

      expect(completenessRow(turn.id, "content")?.complete).toBe(0);
    });
  });

  describe("schema validation (defense-in-depth: parseMemoryFilter, exercised directly by recallMemory)", () => {
    test("an unrecognized fieldBudgets key rejects, naming the problem", () => {
      const output = recallMemory(db, {
        // @ts-expect-error — deliberately invalid for the error-path assertion.
        filter: { fieldBudgets: { bogus: 50 } },
      });
      expect(output).toContain("Parameter error");
      expect(output).toContain("invalid filter.fieldBudgets entry");
      expect(output).toContain("bogus");
    });

    test("a non-positive fieldBudgets value rejects, naming the problem", () => {
      const output = recallMemory(db, {
        filter: { fieldBudgets: { prompt: 0 } },
      });
      expect(output).toContain("Parameter error");
      expect(output).toContain('invalid filter.fieldBudgets["prompt"]');
    });

    test("a negative fieldBudgets value rejects", () => {
      const output = recallMemory(db, {
        filter: { fieldBudgets: { prompt: -10 } },
      });
      expect(output).toContain("Parameter error");
    });

    // Ticket 13 (implementation-review P2 sweep, item 3): `files`/
    // `observations` are legal `filter.fields` names but their renderer
    // never reads a `fieldBudgets` entry — the schema (definitions.ts) is
    // the public gate, but `parseMemoryFilter` is the one shared runtime
    // parser both `recall` and `timeline` call, so the rejection is pinned
    // here too, naming the reason rather than echoing the generic grammar.
    test("fieldBudgets.files rejects, naming why (files has no per-field cut point)", () => {
      const output = recallMemory(db, {
        // @ts-expect-error — deliberately excluded from FieldBudgetEligibleField.
        filter: { fieldBudgets: { files: 50 } },
      });
      expect(output).toContain("Parameter error");
      expect(output).toContain('invalid filter.fieldBudgets entry "files"');
      expect(output).toContain("renderFileTree renders the whole tree");
    });

    test("fieldBudgets.observations rejects, naming why (observations render as nested child turns)", () => {
      const output = recallMemory(db, {
        // @ts-expect-error — deliberately excluded from FieldBudgetEligibleField.
        filter: { fieldBudgets: { observations: 50 } },
      });
      expect(output).toContain("Parameter error");
      expect(output).toContain('invalid filter.fieldBudgets entry "observations"');
      expect(output).toContain("nested child turns");
    });

    test("fieldBudgets.title still parses — the one documented structural no-op stays admitted", () => {
      const output = recallMemory(db, {
        filter: { fields: ["title"], fieldBudgets: { title: 50 } },
      });
      expect(output).not.toContain("Parameter error");
    });
  });
});
