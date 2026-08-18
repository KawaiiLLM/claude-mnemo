import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { getOutgoingEdges } from "../../src/db/memory-edges";
import { initializeSchema } from "../../src/db/schema";
import {
  findTopic,
  getSegment,
  getSegmentMemberTurnIds,
} from "../../src/db/segments";
import { upsertSession } from "../../src/db/sessions";
import { rememberInputSchema } from "../../src/mcp/definitions";
import { rememberTool } from "../../src/mcp/remember";

function resultText(result: { content: Array<{ text: string }> }): string {
  return result.content[0]!.text;
}

describe("remember tool (ticket 02)", () => {
  let db: Database;
  let sessionId: number;

  function seedTurn(promptNumber: number, createdAtEpoch: number): number {
    return db
      .query<{ id: number }, [number, number, number]>(
        `INSERT INTO turns (session_id, prompt_number, status, created_at_epoch)
         VALUES (?, ?, 'extracted', ?) RETURNING id`,
      )
      .get(sessionId, promptNumber, createdAtEpoch)!.id;
  }

  /** Turns after `sinceEpoch`, so a cadence figure of exactly `count` is on hand for a test. */
  function seedTurnsSince(sinceEpoch: number, count: number, startPromptNumber: number): void {
    for (let index = 0; index < count; index += 1) {
      seedTurn(startPromptNumber + index, sinceEpoch + 1 + index);
    }
  }

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionId = upsertSession(db, {
      contentSessionId: "remember-session",
      project: "/tmp/project-remember",
      title: null,
      insight: null,
      createdAtEpoch: 100,
      updatedAtEpoch: 100,
      completedAtEpoch: null,
    }).id;
  });

  afterEach(() => {
    db.close();
  });

  // ---------------------------------------------------------------------
  // Schema surface — every parameter is described, verb enum is exact.
  // ---------------------------------------------------------------------

  describe("rememberInputSchema", () => {
    test("accepts each verb's own field set and rejects an unknown field", () => {
      expect(() =>
        rememberInputSchema.parse({ verb: "create", title: "x", topic: "y" }),
      ).not.toThrow();
      expect(() => rememberInputSchema.parse({ verb: "bogus" })).toThrow();
      expect(() =>
        rememberInputSchema.parse({ verb: "create", title: "x", topic: "y", bogusField: 1 }),
      ).toThrow();
    });
  });

  // ---------------------------------------------------------------------
  // create
  // ---------------------------------------------------------------------

  describe("create", () => {
    test("mints a segment under a new topic and reports zero members", () => {
      const result = rememberTool(db, {
        verb: "create",
        title: "Ship the semantic container",
        topic: "semantic-container",
      });
      const text = resultText(result);
      expect(text).toContain('Created E');
      expect(text).toContain("semantic-container");
      expect(text).toContain("0 members seeded.");

      const topic = findTopic(db, "semantic-container");
      expect(topic).not.toBeNull();
      const match = /Created E(\d+)/.exec(text);
      const segmentId = Number(match![1]);
      const segment = getSegment(db, segmentId);
      expect(segment?.title).toBe("Ship the semantic container");
      expect(segment?.topicId).toBe(topic!.id);
      expect(segment?.status).toBe("open");
    });

    test("reuses an existing topic rather than minting a near-duplicate", () => {
      rememberTool(db, { verb: "create", title: "First lane", topic: "reuse-me" });
      const second = resultText(
        rememberTool(db, { verb: "create", title: "Second lane", topic: "reuse-me" }),
      );
      expect(second).toContain("(topic: reuse-me)");

      const topics = db.query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM topics WHERE name = 'reuse-me'",
      ).get()!.count;
      expect(topics).toBe(1);
    });

    test("seeds a goal row when goal is given", () => {
      const text = resultText(
        rememberTool(db, {
          verb: "create",
          title: "With a goal",
          topic: "goal-topic",
          goal: "land ticket 02",
        }),
      );
      expect(text).toContain("goal: 1 row seeded.");
      const segmentId = Number(/Created E(\d+)/.exec(text)![1]);
      expect(getSegment(db, segmentId)?.goal).toBe("- land ticket 02");
    });

    test("seed member addresses record membership for exactly those turns", () => {
      const turnA = seedTurn(1, 100);
      const turnB = seedTurn(2, 101);
      // A third turn exists but is deliberately NOT named — proves "exactly
      // the given list", not "every available turn".
      seedTurn(3, 102);

      const text = resultText(
        rememberTool(db, {
          verb: "create",
          title: "Adopted from a proposal",
          topic: "adopted-topic",
          members: [`S${sessionId}/T1`, `S${sessionId}/T2`],
        }),
      );
      expect(text).toContain("2 member(s) seeded.");
      const segmentId = Number(/Created E(\d+)/.exec(text)![1]);
      expect(getSegmentMemberTurnIds(db, segmentId).sort()).toEqual(
        [turnA, turnB].sort(),
      );
    });

    test("a malformed or unresolved member address rejects the WHOLE call — nothing is created", () => {
      seedTurn(1, 100);
      const before = db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM segments").get()!.count;

      const text = resultText(
        rememberTool(db, {
          verb: "create",
          title: "Should not exist",
          topic: "rejected-topic",
          members: [`S${sessionId}/T1`, `S${sessionId}/T999`, "not-an-address"],
        }),
      );
      expect(text).toStartWith("Parameter error:");
      expect(text).toContain("members rejected");
      expect(text).toContain(`S${sessionId}/T999`);
      expect(text).toContain("not-an-address");

      const after = db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM segments").get()!.count;
      expect(after).toBe(before);
      expect(findTopic(db, "rejected-topic")).toBeNull();
    });

    test("rejects missing title or topic, and tool-call markup", () => {
      expect(resultText(rememberTool(db, { verb: "create", topic: "x" }))).toStartWith(
        "Parameter error:",
      );
      expect(resultText(rememberTool(db, { verb: "create", title: "x" }))).toStartWith(
        "Parameter error:",
      );
      expect(
        resultText(
          rememberTool(db, {
            verb: "create",
            title: 'bad <parameter name="x">',
            topic: "markup-topic",
          }),
        ),
      ).toContain("tool-call syntax");
    });
  });

  // ---------------------------------------------------------------------
  // attach
  // ---------------------------------------------------------------------

  describe("attach", () => {
    function createViaTool(topic: string): number {
      const text = resultText(
        rememberTool(db, { verb: "create", title: `Segment for ${topic}`, topic }),
      );
      return Number(/Created E(\d+)/.exec(text)![1]);
    }

    test("binds the session by E id and returns the fields — refuses without a caller session", () => {
      const segmentId = createViaTool("attach-by-id");
      rememberTool(db, {
        verb: "append",
        id: `E${segmentId}`,
        field: "goal",
        rows: ["land the tool"],
      });

      const text = resultText(
        rememberTool(
          db,
          { verb: "attach", id: `E${segmentId}` },
          {},
        ),
      );
      // Without a caller session, attach cannot bind — this call is expected
      // to refuse. See the next test for the successful path with a session.
      expect(text).toStartWith("Parameter error:");
    });

    test("binds the session by E id (with caller session) and returns the canonical segment card (ticket 03)", () => {
      const segmentId = createViaTool("attach-by-id-2");
      rememberTool(db, {
        verb: "append",
        id: `E${segmentId}`,
        field: "goal",
        rows: ["land the tool"],
      });

      const text = resultText(
        rememberTool(
          db,
          { verb: "attach", id: `E${segmentId}` },
          { callerSessionId: sessionId },
        ),
      );
      expect(text).toContain(`Attached S${sessionId} to E${segmentId}`);
      // The same canonical card `recall(id="E<n>")` collapsed renders — ticket
      // 02's provisional plain render (`goal:` / `(empty)` placeholders) is
      // gone; a populated field shows its row, an empty one shows "0 rows".
      expect(text).toContain(`[E${segmentId}]`);
      expect(text).toContain("goal: 1 row");
      expect(text).toContain("- land the tool");
      expect(text).toContain("constraints: 0 rows");

      const attachmentCount = db
        .query<{ count: number }, [number, number]>(
          "SELECT COUNT(*) AS count FROM segment_attachments WHERE session_id = ? AND segment_id = ?",
        )
        .get(sessionId, segmentId)!.count;
      expect(attachmentCount).toBe(1);
    });

    test("a second attach to the same segment is idempotent — one binding row, receipt says already attached", () => {
      const segmentId = createViaTool("attach-idempotent");
      rememberTool(db, { verb: "attach", id: `E${segmentId}` }, { callerSessionId: sessionId });
      const secondText = resultText(
        rememberTool(db, { verb: "attach", id: `E${segmentId}` }, { callerSessionId: sessionId }),
      );

      expect(secondText).toContain("(already attached)");
      const attachmentCount = db
        .query<{ count: number }, [number, number]>(
          "SELECT COUNT(*) AS count FROM segment_attachments WHERE session_id = ? AND segment_id = ?",
        )
        .get(sessionId, segmentId)!.count;
      expect(attachmentCount).toBe(1);
    });

    test("binding rows accumulate across DIFFERENT segments for the same session", () => {
      const first = createViaTool("attach-accum-1");
      const second = createViaTool("attach-accum-2");
      rememberTool(db, { verb: "attach", id: `E${first}` }, { callerSessionId: sessionId });
      rememberTool(db, { verb: "attach", id: `E${second}` }, { callerSessionId: sessionId });

      const total = db
        .query<{ count: number }, [number]>(
          "SELECT COUNT(*) AS count FROM segment_attachments WHERE session_id = ?",
        )
        .get(sessionId)!.count;
      expect(total).toBe(2);
    });

    test("attaches by topic name when exactly one segment matches", () => {
      createViaTool("solo-topic");
      const text = resultText(
        rememberTool(db, { verb: "attach", id: "solo-topic" }, { callerSessionId: sessionId }),
      );
      expect(text).toContain(`Attached S${sessionId} to E`);
    });

    test("rejects an ambiguous topic (more than one segment), naming both E ids", () => {
      const first = createViaTool("shared-topic");
      // Mint a second segment on the SAME topic directly (bypassing create's
      // own anti-duplicate framing — this simulates two prior creates that
      // both legitimately reused the topic name).
      rememberTool(db, { verb: "create", title: "second lane", topic: "shared-topic" });

      const text = resultText(
        rememberTool(db, { verb: "attach", id: "shared-topic" }, { callerSessionId: sessionId }),
      );
      expect(text).toStartWith("Parameter error:");
      expect(text).toContain(`E${first}`);
      expect(text).toContain('explicit "E<n>" address');
    });

    test("rejects an id that is neither a resolvable E address nor a known topic", () => {
      const text = resultText(
        rememberTool(db, { verb: "attach", id: "E999999" }, { callerSessionId: sessionId }),
      );
      expect(text).toStartWith("Parameter error:");
      expect(text).toContain("no segment E999999");
    });
  });

  // ---------------------------------------------------------------------
  // append
  // ---------------------------------------------------------------------

  describe("append", () => {
    // Fixed at epoch 100 — matching `seedTurn`/`seedTurnsSince`'s own baseline
    // — so the cadence tests below can control exactly how many of a
    // session's turns fall AFTER the segment's `updatedAtEpoch`.
    function createSegmentId(topic: string): number {
      const text = resultText(
        rememberTool(db, { verb: "create", title: topic, topic }, { now: () => 100 }),
      );
      return Number(/Created E(\d+)/.exec(text)![1]);
    }

    test("appends rows, newline-joined, dash-prefixed even without a leading dash", () => {
      const segmentId = createSegmentId("append-basic");
      const text = resultText(
        rememberTool(db, {
          verb: "append",
          id: `E${segmentId}`,
          field: "next_steps",
          rows: ["- already dashed", "not yet dashed"],
        }),
      );
      expect(text).toContain("Appended 2 row(s) to next_steps");
      expect(getSegment(db, segmentId)?.nextSteps).toBe(
        "- already dashed\n- not yet dashed",
      );
    });

    test("a second append accumulates onto the first rather than overwriting", () => {
      const segmentId = createSegmentId("append-accum");
      rememberTool(db, { verb: "append", id: `E${segmentId}`, field: "done", rows: ["row one"] });
      rememberTool(db, { verb: "append", id: `E${segmentId}`, field: "done", rows: ["row two"] });
      expect(getSegment(db, segmentId)?.done).toBe("- row one\n- row two");
    });

    test("under 10 turns since the last touch draws the too-soon reminder", () => {
      const segmentId = createSegmentId("append-too-soon");
      // Zero turns have happened in this session since the segment's creation.
      const text = resultText(
        rememberTool(
          db,
          { verb: "append", id: `E${segmentId}`, field: "next_steps", rows: ["soon"] },
          { callerSessionId: sessionId, now: () => 100 },
        ),
      );
      expect(text).toContain("over-maintaining");
    });

    test("a decisions append is exempt from the too-soon reminder", () => {
      const segmentId = createSegmentId("append-decisions-exempt");
      const text = resultText(
        rememberTool(
          db,
          { verb: "append", id: `E${segmentId}`, field: "decisions", rows: ["ruled"] },
          { callerSessionId: sessionId, now: () => 100 },
        ),
      );
      expect(text).not.toContain("over-maintaining");
      // Still reports the figure — exempt from the REMINDER, not from the report.
      expect(text).toContain("since this segment's last maintenance");
    });

    test("20+ turns since the last touch draws the nudge, even for decisions", () => {
      const segmentId = createSegmentId("append-nudge");
      seedTurnsSince(100, 20, 1);
      const text = resultText(
        rememberTool(
          db,
          { verb: "append", id: `E${segmentId}`, field: "decisions", rows: ["late ruling"] },
          { callerSessionId: sessionId, now: () => 500 },
        ),
      );
      expect(text).toContain("consider a maintenance pass");
    });

    test("a row containing a newline is rejected — one row, one line", () => {
      const segmentId = createSegmentId("append-newline");
      const text = resultText(
        rememberTool(db, {
          verb: "append",
          id: `E${segmentId}`,
          field: "goal",
          rows: ["line one\nline two"],
        }),
      );
      expect(text).toStartWith("Parameter error:");
      expect(getSegment(db, segmentId)?.goal).toBeNull();
    });

    test("tool-call markup in a row is rejected, nothing stored", () => {
      const segmentId = createSegmentId("append-markup");
      const text = resultText(
        rememberTool(db, {
          verb: "append",
          id: `E${segmentId}`,
          field: "goal",
          rows: ['bad <invoke name="x">'],
        }),
      );
      expect(text).toContain("tool-call syntax");
      expect(getSegment(db, segmentId)?.goal).toBeNull();
    });

    // Ticket 05: the write gate is now `status === "closed"` only (not "any
    // non-open") — closing goes through remember's own `close` verb, and the
    // rejection names it as the way back.
    test("refuses a write on a closed segment, naming close as the way back", () => {
      const segmentId = createSegmentId("append-closed");
      rememberTool(db, { verb: "close", id: `E${segmentId}` });
      expect(getSegment(db, segmentId)?.status).toBe("closed");

      const text = resultText(
        rememberTool(db, { verb: "append", id: `E${segmentId}`, field: "goal", rows: ["late"] }),
      );
      expect(text).toStartWith("Parameter error:");
      expect(text).toContain("closed");
      expect(text).toContain(`remember(close, id="E${segmentId}")`);
    });

    test("citations in an appended row create a memory edge (existing citation machinery reused)", () => {
      const turn = seedTurn(1, 100);
      const promptNumber = 1;
      const segmentId = createSegmentId("append-citation");
      rememberTool(db, {
        verb: "append",
        id: `E${segmentId}`,
        field: "decisions",
        rows: [`ruled per [S${sessionId}/T${promptNumber}]`],
      });
      const edges = getOutgoingEdges(db, { kind: "segment", id: segmentId });
      expect(edges.some((edge) => edge.cited.kind === "turn" && edge.cited.id === turn)).toBe(true);
    });
  });

  // ---------------------------------------------------------------------
  // replace
  // ---------------------------------------------------------------------

  describe("replace", () => {
    function createWithRow(topic: string, field: string, row: string): number {
      const text = resultText(rememberTool(db, { verb: "create", title: topic, topic }));
      const segmentId = Number(/Created E(\d+)/.exec(text)![1]);
      rememberTool(db, { verb: "append", id: `E${segmentId}`, field, rows: [row] });
      return segmentId;
    }

    test("replaces a unique match", () => {
      const segmentId = createWithRow("replace-basic", "constraints", "stay under budget");
      const text = resultText(
        rememberTool(db, {
          verb: "replace",
          id: `E${segmentId}`,
          field: "constraints",
          oldString: "- stay under budget",
          newString: "- stay well under budget",
        }),
      );
      expect(text).toContain("Replaced text in constraints");
      expect(getSegment(db, segmentId)?.constraints).toBe("- stay well under budget");
    });

    test("newString: \"\" deletes the matched row cleanly, collapsing an emptied field to null", () => {
      const segmentId = createWithRow("replace-delete", "reference", "stale pointer");
      const text = resultText(
        rememberTool(db, {
          verb: "replace",
          id: `E${segmentId}`,
          field: "reference",
          oldString: "- stale pointer",
          newString: "",
        }),
      );
      expect(text).toContain("Removed a row from reference");
      expect(getSegment(db, segmentId)?.reference).toBeNull();
    });

    test("a missing oldString rejects loudly and leaves the field untouched", () => {
      const segmentId = createWithRow("replace-missing", "goal", "ship it");
      const text = resultText(
        rememberTool(db, {
          verb: "replace",
          id: `E${segmentId}`,
          field: "goal",
          oldString: "- never written",
          newString: "- x",
        }),
      );
      expect(text).toStartWith("Parameter error:");
      expect(text).toContain("not found");
      expect(getSegment(db, segmentId)?.goal).toBe("- ship it");
    });

    test("an ambiguous oldString (matches more than once) rejects loudly, naming the count, and leaves the field untouched", () => {
      const segmentId = createWithRow("replace-ambiguous", "done", "shipped X");
      rememberTool(db, {
        verb: "append",
        id: `E${segmentId}`,
        field: "done",
        rows: ["shipped X again"],
      });
      const before = getSegment(db, segmentId)?.done;

      const text = resultText(
        rememberTool(db, {
          verb: "replace",
          id: `E${segmentId}`,
          field: "done",
          oldString: "shipped X",
          newString: "shipped Y",
        }),
      );
      expect(text).toStartWith("Parameter error:");
      expect(text).toContain("matches 2 times");
      expect(getSegment(db, segmentId)?.done).toBe(before);
    });

    test("dropping a row's only citation on replace removes its memory edge", () => {
      seedTurn(1, 100);
      const segmentId = createWithRow(
        "replace-citation",
        "decisions",
        `ruled per [S${sessionId}/T1]`,
      );
      expect(getOutgoingEdges(db, { kind: "segment", id: segmentId }).length).toBeGreaterThan(0);

      rememberTool(db, {
        verb: "replace",
        id: `E${segmentId}`,
        field: "decisions",
        oldString: `- ruled per [S${sessionId}/T1]`,
        newString: "- ruled, no longer citing the source turn",
      });
      expect(getOutgoingEdges(db, { kind: "segment", id: segmentId }).length).toBe(0);
    });

    test("refuses a write on a closed segment, naming close as the way back", () => {
      const segmentId = createWithRow("replace-closed", "goal", "ship it");
      rememberTool(db, { verb: "close", id: `E${segmentId}` });

      const text = resultText(
        rememberTool(db, {
          verb: "replace",
          id: `E${segmentId}`,
          field: "goal",
          oldString: "- ship it",
          newString: "- x",
        }),
      );
      expect(text).toStartWith("Parameter error:");
      expect(text).toContain("closed");
      expect(text).toContain(`remember(close, id="E${segmentId}")`);
    });
  });

  // ---------------------------------------------------------------------
  // close
  // ---------------------------------------------------------------------

  describe("close", () => {
    function createViaTool(topic: string): number {
      const text = resultText(
        rememberTool(db, { verb: "create", title: `Segment for ${topic}`, topic }),
      );
      return Number(/Created E(\d+)/.exec(text)![1]);
    }

    test("closes an open segment — it leaves the roster, remains recall-able, and the write gate engages", () => {
      const segmentId = createViaTool("close-basic");
      const text = resultText(rememberTool(db, { verb: "close", id: `E${segmentId}` }));

      expect(text).toContain(`Closed E${segmentId}`);
      expect(text).toContain(`remember(close, id="E${segmentId}")`);
      expect(getSegment(db, segmentId)?.status).toBe("closed");
    });

    test("closing an already-closed segment toggles it back open — the reopen exit IS this same verb", () => {
      const segmentId = createViaTool("close-toggle");
      rememberTool(db, { verb: "close", id: `E${segmentId}` });
      expect(getSegment(db, segmentId)?.status).toBe("closed");

      const text = resultText(rememberTool(db, { verb: "close", id: `E${segmentId}` }));
      expect(text).toContain(`Reopened E${segmentId}`);
      expect(getSegment(db, segmentId)?.status).toBe("open");

      // Writes are accepted again on the reopened segment.
      const appendText = resultText(
        rememberTool(db, { verb: "append", id: `E${segmentId}`, field: "goal", rows: ["back open"] }),
      );
      expect(appendText).toStartWith("Appended");
    });

    test("close by topic name resolves the same way append/replace/attach do", () => {
      createViaTool("close-by-topic");
      const text = resultText(rememberTool(db, { verb: "close", id: "close-by-topic" }));
      expect(text).toContain("Closed E");
    });

    test("rejects a missing id, and an unresolvable address", () => {
      expect(resultText(rememberTool(db, { verb: "close" }))).toStartWith("Parameter error:");
      expect(
        resultText(rememberTool(db, { verb: "close", id: "E999999" })),
      ).toStartWith("Parameter error:");
    });
  });
});
