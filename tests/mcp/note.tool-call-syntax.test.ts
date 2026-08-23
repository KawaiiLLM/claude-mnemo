import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { getShadowNote } from "../../src/db/shadow-notes";
import { upsertSession } from "../../src/db/sessions";
import { isNoteSuccess, noteTool } from "../../src/mcp/note";
import { resetToolCallSyntaxRejectionsForTests } from "../../src/shared/tool-call-syntax";

/**
 * write-gate-hardening ticket 01, second half: the tool-call-syntax rejection
 * as the CALLER sees it, through the real `note` entry point.
 *
 * Two behaviours meet here. The shape echo names, in prose, which closing tag
 * was written wrong and which parameters therefore never landed. The loop
 * naming counts consecutive rejections per turn address, because a malformed
 * call that has entered a session's context is copied by every retry — the
 * caller cannot see that from inside the loop, so the rejection says it.
 *
 * The markup fixtures are assembled from fragments rather than written whole:
 * a literal antml-prefixed closing tag in a source file is parsed as the end
 * of a tool call by the harness writing the file, and a complete call sitting
 * in a test file is one more exemplar for whatever reads this repo next.
 */
const LT = "<";
const OPEN = (name: string): string => `${LT}parameter name="${name}">`;
const CLOSE = `${LT}/parameter>`;
const fieldNamedClosing = (name: string): string => `${LT}/${name}>`;

const GLUED_CONTENT = `The conclusions.${fieldNamedClosing("content")}\n${OPEN("insight")}A reusable lesson.`;

function resultText(result: { content: Array<{ text: string }> }): string {
  return result.content[0]!.text;
}

describe("note — tool-call-syntax rejection: shape echo and loop naming", () => {
  let db: Database;
  let sessionId: number;
  let firstTurnId: number;

  beforeEach(() => {
    resetToolCallSyntaxRejectionsForTests();
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionId = upsertSession(db, {
      contentSessionId: "syntax-session",
      project: "claude-mnemo",
      title: "Syntax session",
      content: null,
      insight: null,
      createdAtEpoch: 100,
      updatedAtEpoch: 100,
      completedAtEpoch: null,
    }).id;
    const insertTurn = db.query<{ id: number }, [number, number, string, number]>(
      `INSERT INTO turns (session_id, prompt_number, status, user_prompt, created_at_epoch)
       VALUES (?, ?, 'extracted', ?, ?) RETURNING id`,
    );
    firstTurnId = insertTurn.get(sessionId, 1, "First prompt", 120)!.id;
    insertTurn.get(sessionId, 2, "Second prompt", 130);
  });

  afterEach(() => {
    db.close();
  });

  function reject(promptNumber: number): string {
    return resultText(
      noteTool(
        db,
        {
          turn: `S${sessionId}/T${promptNumber}`,
          title: "implement+note: a title",
          content: GLUED_CONTENT,
        },
        { now: () => 900, env: {} },
      ),
    );
  }

  test("the first rejection echoes the shape in prose and names the parameter that did not land", () => {
    const text = reject(1);

    expect(text).toStartWith("Parameter error:");
    expect(text).toContain("content");
    expect(text).toContain("insight");
    expect(text).toContain("literal text");
    expect(text).toContain("Nothing was stored");
    // RED LINE: the rejection returns into the caller's own context, so it
    // describes the markup and never reproduces it.
    expect(text).not.toContain(LT);
    // A first rejection is not yet a loop, and must not accuse one.
    expect(text).not.toContain("in a row");
    expect(getShadowNote(db, firstTurnId)).toBeNull();
  });

  test("the second consecutive rejection for the same address names the loop and says what to do instead", () => {
    reject(1);
    const text = reject(1);

    expect(text).toContain("rejection 2 in a row");
    expect(text).toContain(`S${sessionId}/T1`);
    expect(text.toLowerCase()).toContain("settlement");
    expect(text.toLowerCase()).toContain("compact");
    // The escalation is appended to the shape echo, never a replacement for
    // it: the caller still needs to know WHAT was malformed.
    expect(text).toContain("insight");
    expect(text).not.toContain(LT);
  });

  test("a different turn address does not inherit the run", () => {
    reject(1);
    reject(1);
    const other = reject(2);

    expect(other).not.toContain("in a row");
    // …and the first address's own run is untouched by the detour.
    expect(reject(1)).toContain("rejection 3 in a row");
  });

  test("a successful write on the address ends the run — the next rejection starts over", () => {
    reject(1);
    reject(1);

    const success = noteTool(
      db,
      {
        turn: `S${sessionId}/T1`,
        title: "implement+note: a well-formed title",
        content: "Well-formed conclusions.",
      },
      { now: () => 901, env: {} },
    );
    expect(isNoteSuccess(success)).toBe(true);

    const after = reject(1);
    expect(after).not.toContain("in a row");
  });

  test("a non-conforming tail falls back to the generic message rather than misattributing a field", () => {
    const text = resultText(
      noteTool(
        db,
        {
          turn: `S${sessionId}/T1`,
          title: "implement+note: a title",
          content:
            `Conclusions.${fieldNamedClosing("content")}\n${OPEN("insight")}Lesson.${CLOSE}\n` +
            "and then the model went on writing ordinary sentences.",
        },
        { now: () => 900, env: {} },
      ),
    );

    expect(text).toStartWith("Parameter error:");
    expect(text).toContain("tool-call syntax");
    // The generic wording: no claim about which parameter was carried in,
    // because the tail did not parse well enough to know.
    expect(text).not.toContain("literal text");
    expect(text).not.toContain(LT);
  });

  test("the edit form's own syntax rejection escalates on the same counter", () => {
    // mode.<field> is the other guarded path into the same rejection: it goes
    // through parseModeMap rather than resolveStringField, and runs before the
    // turn row is even loaded — the counter still has to key on the address.
    const editCall = (): string =>
      resultText(
        noteTool(
          db,
          {
            turn: `S${sessionId}/T1`,
            mode: {
              content: { mode: "edit", oldString: "x", newString: GLUED_CONTENT },
            },
          },
          { now: () => 900, env: {} },
        ),
      );

    expect(editCall()).toContain("mode.content.newString");
    expect(editCall()).toContain("rejection 2 in a row");
  });
});
