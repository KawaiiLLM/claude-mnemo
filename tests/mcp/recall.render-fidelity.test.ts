import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { checkRelationsGate } from "../../src/db/write-gate";
import { WORKER_TOOL_RESULT_MAX_CHARS } from "../../src/mcp/handlers";
import { recallMemory, recallMemoryDelivery } from "../../src/mcp/recall";
import { estimateTokens } from "../../src/utils/token-estimate";

/**
 * floor-and-render-fidelity ticket 02 — recall renders only what the caller
 * selected (ruling [S15069/T1477]: "prompt 不也是字段，如果不选就应该忠实留空").
 *
 * The three properties this file exists for, in the order the incident
 * [S15069/T1469] exposed them:
 *
 *   1. A note-less turn's label is the bare address plus its status marker.
 *      The prompt reaches a reader through the `prompt` FIELD ROW or not at
 *      all — on the unified renderer (`format.ts`) and on the browse feed
 *      (`recall.ts`'s own row), which carried a second copy of the same
 *      fallback.
 *   2. Because the prompt now renders inside the turn BODY, the per-item
 *      `turn` budget cuts it. The label is the one line
 *      `capRenderToTokenBudget` never drops, so a synthetic multi-kilobyte
 *      prompt used to consume a whole page from a position no budget reached.
 *   3. Therefore a note-less turn runs the ordinary field-render path: the
 *      fields the caller asked for actually DELIVER, and their grants reach
 *      the write gate — including `relations` on a turn with no edges at all,
 *      which is what `checkRelationsGate` consumes.
 */

const NOW = 1_800_000_000;
const READER = "session:1";

let db: Database;

beforeEach(() => {
  db = createDatabase(":memory:");
  initializeSchema(db);
});

afterEach(() => db.close());

function seedSession(contentSessionId: string): number {
  return upsertSession(db, {
    contentSessionId,
    project: "/tmp/render-fidelity",
    title: "render fidelity session",
    content: null,
    insight: null,
    createdAtEpoch: NOW - 1_000,
    updatedAtEpoch: NOW - 1_000,
    completedAtEpoch: null,
  }).id;
}

/** One turn. `title`/`content` null is a NOTE-LESS turn — the shape this ticket is about. */
function seedTurn(
  sessionId: number,
  promptNumber: number,
  options: {
    userPrompt?: string;
    title?: string | null;
    content?: string | null;
    status?: string;
  } = {},
): number {
  return db
    .query<{ id: number }, [number, number, string, string, string | null, string | null, number]>(
      `INSERT INTO turns (
         session_id, prompt_number, status, user_prompt, assistant_response,
         title, content, tool_call_count, created_at_epoch, type, tags
       ) VALUES (?, ?, ?, ?, 'the answer', ?, ?, 0, ?, '[]', '[]')
       RETURNING id`,
    )
    .get(
      sessionId,
      promptNumber,
      options.status ?? "skipped",
      options.userPrompt ?? `prompt ${promptNumber}`,
      options.title ?? null,
      options.content ?? null,
      NOW - 100 + promptNumber,
    )!.id;
}

/**
 * The synthetic prompt the incident turned on: a task-notification payload far
 * larger than any per-item budget AND larger than the worker channel's own
 * 100K-character envelope, so a render that puts it in the label pushes every
 * later block past the cut where grants stop being recorded.
 */
function giantPrompt(): string {
  return `<task-notification>\n${"payload line that says nothing about the work\n".repeat(4_000)}</task-notification>`;
}

function completeness(turnId: number, field: string): { complete: number } | null {
  return db
    .query<{ complete: number }, [string, number, string]>(
      `SELECT complete FROM write_gate_field_completeness
       WHERE writer = ? AND entity_type = 'turn' AND entity_id = ? AND field = ?`,
    )
    .get(READER, turnId, field);
}

function grantCount(turnId: number): number {
  return (
    db
      .query<{ count: number }, [string, number]>(
        `SELECT COUNT(*) AS count FROM write_gate_reads
         WHERE writer = ? AND entity_type = 'turn' AND entity_id = ?`,
      )
      .get(READER, turnId)?.count ?? 0
  );
}

describe("the label renders the stored title or nothing at all", () => {
  test("a note-less turn is the bare address plus its status marker, on the addressed route", () => {
    const sessionId = seedSession("label-addressed");
    seedTurn(sessionId, 1, { userPrompt: "why is the refresh racing?" });

    const output = recallMemory(db, {
      id: `S${sessionId}/T1`,
      filter: { fields: ["title"] },
    });

    expect(output).toContain("T1 [skipped]");
    expect(output).not.toContain("why is the refresh racing?");
    expect(output).not.toContain("Untitled");
  });

  test("the browse feed's own row carries no fallback either — its second copy retired with the first", () => {
    const sessionId = seedSession("label-browse");
    const turnId = seedTurn(sessionId, 1, { userPrompt: "why is the refresh racing?" });

    const titleOnly = recallMemory(db, { filter: { fields: ["title"] } });
    expect(titleOnly).toContain("T1 [skipped]");
    expect(titleOnly).not.toContain("why is the refresh racing?");
    expect(titleOnly).not.toContain("Untitled");

    // Selected, it renders — as a field line under the row, like every other
    // field the browse feed shows.
    const withPrompt = recallMemory(db, {
      filter: { fields: ["title", "prompt"] },
      readerId: READER,
      now: () => NOW,
    });
    expect(withPrompt).toContain("- prompt: why is the refresh racing?");
    expect(grantCount(turnId)).toBe(1);
  });
});

describe("the prompt row is inside the per-item turn budget, not outside it", () => {
  test("a giant-prompt note-less turn stays within its `turn` budget once the prompt is a field", () => {
    const sessionId = seedSession("budget-addressed");
    seedTurn(sessionId, 1, { userPrompt: giantPrompt() });

    const output = recallMemory(db, {
      id: `S${sessionId}/T1`,
      filter: { fields: ["title", "prompt"] },
      turn: 80,
    });

    // The session transition line above the row is its own capped node, and
    // the navigation legend below it is response-scoped; the turn block
    // between them is what the `turn` budget governs.
    const legendAt = output.indexOf("\n\nLegend:");
    const turnBlock = output.slice(
      output.indexOf("T1 "),
      legendAt === -1 ? undefined : legendAt,
    );
    expect(estimateTokens(turnBlock)).toBeLessThanOrEqual(80);
    expect(turnBlock).toContain("- prompt:");
    expect(turnBlock).toContain("…");
  });

  test("a giant-prompt turn no longer starves the page: its siblings still land on it", () => {
    const sessionId = seedSession("budget-page");
    seedTurn(sessionId, 1, { title: "first turn", content: "did a thing" });
    seedTurn(sessionId, 2, { userPrompt: giantPrompt() });
    seedTurn(sessionId, 3, { title: "third turn", content: "did another" });

    const output = recallMemory(db, {
      id: `S${sessionId}/T1..T3`,
      filter: { fields: ["title", "metadata", "content", "prompt", "relations"] },
      pageBudget: 1_000,
    });

    // One page holds all three: the oversized prompt costs its own turn's
    // budget and nothing more, so pagination is not forced item-by-item.
    expect(output).not.toContain("page 1 /");
    for (const address of ["T1 ", "T2 ", "T3 "]) {
      expect(output).toContain(address);
    }
    expect(estimateTokens(output)).toBeLessThanOrEqual(1_000);
    // The later fields of the LAST turn still render — the property the
    // incident lost when one label ate the page.
    expect(output).toContain("- content: did another");
  });
});

describe("a note-less turn runs the ordinary field-render path — requested fields deliver and grant", () => {
  test("a relations read of a note-less, zero-edge turn satisfies the relations gate", () => {
    const sessionId = seedSession("relations-gate");
    const turnId = seedTurn(sessionId, 1, { userPrompt: giantPrompt() });
    const address = `S${sessionId}/T1`;

    // Step 0's own call shape (settlement Block A), on a turn with no note and
    // no edges at all.
    recallMemory(db, {
      id: address,
      filter: { fields: ["title", "metadata", "content", "insight", "relations"] },
      readerId: READER,
      now: () => NOW,
    });

    expect(completeness(turnId, "relations")?.complete).toBe(1);
    expect(checkRelationsGate(db, READER, turnId, address).ok).toBe(true);
  });

  test("the browse feed grants it too — a selected field with nothing stored still delivered", () => {
    const sessionId = seedSession("relations-gate-browse");
    const turnId = seedTurn(sessionId, 1, { userPrompt: giantPrompt() });

    recallMemory(db, {
      filter: { fields: ["title", "metadata", "content", "insight", "relations"] },
      readerId: READER,
      now: () => NOW,
    });

    expect(completeness(turnId, "relations")?.complete).toBe(1);
    expect(checkRelationsGate(db, READER, turnId, `S${sessionId}/T1`).ok).toBe(true);
  });

  test("the grant comes from the SELECTION, not for free — a read without `relations` still refuses", () => {
    const sessionId = seedSession("relations-gate-control");
    const turnId = seedTurn(sessionId, 1);
    const address = `S${sessionId}/T1`;

    recallMemory(db, {
      id: address,
      filter: { fields: ["title", "content"] },
      readerId: READER,
      now: () => NOW,
    });

    expect(completeness(turnId, "relations")).toBeNull();
    const verdict = checkRelationsGate(db, READER, turnId, address);
    expect(verdict.ok).toBe(false);
    expect(!verdict.ok && verdict.reason).toBe("incomplete-read");
  });

  test("under the worker's 100K envelope, every turn of the page still delivers its grant", () => {
    const sessionId = seedSession("envelope");
    const turnIds = [
      seedTurn(sessionId, 1, { title: "first turn", content: "did a thing" }),
      seedTurn(sessionId, 2, { userPrompt: giantPrompt() }),
      seedTurn(sessionId, 3, { title: "third turn", content: "did another" }),
    ];

    const delivery = recallMemoryDelivery(db, {
      id: `S${sessionId}/T1..T3`,
      filter: { fields: ["title", "metadata", "content", "insight", "relations"] },
      readerId: READER,
      now: () => NOW,
    });
    // The worker channel's own cut — the one the ledger measures grants
    // against (`handlers.ts`). The whole page fits inside it now; the label
    // fallback used to push most of it past the cut.
    expect(delivery.text.length).toBeLessThan(WORKER_TOOL_RESULT_MAX_CHARS);
    delivery.commitDelivered(
      Math.min(delivery.text.length, WORKER_TOOL_RESULT_MAX_CHARS),
    );

    for (const turnId of turnIds) {
      expect(grantCount(turnId)).toBe(1);
      expect(completeness(turnId, "relations")?.complete).toBe(1);
      expect(checkRelationsGate(db, READER, turnId, `S${sessionId}/T?`).ok).toBe(true);
    }
  });
});

describe("fixed-shape surfaces declare `prompt` instead of inheriting a fallback", () => {
  test("the `O*` route's turn header keeps a note-less turn legible, now budget-capped", () => {
    const sessionId = seedSession("observation-context");
    const turnId = seedTurn(sessionId, 1, { userPrompt: "why is the refresh racing?" });
    db.query<unknown, [number]>(
      `INSERT INTO observations (
         turn_id, tool_name, tool_input, tool_result, status, title, content,
         excluded_from_extraction, created_at_epoch
       ) VALUES (?, 'Edit', '{"file_path":"src/a.ts"}', 'ok', 'extracted',
         'Edit src/a.ts', 'edited', 0, ${NOW - 90})`,
    ).run(turnId);

    const output = recallMemory(db, { id: `S${sessionId}/T1/O*` });

    // The row is the header its observations hang under: no caller field
    // selection reaches it, so the surface itself declares the prompt.
    expect(output).toContain('- prompt: "why is the refresh racing?"');
    expect(output).toContain("[O");
  });
});
