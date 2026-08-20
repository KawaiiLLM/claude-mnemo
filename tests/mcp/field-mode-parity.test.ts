import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import {
  FieldModeError,
  modeRequiredMessage,
  parseModeMap,
  resolveStringField,
} from "../../src/mcp/field-mode";
import { noteTool } from "../../src/mcp/note";

/**
 * TICKET 07 (write-mode-edit-semantics spec D12): `mcp/field-mode.ts` is the
 * mode vocabulary's intended single home, and the settlement facade already
 * reads it. `mcp/note.ts` still carries its own byte-identical copy — ticket 06
 * held that file open, so the delete-and-import half could not land in the same
 * batch (see `mcp/field-mode.ts`'s own header for the two-step recipe).
 *
 * Until it does, THIS file is what keeps the two copies from drifting: every
 * case below runs the SAME input through the real `note` tool and through the
 * shared module, and asserts the rejection text is character-identical. A drift
 * in either copy fails here, naming the message that moved. When note.ts adopts
 * the module these tests keep passing unchanged — they then merely assert a
 * function against itself, which is the signal that this file can retire.
 */

const NOW = 1_800_000_000;

function resultText(result: { content: Array<{ text: string }> }): string {
  return result.content[0]!.text;
}

/** What the shared module throws for an input, as plain text. */
function sharedMessage(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof FieldModeError) {
      return error.message;
    }
    throw error;
  }
  throw new Error("expected the shared field-mode engine to reject this input");
}

describe("mcp/field-mode.ts and mcp/note.ts's own copy reject identically (ticket 07)", () => {
  let db: Database;
  let sessionId: number;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionId = upsertSession(db, {
      contentSessionId: "field-mode-parity-session",
      project: "claude-mnemo",
      title: "field mode parity",
      content: null,
      insight: null,
      createdAtEpoch: NOW - 1_000,
      updatedAtEpoch: NOW - 1_000,
      completedAtEpoch: null,
    }).id;
    db.query<unknown, [number, number, string, number]>(
      `INSERT INTO turns (session_id, prompt_number, status, user_prompt, created_at_epoch)
       VALUES (?, ?, 'extracted', ?, ?)`,
    ).run(sessionId, 1, "a prompt", NOW - 900);
    // A first note, so every case below lands on a NON-EMPTY field.
    const seeded = noteTool(
      db,
      {
        turn: `S${sessionId}/T1`,
        title: "a stored title",
        content: "a stored content row",
      },
      { now: () => NOW },
    );
    expect(resultText(seeded)).toContain("Noted");
  });

  afterEach(() => {
    db.close();
  });

  function noteMessage(input: Record<string, unknown>): string {
    return resultText(
      noteTool(db, { turn: `S${sessionId}/T1`, ...input }, { now: () => NOW + 1 }),
    ).replace(/^Parameter error: /, "");
  }

  test("a retired mode literal names the same replacement on both", () => {
    expect(noteMessage({ title: "x", mode: { title: "overwrite" } })).toBe(
      sharedMessage(() => parseModeMap({ title: "overwrite" }, ["title"])),
    );
    expect(noteMessage({ content: "x", mode: { content: "append" } })).toBe(
      sharedMessage(() => parseModeMap({ content: "append" }, ["content"])),
    );
  });

  test("the edit form on a set field is refused in the same words", () => {
    expect(
      noteMessage({
        type: ["design"],
        mode: { type: { mode: "edit", oldString: "a", newString: "b" } },
      }),
    ).toBe(
      sharedMessage(() =>
        parseModeMap({ type: { mode: "edit", oldString: "a", newString: "b" } }, ["type"]),
      ),
    );
  });

  test("a mode naming a field the call does not accept is refused in the same words", () => {
    expect(noteMessage({ title: "x", mode: { nonesuch: "write" } })).toBe(
      sharedMessage(() => parseModeMap({ nonesuch: "write" }, ["title"])),
    );
  });

  test("a non-empty field with no mode produces the same required-mode message", () => {
    expect(noteMessage({ title: "a replacement title" })).toBe(modeRequiredMessage("title"));
    expect(
      sharedMessage(() =>
        resolveStringField("title", "a replacement title", "a stored title", undefined, {
          nullable: false,
        }),
      ),
    ).toBe(modeRequiredMessage("title"));
  });

  test("an unmatched and an ambiguous oldString are refused in the same words", () => {
    expect(
      noteMessage({ mode: { content: { mode: "edit", oldString: "absent", newString: "x" } } }),
    ).toBe(
      sharedMessage(() =>
        resolveStringField(
          "content",
          undefined,
          "a stored content row",
          { mode: "edit", oldString: "absent", newString: "x" },
          { nullable: false },
        ),
      ),
    );

    // Two hits: "row" appears twice once the stored text repeats it.
    noteTool(
      db,
      {
        turn: `S${sessionId}/T1`,
        content: "row and row",
        mode: { content: "write" },
      },
      { now: () => NOW + 2 },
    );
    expect(
      noteMessage({ mode: { content: { mode: "edit", oldString: "row", newString: "x" } } }),
    ).toBe(
      sharedMessage(() =>
        resolveStringField(
          "content",
          undefined,
          "row and row",
          { mode: "edit", oldString: "row", newString: "x" },
          { nullable: false },
        ),
      ),
    );
  });

  test("supplying both the value and the edit form is refused in the same words", () => {
    expect(
      noteMessage({
        content: "x",
        mode: { content: { mode: "edit", oldString: "a stored", newString: "y" } },
      }),
    ).toBe(
      sharedMessage(() =>
        resolveStringField(
          "content",
          "x",
          "a stored content row",
          { mode: "edit", oldString: "a stored", newString: "y" },
          { nullable: false },
        ),
      ),
    );
  });
});
