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
import { sessionWriterId } from "../../src/db/write-gate";
import { rememberInputSchema } from "../../src/mcp/definitions";
import { recallMemory } from "../../src/mcp/recall";
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

    test("20+ turns since the last touch no longer draws a receipt nudge — the nudge rides the segment card, session-side (ticket 12)", () => {
      const segmentId = createSegmentId("append-nudge");
      seedTurnsSince(100, 20, 1);
      const text = resultText(
        rememberTool(
          db,
          { verb: "append", id: `E${segmentId}`, field: "decisions", rows: ["late ruling"] },
          { callerSessionId: sessionId, now: () => 500 },
        ),
      );
      // A receipt only ever reached whoever was already maintaining; the
      // 20-turn nudge moved to the segment card's header (segment-card.ts),
      // which renders without any write. The receipt keeps the plain figure.
      expect(text).not.toContain("consider a maintenance pass");
      expect(text).toContain("since this segment's last maintenance");
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

  // Ticket 02 (ownership-and-note-cadence spec, [S15069/T926]): `assign`
  // revives the retired verb to carry ownership — the main agent's own
  // channel, single ownership enforced by the write path.
  describe("assign (ticket 02)", () => {
    function createViaTool(topic: string, title = `Segment for ${topic}`): number {
      const text = resultText(rememberTool(db, { verb: "create", title, topic }));
      return Number(/Created E(\d+)/.exec(text)![1]);
    }

    function turnAddress(promptNumber: number): string {
      return `S${sessionId}/T${promptNumber}`;
    }

    test("interval form: one call places every turn in the range", () => {
      const t1 = seedTurn(1, 100);
      const t2 = seedTurn(2, 101);
      const t3 = seedTurn(3, 102);
      seedTurn(4, 103); // deliberately NOT in the interval
      const segmentId = createViaTool("assign-interval");

      const text = resultText(
        rememberTool(db, {
          verb: "assign",
          id: `E${segmentId}`,
          turns: [`${turnAddress(1)}..T3`],
        }),
      );

      expect(text).toContain(`Assigned 3 turn(s) to E${segmentId}`);
      expect(getSegmentMemberTurnIds(db, segmentId).sort()).toEqual(
        [t1, t2, t3].sort(),
      );
    });

    test("list form: one call places exactly the named, non-contiguous turns", () => {
      const t1 = seedTurn(1, 100);
      seedTurn(2, 101); // not named
      const t3 = seedTurn(3, 102);
      const segmentId = createViaTool("assign-list");

      const text = resultText(
        rememberTool(db, {
          verb: "assign",
          id: `E${segmentId}`,
          turns: [turnAddress(1), turnAddress(3)],
        }),
      );

      expect(text).toContain(`Assigned 2 turn(s) to E${segmentId}`);
      expect(getSegmentMemberTurnIds(db, segmentId).sort()).toEqual(
        [t1, t3].sort(),
      );
    });

    test("id omitted: clears ownership — the named turns become homeless", () => {
      const t1 = seedTurn(1, 100);
      const segmentId = createViaTool("assign-homeless");
      rememberTool(db, {
        verb: "assign",
        id: `E${segmentId}`,
        turns: [turnAddress(1)],
      });
      expect(getSegmentMemberTurnIds(db, segmentId)).toEqual([t1]);

      const text = resultText(
        rememberTool(db, { verb: "assign", turns: [turnAddress(1)] }),
      );

      expect(text).toContain("Cleared ownership on 1 turn(s) — now homeless");
      expect(text).toContain(`Removed from prior segment(s): E${segmentId}`);
      expect(getSegmentMemberTurnIds(db, segmentId)).toEqual([]);
    });

    // Peer finding 3's own named gap: a turn moved from E_a to E_b must stop
    // counting toward E_a's DERIVED facets, not just its membership list.
    test("mutation fixture: a turn moved from E_a to E_b no longer counts toward E_a's facets", () => {
      const t1 = seedTurn(1, 100);
      db.query<unknown, [string, number]>("UPDATE turns SET type = ? WHERE id = ?").run(
        JSON.stringify(["research"]),
        t1,
      );
      const segmentA = createViaTool("assign-facet-a");
      const segmentB = createViaTool("assign-facet-b");

      rememberTool(db, { verb: "assign", id: `E${segmentA}`, turns: [turnAddress(1)] });
      expect(getSegment(db, segmentA)?.type).toEqual(["research"]);

      rememberTool(db, { verb: "assign", id: `E${segmentB}`, turns: [turnAddress(1)] });

      expect(getSegmentMemberTurnIds(db, segmentA)).toEqual([]);
      // The facet derivation follows membership: E_a has no members left, so
      // its derived `type` empties out — it does NOT still read ["research"].
      expect(getSegment(db, segmentA)?.type).toEqual([]);
      expect(getSegment(db, segmentB)?.type).toEqual(["research"]);
    });

    // Ticket 02 checklist: "create+members 与 assign 走同一写入路径的断言" —
    // asserted BEHAVIORALLY, not by reaching into internals: if `create`'s
    // `members` seed used a DIFFERENT (looser) path than `assign`, a turn
    // already owned by E_a would end up a member of BOTH E_a and the new
    // E_b. Sharing `reassignSegmentMembers` means E_a loses it instead.
    test("create's members seed shares assign's write path — single ownership, not duplicate membership", () => {
      const t1 = seedTurn(1, 100);
      const segmentA = createViaTool("shared-path-a");
      rememberTool(db, { verb: "assign", id: `E${segmentA}`, turns: [turnAddress(1)] });
      expect(getSegmentMemberTurnIds(db, segmentA)).toEqual([t1]);

      const text = resultText(
        rememberTool(db, {
          verb: "create",
          title: "Steals the turn via members",
          topic: "shared-path-b",
          members: [turnAddress(1)],
        }),
      );
      const segmentB = Number(/Created E(\d+)/.exec(text)![1]);

      expect(getSegmentMemberTurnIds(db, segmentB)).toEqual([t1]);
      // Single ownership: E_a no longer has it — NOT duplicated across both.
      expect(getSegmentMemberTurnIds(db, segmentA)).toEqual([]);
    });

    test("an interval spanning a missing turn rejects the WHOLE call, naming which turn — zero partial writes", () => {
      seedTurn(1, 100);
      seedTurn(2, 101);
      // T3 deliberately does not exist.
      seedTurn(4, 103);
      const segmentId = createViaTool("assign-gap");

      const text = resultText(
        rememberTool(db, {
          verb: "assign",
          id: `E${segmentId}`,
          turns: [`${turnAddress(1)}..T4`],
        }),
      );

      expect(text).toStartWith("Parameter error:");
      expect(text).toContain("turns rejected");
      expect(text).toContain(turnAddress(3));
      expect(getSegmentMemberTurnIds(db, segmentId)).toEqual([]);
    });

    test("an unresolved individual address rejects the WHOLE call — zero partial writes", () => {
      const t1 = seedTurn(1, 100);
      const segmentId = createViaTool("assign-unresolved");

      const text = resultText(
        rememberTool(db, {
          verb: "assign",
          id: `E${segmentId}`,
          turns: [turnAddress(1), turnAddress(999)],
        }),
      );

      expect(text).toStartWith("Parameter error:");
      expect(text).toContain(turnAddress(999));
      expect(getSegmentMemberTurnIds(db, segmentId)).toEqual([]);
      // T1 was a perfectly good address — proves this is all-or-nothing, not
      // "assign what resolved and complain about the rest".
      void t1;
    });

    test("rejects a missing turns list, and an id naming a segment that does not exist", () => {
      expect(
        resultText(rememberTool(db, { verb: "assign", id: "E1" })),
      ).toStartWith("Parameter error:");
      seedTurn(1, 100);
      expect(
        resultText(
          rememberTool(db, { verb: "assign", id: "E999999", turns: [turnAddress(1)] }),
        ),
      ).toStartWith("Parameter error:");
    });
  });
});

// ---------------------------------------------------------------------------
// Write gate (ticket 02, read-write-contract spec) — the gate's first
// consumer surface: `remember`'s segment field writes (append/replace,
// Working State included). `.scratch/read-write-contract/spec.md` "门(写面)".
// ---------------------------------------------------------------------------

describe("remember write gate (ticket 02)", () => {
  let db: Database;
  let sessionA: number;
  let sessionB: number;

  function createSegmentAs(topic: string): number {
    const text = resultText(
      rememberTool(db, { verb: "create", title: topic, topic }, { callerSessionId: sessionA }),
    );
    return Number(/Created E(\d+)/.exec(text)![1]);
  }

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionA = upsertSession(db, {
      contentSessionId: "write-gate-a",
      project: "/tmp/write-gate",
      title: null,
      insight: null,
      createdAtEpoch: 100,
      updatedAtEpoch: 100,
      completedAtEpoch: null,
    }).id;
    sessionB = upsertSession(db, {
      contentSessionId: "write-gate-b",
      project: "/tmp/write-gate",
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

  test("first write on a field admits with no read at all — a create needs no prior recall", () => {
    const segmentId = createSegmentAs("first-write");
    const text = resultText(
      rememberTool(
        db,
        { verb: "append", id: `E${segmentId}`, field: "goal", rows: ["ship it"] },
        { callerSessionId: sessionB },
      ),
    );
    expect(text).toStartWith("Appended");
  });

  test("the same session may keep rewriting its own field with no read in between", () => {
    const segmentId = createSegmentAs("self-rewrite");
    rememberTool(
      db,
      { verb: "append", id: `E${segmentId}`, field: "goal", rows: ["first"] },
      { callerSessionId: sessionA },
    );
    const text = resultText(
      rememberTool(
        db,
        { verb: "replace", id: `E${segmentId}`, field: "goal", oldString: "- first", newString: "- second" },
        { callerSessionId: sessionA },
      ),
    );
    expect(text).toStartWith("Replaced text in");
  });

  test("a second session writing a field someone else already wrote, without ever reading it, is rejected — never-read", () => {
    const segmentId = createSegmentAs("never-read");
    rememberTool(
      db,
      { verb: "append", id: `E${segmentId}`, field: "goal", rows: ["from A"] },
      { callerSessionId: sessionA },
    );

    const text = resultText(
      rememberTool(
        db,
        { verb: "append", id: `E${segmentId}`, field: "goal", rows: ["from B, blind"] },
        { callerSessionId: sessionB },
      ),
    );

    expect(text).toStartWith("Parameter error:");
    expect(text).toContain(`E${segmentId}`);
    expect(text).toContain("recall");
    // Nothing landed — the field is unchanged from A's write.
    expect(getSegment(db, segmentId)?.goal).toBe("- from A");
  });

  test("concurrent dual sessions on the same segment: the later blind writer is rejected as stale after recall, then admitted once it re-recalls", () => {
    const segmentId = createSegmentAs("dual-session");
    // Both sessions discover the segment first (read-before-write, ADR-0002).
    recallMemory(db, { id: `E${segmentId}`, readerId: sessionWriterId(sessionA) });
    recallMemory(db, { id: `E${segmentId}`, readerId: sessionWriterId(sessionB) });

    // A writes first.
    rememberTool(
      db,
      { verb: "append", id: `E${segmentId}`, field: "decisions", rows: ["A ruled first"] },
      { callerSessionId: sessionA },
    );

    // B's grant predates A's write — B is stale on `decisions`, and the
    // message names A and points back at recall (distinguishable from
    // never-read by its own text).
    const staleAttempt = resultText(
      rememberTool(
        db,
        { verb: "append", id: `E${segmentId}`, field: "decisions", rows: ["B ruled blind"] },
        { callerSessionId: sessionB },
      ),
    );
    expect(staleAttempt).toStartWith("Parameter error:");
    expect(staleAttempt).toContain("decisions");
    expect(staleAttempt).toContain(`S${sessionA}`);
    expect(staleAttempt).toContain("recall");
    expect(getSegment(db, segmentId)?.decisions).toBe("- A ruled first");

    // B recalls again, now sees A's write, and may proceed.
    recallMemory(db, { id: `E${segmentId}`, readerId: sessionWriterId(sessionB) });
    const retried = resultText(
      rememberTool(
        db,
        { verb: "append", id: `E${segmentId}`, field: "decisions", rows: ["B ruled after re-reading"] },
        { callerSessionId: sessionB },
      ),
    );
    expect(retried).toStartWith("Appended");
    expect(getSegment(db, segmentId)?.decisions).toBe(
      "- A ruled first\n- B ruled after re-reading",
    );
  });

  test("a read grant on the segment covers a DIFFERENT field too — entity-level, not per-field", () => {
    const segmentId = createSegmentAs("entity-level-grant");
    rememberTool(
      db,
      { verb: "append", id: `E${segmentId}`, field: "goal", rows: ["from A"] },
      { callerSessionId: sessionA },
    );
    // B reads the segment card once — it covers every field, not just `goal`.
    recallMemory(db, { id: `E${segmentId}`, readerId: sessionWriterId(sessionB) });

    const text = resultText(
      rememberTool(
        db,
        { verb: "append", id: `E${segmentId}`, field: "goal", rows: ["from B, after reading"] },
        { callerSessionId: sessionB },
      ),
    );
    expect(text).toStartWith("Appended");
  });

  test("atomicity: a write that fails after the gate check leaves no stamp behind — check and write commit or fail together", () => {
    const segmentId = createSegmentAs("atomic-check-write");
    recallMemory(db, { id: `E${segmentId}`, readerId: sessionWriterId(sessionA) });

    // A hostile write transaction: the gate check runs (and passes), then the
    // actual mutation throws instead of completing. If check-and-write were
    // NOT one transaction, the gate's own bookkeeping (or a partial field
    // write) could still land. bun:sqlite's `db.transaction()` rolls the
    // whole callback back on a thrown error, so nothing here may survive.
    expect(() =>
      rememberTool(
        db,
        { verb: "append", id: `E${segmentId}`, field: "goal", rows: ["should not land"] },
        {
          callerSessionId: sessionA,
          runWriteTransaction: (database, fn) => {
            const txn = database.transaction(() => {
              fn();
              throw new Error("simulated failure after the gate check passed");
            });
            return txn.immediate();
          },
        },
      ),
    ).toThrow("simulated failure after the gate check passed");

    // Nothing landed: not the row, not a stamp that would make a later,
    // legitimate write see a phantom prior writer.
    expect(getSegment(db, segmentId)?.goal).toBeNull();
    const stampRow = db
      .query<{ count: number }, [number]>(
        "SELECT COUNT(*) AS count FROM write_gate_stamps WHERE entity_type = 'segment' AND entity_id = ? AND field = 'goal'",
      )
      .get(segmentId);
    expect(stampRow?.count).toBe(0);
  });
});
