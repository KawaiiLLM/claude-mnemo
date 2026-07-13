import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { initializeSchema } from "../../src/db/schema";
import { estimateDiaryTokens } from "../../src/diary/domain";
import {
  loadDiaryMaterial,
  loadDiaryTurnReferences,
  renderDiaryMaterial,
  type DiaryMaterialRow,
} from "../../src/worker/diary-material";

function materialRow(
  overrides: Partial<DiaryMaterialRow> = {},
): DiaryMaterialRow {
  return {
    turnId: 41,
    sessionId: 7,
    project: "/projects/dream",
    sessionTitle: "Dream agent",
    promptNumber: 3,
    status: "extracted",
    userPrompt: "Please summarize this turn.",
    assistantResponse: "Raw response",
    title: "Material manifest v2",
    content: "Rendered the enriched material fields.",
    insight: null,
    ...overrides,
  };
}

describe("renderDiaryMaterial", () => {
  test("loads the complete configured calendar day across a DST repeat", () => {
    const db = new Database(":memory:");
    initializeSchema(db);
    try {
      const sessionId = db.query<{ id: number }, []>(
        "INSERT INTO sessions (content_session_id, project, created_at_epoch) VALUES ('dst-material', '/project', 1) RETURNING id",
      ).get()!.id;
      const insert = db.query(
        "INSERT INTO turns (session_id, prompt_number, status, user_prompt, created_at_epoch) VALUES (?, ?, 'skipped', ?, ?)",
      );
      for (const [number, label, timestamp] of [
        [1, "before", "2026-11-01T03:59:59Z"],
        [2, "first repeated day material", "2026-11-01T04:00:00Z"],
        [3, "last repeated day material", "2026-11-02T04:59:59Z"],
        [4, "after", "2026-11-02T05:00:00Z"],
      ] as const) {
        insert.run(sessionId, number, label, Date.parse(timestamp) / 1_000);
      }

      expect(
        loadDiaryMaterial(db, "2026-11-01", "America/New_York")
          .map((row) => row.userPrompt),
      ).toEqual(["first repeated day material", "last repeated day material"]);
    } finally {
      db.close();
    }
  });

  test("renders extracted and unextracted turns with distinct field shapes", () => {
    expect(renderDiaryMaterial(materialRow(), new Map())).toEqual({
      kind: "turn_manifest",
      ref: "S7/T3",
      number: 3,
      status: "extracted",
      user_prompt: "Please summarize this turn.",
      summary: "Rendered the enriched material fields.",
    });

    expect(renderDiaryMaterial(materialRow({
      status: "active",
      title: null,
      content: null,
      assistantResponse: "The complete response.",
    }), new Map())).toEqual({
      kind: "turn_manifest",
      ref: "S7/T3",
      number: 3,
      status: "active",
      user_prompt: "Please summarize this turn.",
      response: "The complete response.",
    });
  });

  test("marks a skipped turn response as low trust", () => {
    expect(renderDiaryMaterial(materialRow({
      status: "skipped",
      title: null,
      content: null,
      assistantResponse: "Possibly misattributed response.",
    }), new Map())).toMatchObject({
      response: "Possibly misattributed response.",
      response_trust: "low",
    });
  });

  test("drops a redundant leading title from extracted content", () => {
    const rendered = renderDiaryMaterial(materialRow({
      title: "Material manifest v2",
      content: "Material manifest v2: Rendered the enriched material fields.",
    }), new Map());

    expect(rendered).toMatchObject({
      summary: "Rendered the enriched material fields.",
    });

    expect(renderDiaryMaterial(materialRow({
      title: "Title-only extraction",
      content: null,
    }), new Map())).toMatchObject({
      summary: "Title-only extraction",
    });
  });

  test("rewrites resolvable internal DB turn ids to S/T citations", () => {
    const rendered = renderDiaryMaterial(materialRow({
      title: "Follow-up",
      content: "Confirmed [T41]; unknown [T999] remains opaque.",
    }), new Map([[41, { sessionId: 9, promptNumber: 12 }]]));

    expect(rendered).toMatchObject({
      summary: "Confirmed [S9/T12]; unknown [T999] remains opaque.",
    });
  });

  test("loads DB turn ids as session-scoped prompt-number references", () => {
    const db = new Database(":memory:");
    initializeSchema(db);
    try {
      const sessionId = db.query<{ id: number }, []>(
        "INSERT INTO sessions (content_session_id, project, created_at_epoch) VALUES ('material-db', '/project', 1) RETURNING id",
      ).get()!.id;
      const turnId = db.query<{ id: number }, [number]>(
        "INSERT INTO turns (session_id, prompt_number, status, created_at_epoch) VALUES (?, 27, 'extracted', 1) RETURNING id",
      ).get(sessionId)!.id;
      expect(turnId).not.toBe(27);

      const row = materialRow({
        title: "Database pointer",
        content: `Resolved [T${turnId}], preserved [T99999].`,
      });
      const rendered = renderDiaryMaterial(
        row,
        loadDiaryTurnReferences(db, [row]),
      );

      expect(rendered).toMatchObject({
        summary: `Resolved [S${sessionId}/T27], preserved [T99999].`,
      });

      db.exec("PRAGMA foreign_keys = OFF");
      const danglingTurnId = db.query<{ id: number }, []>(
        "INSERT INTO turns (session_id, prompt_number, status, created_at_epoch) VALUES (99999, 4, 'extracted', 1) RETURNING id",
      ).get()!.id;
      const danglingRow = materialRow({
        content: `Dangling [T${danglingTurnId}] stays opaque.`,
      });
      expect(renderDiaryMaterial(
        danglingRow,
        loadDiaryTurnReferences(db, [danglingRow]),
      )).toMatchObject({
        summary: `Dangling [T${danglingTurnId}] stays opaque.`,
      });
    } finally {
      db.close();
    }
  });

  test("caps every prompt, summary, and response field at 200 diary tokens", () => {
    const extracted = renderDiaryMaterial(materialRow({
      userPrompt: "用户希望继续完善材料清单。".repeat(80),
      title: "材料清单",
      content: "这是需要保留的摘要内容。".repeat(80),
    }), new Map());
    const unextracted = renderDiaryMaterial(materialRow({
      status: "active",
      userPrompt: "Please preserve this complete prompt sentence. ".repeat(80),
      assistantResponse: "This is the response material sentence. ".repeat(80),
      title: null,
      content: null,
    }), new Map());

    expect(estimateDiaryTokens(extracted.user_prompt)).toBeLessThanOrEqual(200);
    expect("summary" in extracted).toBe(true);
    expect(estimateDiaryTokens("summary" in extracted ? extracted.summary : ""))
      .toBeLessThanOrEqual(200);
    expect(estimateDiaryTokens(unextracted.user_prompt)).toBeLessThanOrEqual(200);
    expect("response" in unextracted).toBe(true);
    expect(estimateDiaryTokens("response" in unextracted ? unextracted.response : ""))
      .toBeLessThanOrEqual(200);
  });

  test("truncates at sentence or word boundaries and appends an ellipsis", () => {
    const rendered = renderDiaryMaterial(materialRow({
      status: "active",
      userPrompt: "这是一个完整句子。".repeat(80),
      assistantResponse: "boundary ".repeat(100),
      title: null,
      content: null,
    }), new Map());

    expect(rendered.user_prompt).toMatch(/(?:。|这是|一个|完整|句子)…$/u);
    expect("response" in rendered ? rendered.response : "").toMatch(/boundary…$/u);

    const unpunctuatedCjk = renderDiaryMaterial(materialRow({
      userPrompt: "中华人民共和国".repeat(80),
    }), new Map());
    expect(unpunctuatedCjk.user_prompt).toMatch(/(?:中华|人民|共和国)…$/u);
  });
});
