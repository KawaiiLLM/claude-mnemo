import { describe, expect, test } from "bun:test";

import { createDatabase } from "../../src/db/database";
import { createRuleStore } from "../../src/db/rules";
import { initializeSchema } from "../../src/db/schema";
import {
  addSegmentMembers,
  attachSegmentToSession,
  createSegment,
  SEGMENT_CONTAINER_ERA_CUTOFF_EPOCH,
} from "../../src/db/segments";

// Ticket 02: the roster applies the segment-era freeze by default, so every
// fixture segment that should be visible must be minted inside the era.
const ERA = SEGMENT_CONTAINER_ERA_CUTOFF_EPOCH;
import { upsertSession } from "../../src/db/sessions";
import {
  createContextHandler,
  createReadOnlyContextHandler,
} from "../../src/hooks/handlers/context";
import { createSegmentBlockContextHandler } from "../../src/hooks/handlers/context-segments";
import type { NormalizedHookInput } from "../../src/hooks/types";

const SOURCES = ["startup", "clear", "resume", "compact"] as const;

describe("SessionStart injection matrix", () => {
  for (const source of SOURCES) {
    test(`${source} renders the roster ungated, gates segment blocks to resume|compact, persona/digest stay ungated, side effects run once`, async () => {
      const db = createDatabase(":memory:");
      initializeSchema(db);
      const current = upsertSession(db, {
        contentSessionId: `current-${source}`,
        project: "/projects/matrix",
        title: `Current ${source}`,
        insight: null,
        createdAtEpoch: 1_700_000_100,
        updatedAtEpoch: null,
        completedAtEpoch: null,
      });
      const memberTurn = db
        .query<{ id: number }, [number]>(
          `INSERT INTO turns (
            session_id, prompt_number, status, user_prompt,
            assistant_response, title, type, created_at_epoch
          ) VALUES (?, 1, 'extracted', 'current prompt', 'current response',
            'Current milestone', '["feature"]', 1700000110)
          RETURNING id`,
        )
        .get(current.id)!;
      createRuleStore(db).create({
        name: `matrix-rule-${source}`,
        claim: "当前任务涉及断言时，先检查证据。",
        rationale: "防止无依据断言。",
        scope: "/projects/matrix",
        triggerKind: "none",
        triggerSpec: null,
        status: "confirmed",
        createdAtEpoch: 1_700_000_120,
      });
      // A stranded active turn — SessionStart recovery must enqueue turn-stop
      // regardless of which sections gate shut.
      db.query(
        `INSERT INTO turns (
          session_id, prompt_number, status, user_prompt,
          assistant_response, created_at_epoch
        ) VALUES (?, 2, 'active', 'stranded prompt',
          'stranded response', 1700000120)`,
      ).run(current.id);

      // An attached segment — the fixed pool's slot 1 should render it when
      // the section is unblocked, and stay silent otherwise.
      const segment = createSegment(db, {
        title: `Ship the matrix ${source}`,
        nowEpoch: ERA + 1_000,
      });
      addSegmentMembers(db, segment.id, [memberTurn.id], 1_700_000_000);
      attachSegmentToSession(db, current.id, segment.id, 1_700_000_050);

      const input: NormalizedHookInput = {
        eventName: "SessionStart",
        source,
        sessionId: `current-${source}`,
        cwd: "/projects/matrix",
        stopHookActive: false,
        raw: {},
      };
      const dependencies = {
        db,
        memoryStore: {
          dataRoot: "/virtual",
          readInjectionDocuments: async () => ({
            userProfile: "# User Profile\n\n- Matrix persona\n",
            experience: "# Experience\n\n- MUST_NOT_BE_INJECTED\n",
          }),
        },
      };

      const sessions = await createContextHandler(dependencies)(input);
      const persona = await createReadOnlyContextHandler(dependencies, "persona")(input);
      const digest = await createReadOnlyContextHandler(dependencies, "digest")(input);
      const segment1Fields = await createSegmentBlockContextHandler({ db }, 1, "fields")(input);

      // The roster renders on EVERY source (review overturned the
      // resume|compact gate): it serves the session that has not attached
      // anything yet — a cold start. Only the attached-segment blocks stay
      // gated: a cold session cannot have attachments to render. (The
      // `proposals` slot that used to be asserted alongside the roster here
      // retired with the `propose` verb — lane-model-v12 ticket 15.)
      expect(sessions.hookSpecificOutput).toContain("## Segment roster");
      if (source === "resume" || source === "compact") {
        expect(segment1Fields.hookSpecificOutput).toContain(
          `[E${segment.id}] · fields`,
        );
      } else {
        expect(segment1Fields).toEqual({ continue: true });
      }
      // Persona/digest are general orientation, not task-axis content — they
      // render on every SessionStart source, unlike the segment blocks above
      // (ticket 10).
      expect(persona.hookSpecificOutput).toContain("## Persona");
      expect(digest.hookSpecificOutput).toContain("## Rule Digest");
      expect(digest.hookSpecificOutput).toContain(`matrix-rule-${source}`);
      expect(digest.hookSpecificOutput).toContain("适用范围：仅当前项目");
      expect(persona.hookSpecificOutput).not.toContain("MUST_NOT_BE_INJECTED");
      expect(db.query<{ count: number }, [string]>(
        "SELECT COUNT(*) AS count FROM sessions WHERE content_session_id = ?",
      ).get(`current-${source}`)?.count).toBe(1);
      expect(db.query<{ count: number }, [number]>(
        `SELECT COUNT(*) AS count
         FROM pending_queue
         WHERE session_db_id = ? AND kind = 'turn-stop'`,
      ).get(current.id)?.count).toBe(1);
      expect(db.query<{ count: number }, [number]>(
        "SELECT COUNT(*) AS count FROM session_run_state WHERE session_db_id = ?",
      ).get(current.id)?.count).toBe(1);

      db.close();
    });
  }

  test("roster overflow points a discovered live segment to recall() and marks an attached-but-unrendered segment", async () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const current = upsertSession(db, {
      contentSessionId: "current-overflow",
      project: "/projects/matrix",
      title: "Current",
      insight: null,
      createdAtEpoch: 2_000,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });
    // One attached segment beyond the fixed pool's slot count.
    const attachedIds: number[] = [];
    for (let index = 1; index <= 4; index += 1) {
      const segment = createSegment(db, {
        title: `Attached lane ${index}`,
        nowEpoch: ERA + 1_000 + index,
      });
      attachSegmentToSession(db, current.id, segment.id, 1_000 + index);
      attachedIds.push(segment.id);
    }

    const result = await createContextHandler({ db })({
      eventName: "SessionStart",
      source: "resume",
      sessionId: "current-overflow",
      cwd: "/projects/matrix",
      stopHookActive: false,
      raw: {},
    });

    const output = result.hookSpecificOutput ?? "";
    // The most recently attached (highest id, most recently activity-ordered)
    // segment beyond the 3-slot pool gets a recall pointer instead of a block.
    expect(output).toContain(
      `attached, not rendered here — recall(id="E${attachedIds[0]}")`,
    );
    db.close();
  });
});
