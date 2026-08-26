import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { getLane } from "../../src/db/lanes";
import { deriveSideTags, getOutgoingEdges, writeMemoryEdges } from "../../src/db/memory-edges";
import { initializeSchema } from "../../src/db/schema";
import {
  getAttachedSegmentIds,
  getSegment,
  getSegmentMemberTurnIds,
} from "../../src/db/segments";
import { getSession, upsertSession, countTurnsAfterTurnId } from "../../src/db/sessions";
import { updateTurnById } from "../../src/db/turns";
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
        rememberInputSchema.parse({ verb: "create", title: "x" }),
      ).not.toThrow();
      expect(() => rememberInputSchema.parse({ verb: "bogus" })).toThrow();
      expect(() =>
        rememberInputSchema.parse({ verb: "create", title: "x", bogusField: 1 }),
      ).toThrow();
    });

    // Ticket 15 (topic registry retirement): a caller still sending `topic`
    // is rejected, not silently ignored — see definitions.test.ts for the
    // message-content assertion.
    test("rejects a supplied topic", () => {
      expect(() =>
        rememberInputSchema.parse({ verb: "create", title: "x", topic: "y" }),
      ).toThrow();
    });

    // Container-unification ticket 06 (spec D4): `undeclare` retired into
    // `delete`'s own id-tier routing — the word no longer parses at all, the
    // same treatment `declare` already got.
    test("rejects the retired undeclare verb at the schema layer", () => {
      expect(() =>
        rememberInputSchema.parse({ verb: "undeclare", id: "E1", tag: "write-gate" }),
      ).toThrow();
    });

    // `delete`'s own id-tier routing: a task address alone, or a lane address
    // alone — neither tier needs `tag`.
    test("accepts delete with a task address or a lane address as id, no tag", () => {
      expect(() =>
        rememberInputSchema.parse({ verb: "delete", id: "E1" }),
      ).not.toThrow();
      expect(() =>
        rememberInputSchema.parse({ verb: "delete", id: "E1/#write-gate" }),
      ).not.toThrow();
    });

    // Container-unification ticket 05 (spec D3): `declare` retired into
    // `create`'s own id-tier routing — the word no longer parses at all, the
    // same treatment `append`/`replace`/`assign` already got.
    test("rejects the retired declare verb at the schema layer", () => {
      expect(() =>
        rememberInputSchema.parse({ verb: "declare", id: "E1", tag: "write-gate" }),
      ).toThrow();
    });

    // `create`'s lane tier: a lane address parses as `id` alone, no `tag`.
    test("accepts create with a lane address as id, no title required", () => {
      expect(() =>
        rememberInputSchema.parse({ verb: "create", id: "E1/#write-gate" }),
      ).not.toThrow();
    });

    // Container-unification ticket 07 (spec D5/D8): `clear`'s own id-tier
    // routing, plus the optional `force` switch.
    test("accepts clear with a task address or a lane address as id, plus optional force", () => {
      expect(() =>
        rememberInputSchema.parse({ verb: "clear", id: "E1" }),
      ).not.toThrow();
      expect(() =>
        rememberInputSchema.parse({ verb: "clear", id: "E1/#write-gate" }),
      ).not.toThrow();
      expect(() =>
        rememberInputSchema.parse({ verb: "clear", id: "E1/#write-gate", force: true }),
      ).not.toThrow();
      expect(() =>
        rememberInputSchema.parse({ verb: "clear", id: "E1/#write-gate", force: "yes" }),
      ).toThrow();
    });
  });

  // ---------------------------------------------------------------------
  // create
  // ---------------------------------------------------------------------

  describe("create", () => {
    test("mints a segment with no topic parameter and reports zero members", () => {
      const result = rememberTool(db, {
        verb: "create",
        title: "Ship the semantic container",
      });
      const text = resultText(result);
      expect(text).toContain('Created E');
      expect(text).toContain("0 members seeded.");

      const match = /Created E(\d+)/.exec(text);
      const segmentId = Number(match![1]);
      const segment = getSegment(db, segmentId);
      expect(segment?.title).toBe("Ship the semantic container");
      expect(segment?.status).toBe("open");
    });

    test("seeds a goal row when goal is given", () => {
      const text = resultText(
        rememberTool(db, {
          verb: "create",
          title: "With a goal",
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
          members: [`S${sessionId}/T1`, `S${sessionId}/T999`, "not-an-address"],
        }),
      );
      expect(text).toStartWith("Parameter error:");
      expect(text).toContain("members rejected");
      expect(text).toContain(`S${sessionId}/T999`);
      expect(text).toContain("not-an-address");

      const after = db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM segments").get()!.count;
      expect(after).toBe(before);
    });

    test("rejects a missing title, and tool-call markup", () => {
      expect(resultText(rememberTool(db, { verb: "create" }))).toStartWith(
        "Parameter error:",
      );
      expect(
        resultText(
          rememberTool(db, {
            verb: "create",
            title: 'bad <parameter name="x">',
          }),
        ),
      ).toContain("tool-call syntax");
    });

    // Ticket 14 (lane-model-v12 spec D3e): ONE tag, globally unique, and it
    // is the segment's NAME — the plural `tags` parameter retired with the
    // curated-set model.
    describe("tag (ticket 14)", () => {
      test("create stores the one tag and echoes what carrying it means", () => {
        const text = resultText(
          rememberTool(db, {
            verb: "create",
            title: "Named from the start",
            tag: " fencing ",
          }),
        );
        expect(text).toContain("tag: fencing.");
        const segmentId = Number(/Created E(\d+)/.exec(text)![1]);
        expect(getSegment(db, segmentId)?.tags).toEqual(["fencing"]);
      });

      test("omitting the tag leaves the segment unnamed — the receipt says so, and nothing derives into it", () => {
        const text = resultText(
          rememberTool(db, { verb: "create", title: "No name" }),
        );
        expect(text).toContain("unnamed");
        const segmentId = Number(/Created E(\d+)/.exec(text)![1]);
        expect(getSegment(db, segmentId)?.tags).toEqual([]);
      });

      test("a non-canonical or namespace-prefixed tag is refused at create", () => {
        expect(
          resultText(rememberTool(db, { verb: "create", title: "x", tag: "Mixed-Case" })),
        ).toContain("not lowercase");
        expect(
          resultText(rememberTool(db, { verb: "create", title: "x", tag: "compact:x" })),
        ).toContain("namespace prefix");
      });

      test("the retired plural `tags` parameter is refused at the schema layer, naming its replacement", () => {
        const parsed = rememberInputSchema.safeParse({
          verb: "create",
          title: "x",
          tags: ["a"],
        });
        expect(parsed.success).toBe(false);
        expect(JSON.stringify(parsed)).toContain("ONE globally unique tag");
      });
    });
  });

  // ---------------------------------------------------------------------
  // retag (ticket 07, rubric-v10)
  // ---------------------------------------------------------------------

  describe("retag — one globally unique tag (ticket 14)", () => {
    function createViaTool(title: string, tag?: string): number {
      const text = resultText(rememberTool(db, { verb: "create", title, tag }));
      return Number(/Created E(\d+)/.exec(text)![1]);
    }

    test("names the segment; the receipt says carrying the tag is what joins it", () => {
      const segmentId = createViaTool("retag me", "old");
      const text = resultText(
        rememberTool(db, { verb: "retag", id: `E${segmentId}`, tag: " new " }),
      );
      expect(text).toContain(`E${segmentId} is now "new".`);
      expect(getSegment(db, segmentId)?.tags).toEqual(["new"]);
    });

    test("null clears the name — an observable act, and nothing derives into it after", () => {
      const segmentId = createViaTool("retag clear", "old");
      const text = resultText(
        rememberTool(db, { verb: "retag", id: `E${segmentId}`, tag: null }),
      );
      expect(text).toContain("Cleared");
      expect(getSegment(db, segmentId)?.tags).toEqual([]);
    });

    test("refuses a tag another segment already holds, naming that segment", () => {
      const held = createViaTool("holder", "contested");
      const other = createViaTool("other");
      const text = resultText(
        rememberTool(db, { verb: "retag", id: `E${other}`, tag: "contested" }),
      );
      expect(text).toStartWith("Parameter error:");
      expect(text).toContain(`E${held}`);
      expect(text).toContain("globally unique");
      expect(getSegment(db, other)?.tags).toEqual([]);
    });

    test("refuses a non-canonical or namespace-prefixed tag, naming the exact problem", () => {
      const segmentId = createViaTool("retag canonical");
      expect(
        resultText(rememberTool(db, { verb: "retag", id: `E${segmentId}`, tag: "Write-Gate" })),
      ).toContain("not lowercase");
      expect(
        resultText(rememberTool(db, { verb: "retag", id: `E${segmentId}`, tag: "delivery:x" })),
      ).toContain("namespace prefix");
      expect(getSegment(db, segmentId)?.tags).toEqual([]);
    });

    test("rejects on a closed segment, naming close as the way back", () => {
      const segmentId = createViaTool("retag closed");
      rememberTool(db, { verb: "close", id: `E${segmentId}` });
      const text = resultText(
        rememberTool(db, { verb: "retag", id: `E${segmentId}`, tag: "x" }),
      );
      expect(text).toStartWith("Parameter error:");
      expect(text).toContain("closed");
      expect(text).toContain(`remember(close, id="E${segmentId}")`);
    });

    test("rejects a missing id, and a non-string tag", () => {
      const segmentId = createViaTool("retag bad input");
      expect(resultText(rememberTool(db, { verb: "retag", tag: "x" }))).toStartWith(
        "Parameter error:",
      );
      expect(
        resultText(rememberTool(db, { verb: "retag", id: `E${segmentId}`, tag: ["x"] })),
      ).toStartWith("Parameter error:");
    });

    test("rejects an id naming a segment that does not exist", () => {
      expect(
        resultText(rememberTool(db, { verb: "retag", id: "E999999", tag: "x" })),
      ).toStartWith("Parameter error:");
    });

    // Ticket 09: retag is a field-writing verb — it resets the 20-turn cadence.
    test("a successful retag touches the last-remember-turn stamp, unlike a rejected call", () => {
      const segmentId = createViaTool("retag cadence");
      expect(getSession(db, sessionId)?.lastRememberTurnId).toBeNull();

      // A rejected call (a non-string tag) must NOT touch the stamp.
      rememberTool(
        db,
        { verb: "retag", id: `E${segmentId}`, tag: 7 },
        { callerSessionId: sessionId },
      );
      expect(getSession(db, sessionId)?.lastRememberTurnId).toBeNull();

      rememberTool(
        db,
        { verb: "retag", id: `E${segmentId}`, tag: "x" },
        { callerSessionId: sessionId },
      );
      expect(getSession(db, sessionId)?.lastRememberTurnId).not.toBeNull();
    });

    // Ticket 01 (lane-declaration spec D1 "two vocabularies, one enforceable
    // invariant"): the mirror of declare's own segment-tag refusal.
    test("refuses a tag already declared as one of the segment's lanes, naming it", () => {
      const segmentId = createViaTool("retag vs lane");
      rememberTool(db, { verb: "create", id: `E${segmentId}/#write-gate` });

      const text = resultText(
        rememberTool(db, { verb: "retag", id: `E${segmentId}`, tag: "write-gate" }),
      );
      expect(text).toStartWith("Parameter error:");
      expect(text).toContain('"write-gate"');
      expect(text).toContain(`already a lane declared on E${segmentId}`);
      expect(getSegment(db, segmentId)?.tags).toEqual([]);
    });

    /**
     * THE COLLISION THAT ACTUALLY BREAKS D3e, and the one the pre-v12 check
     * could not see: the lane sits on a DIFFERENT segment. Naming this segment
     * "write-gate" would put that word on both a member of E<other>'s lane and
     * on every turn deriving into this segment — one word, two meanings, read
     * out of one column.
     */
    test("refuses a tag ANOTHER segment already declares as a lane, naming that segment", () => {
      const owner = createViaTool("retag vs another segment's lane");
      const other = createViaTool("the lane's home");
      rememberTool(db, { verb: "create", id: `E${other}/#write-gate` });

      const text = resultText(
        rememberTool(db, { verb: "retag", id: `E${owner}`, tag: "write-gate" }),
      );
      expect(text).toStartWith("Parameter error:");
      expect(text).toContain(`already a lane declared on E${other}`);
      expect(getSegment(db, owner)?.tags).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------
  // retag — lane tier (container-unification ticket 04, spec D3)
  // ---------------------------------------------------------------------

  describe("retag — lane tier (ticket 04)", () => {
    function createViaTool(title: string, tag?: string): number {
      const text = resultText(rememberTool(db, { verb: "create", title, tag }));
      return Number(/Created E(\d+)/.exec(text)![1]);
    }
    function declareLane(segmentId: number, tag: string) {
      return rememberTool(db, { verb: "create", id: `E${segmentId}/#${tag}` });
    }
    function seedSegmentTag(segmentId: number, tag: string) {
      rememberTool(db, { verb: "retag", id: `E${segmentId}`, tag });
    }
    // A member carries BOTH the segment's own tag and the lane's — the write
    // gate's real shape (a lane tag only counts on a turn that also carries
    // its segment's tag) — mirroring the fixture the merge tests below use,
    // rather than a bare lane tag no real turn could hold.
    function seedLaneMembers(
      segmentId: number,
      segmentTag: string,
      laneTags: readonly string[],
    ): number[] {
      const ids = laneTags.map((tag, index) =>
        db
          .query<{ id: number }, [number, number, string, number]>(
            `INSERT INTO turns (session_id, prompt_number, status, tags, created_at_epoch)
             VALUES (?, ?, 'active', ?, ?) RETURNING id`,
          )
          .get(sessionId, index + 1, JSON.stringify([segmentTag, tag]), 100)!.id,
      );
      for (const id of ids) {
        db.query<unknown, [number, number]>(
          `INSERT INTO segment_members (segment_id, turn_id, created_at_epoch) VALUES (?, ?, 100)`,
        ).run(segmentId, id);
      }
      return ids;
    }

    // Peer round three finding 06: `renameLane` reaches `insertLane`, which
    // THROWS on a cross-namespace collision, and nothing between here and the
    // tool boundary converted it — so a caller aiming a lane at a word some
    // task already owns got a failed MCP call instead of a refusal naming the
    // holder. `create` had this pre-check; retag did not.
    test("refuses a destination word a TASK already owns, as a message rather than a throw", () => {
      const host = createViaTool("retag collision host");
      seedSegmentTag(host, "retag-collision-host");
      declareLane(host, "old-name");
      const rival = createViaTool("the task holding the word");
      seedSegmentTag(rival, "reserved-word");

      const result = rememberTool(db, {
        verb: "retag",
        id: `E${host}/#old-name`,
        tag: "reserved-word",
      });

      const text = resultText(result);
      expect(text).toContain("reserved-word");
      expect(text).toContain(`E${rival}`);
      // Still declared under its own name — a refusal writes nothing.
      expect(resultText(rememberTool(db, { verb: "retag", id: `E${host}/#old-name`, tag: "fresh-name" })))
        .not.toContain("no declared lane");
    });

    test("renames the lane: members retagged, edge sides rewritten, registry row moved", () => {
      const segmentId = createViaTool("retag lane host");
      seedSegmentTag(segmentId, "retag-lane-seg");
      declareLane(segmentId, "old-name");
      const [t1, t2] = seedLaneMembers(segmentId, "retag-lane-seg", ["old-name", "old-name"]);
      writeMemoryEdges(
        db,
        [
          {
            citing: { kind: "turn", id: t2 },
            cited: { kind: "turn", id: t1 },
            relation: "extends",
            provenance: "asserted",
            ...deriveSideTags(["old-name"]),
          },
        ],
        100,
      );

      const text = resultText(
        rememberTool(db, { verb: "retag", id: `E${segmentId}/#old-name`, tag: "new-name" }),
      );
      expect(text).toContain(`Retagged E${segmentId}'s lane "old-name" to "new-name"`);
      expect(text).toContain("member turns retagged: 2");
      expect(text).toContain("edge sides rewritten: 2");

      expect(getLane(db, segmentId, "old-name")).toBeNull();
      expect(getLane(db, segmentId, "new-name")).not.toBeNull();
      for (const id of [t1, t2]) {
        const tags = db
          .query<{ tags: string }, [number]>("SELECT tags FROM turns WHERE id = ?")
          .get(id)!.tags;
        expect(JSON.parse(tags)).toEqual(["retag-lane-seg", "new-name"]);
      }
      const sides = db
        .query<{ tailTag: string; headTag: string }, []>(
          "SELECT tail_tag AS tailTag, head_tag AS headTag FROM memory_edges",
        )
        .all();
      expect(sides).toEqual([{ tailTag: "new-name", headTag: "new-name" }]);
    });

    test("refuses when the destination name is already declared in this segment, naming it", () => {
      const segmentId = createViaTool("retag lane collision");
      declareLane(segmentId, "old-name");
      declareLane(segmentId, "taken");

      const text = resultText(
        rememberTool(db, { verb: "retag", id: `E${segmentId}/#old-name`, tag: "taken" }),
      );
      expect(text).toStartWith("Parameter error:");
      expect(text).toContain('already declares lane "taken"');
      // Nothing moved: both rows still stand, unrelated to each other.
      expect(getLane(db, segmentId, "old-name")).not.toBeNull();
      expect(getLane(db, segmentId, "taken")).not.toBeNull();
    });

    test("refuses when the source lane is not declared", () => {
      const segmentId = createViaTool("retag lane missing source");
      const text = resultText(
        rememberTool(db, { verb: "retag", id: `E${segmentId}/#never-declared`, tag: "new-name" }),
      );
      expect(text).toStartWith("Parameter error:");
      expect(text).toContain('no declared lane "never-declared"');
    });

    test("refuses the same name as a no-op, pointing at merge for an actual fold", () => {
      const segmentId = createViaTool("retag lane same name");
      declareLane(segmentId, "steady");
      const text = resultText(
        rememberTool(db, { verb: "retag", id: `E${segmentId}/#steady`, tag: "steady" }),
      );
      expect(text).toStartWith("Parameter error:");
      expect(text).toContain("already this lane's name");
      expect(getLane(db, segmentId, "steady")).not.toBeNull();
    });

    test("refuses a missing or non-canonical destination tag", () => {
      const segmentId = createViaTool("retag lane bad dest");
      declareLane(segmentId, "old-name");
      expect(
        resultText(rememberTool(db, { verb: "retag", id: `E${segmentId}/#old-name` })),
      ).toContain("tag is required");
      expect(
        resultText(
          rememberTool(db, { verb: "retag", id: `E${segmentId}/#old-name`, tag: "Bad-Case" }),
        ),
      ).toContain("not lowercase");
      expect(getLane(db, segmentId, "old-name")).not.toBeNull();
    });

    test("refuses on a closed segment", () => {
      const segmentId = createViaTool("retag lane closed");
      declareLane(segmentId, "old-name");
      rememberTool(db, { verb: "close", id: `E${segmentId}` });
      const text = resultText(
        rememberTool(db, { verb: "retag", id: `E${segmentId}/#old-name`, tag: "new-name" }),
      );
      expect(text).toStartWith("Parameter error:");
      expect(text).toContain("closed");
    });

    test("refuses a non-existent segment", () => {
      const text = resultText(
        rememberTool(db, { verb: "retag", id: "E999999/#old-name", tag: "new-name" }),
      );
      expect(text).toStartWith("Parameter error:");
    });
  });

  // ---------------------------------------------------------------------
  // create (lane tier) / delete / merge (ticket 01/lane-declaration spec
  // D1/D4; `declare` retired into `create`'s own id-tier routing by
  // container-unification ticket 05, spec D3; `undeclare` retired into
  // `delete`'s own id-tier routing by ticket 06, spec D4)
  // ---------------------------------------------------------------------

  describe("create (lane tier) / delete (ticket 01/06)", () => {
    function createViaTool(title: string, tag?: string): number {
      const text = resultText(rememberTool(db, { verb: "create", title, tag }));
      return Number(/Created E(\d+)/.exec(text)![1]);
    }

    /** `create`'s lane tier: `id="E<n>/#<tag>"`, no separate `tag` param. */
    function declareLane(segmentId: number, tag: string) {
      return rememberTool(db, { verb: "create", id: `E${segmentId}/#${tag}` });
    }

    describe("create — lane tier (ticket 05)", () => {
      test("mints a lane and reports its identity", () => {
        const segmentId = createViaTool("declare me");
        const text = resultText(declareLane(segmentId, "write-gate"));
        expect(text).toContain(`Created lane "write-gate" on E${segmentId}`);
        const lane = getLane(db, segmentId, "write-gate");
        expect(lane).not.toBeNull();
        expect(lane?.segmentId).toBe(segmentId);
      });

      test("refuses a duplicate declaration, naming the existing lane", () => {
        const segmentId = createViaTool("declare dup");
        declareLane(segmentId, "write-gate");
        const text = resultText(declareLane(segmentId, "write-gate"));
        expect(text).toStartWith("Parameter error:");
        expect(text).toContain("already declares lane");
        expect(text).toContain('"write-gate"');
        // Still exactly one lane row.
        const count = db
          .query<{ count: number }, [number, string]>(
            "SELECT COUNT(*) AS count FROM lanes WHERE segment_id = ? AND tag = ?",
          )
          .get(segmentId, "write-gate")!.count;
        expect(count).toBe(1);
      });

      test("refuses a tag that is already the segment's own tag", () => {
        const segmentId = createViaTool("declare same-word", "write-gate");
        const text = resultText(declareLane(segmentId, "write-gate"));
        expect(text).toStartWith("Parameter error:");
        expect(text).toContain("own segment tag");
        expect(getLane(db, segmentId, "write-gate")).toBeNull();
      });

      /**
       * ANOTHER segment's tag (lane-model-v12 D3e, peer A2) — the collision
       * that actually breaks membership derivation, and the one this facade
       * used to wave through because it asked only about the declaring
       * segment's own tags. The refusal here is a MESSAGE; the invariant is
       * `insertLane`'s (tests/db/tag-namespace.test.ts), which is what a
       * migration or a direct caller answers to.
       */
      test("refuses a tag that is ANOTHER segment's tag, naming that segment", () => {
        const holder = createViaTool("declare holder", "contested");
        const segmentId = createViaTool("declare vs another segment");
        const text = resultText(declareLane(segmentId, "contested"));
        expect(text).toStartWith("Parameter error:");
        expect(text).toContain(`already E${holder}'s segment tag`);
        expect(getLane(db, segmentId, "contested")).toBeNull();
      });

      // Ticket 14 (spec D3b): the number that makes "this name is too generic"
      // visible at the moment of declaration.
      test("reports how many existing turns already carry the word, and therefore become members", () => {
        const segmentId = createViaTool("declare conscription", "container");
        const t1 = seedTurn(1, 100);
        const t2 = seedTurn(2, 101);
        const t3 = seedTurn(3, 102);
        // Two of the three already use the word; one of those also belongs here.
        updateTurnById(db, t1, { tags: ["container", "legacy-word"], updatedAtEpoch: 110 });
        updateTurnById(db, t2, { tags: ["legacy-word"], updatedAtEpoch: 110 });
        void t3;

        const text = resultText(declareLane(segmentId, "legacy-word"));
        expect(text).toContain("2 existing turn(s) already carry");
        expect(text).toContain(`1 of them in E${segmentId}`);
        expect(text).toContain("too generic");
      });

      test("a word nothing carries says so plainly, rather than printing a zero", () => {
        const segmentId = createViaTool("declare fresh word");
        const text = resultText(declareLane(segmentId, "brand-new"));
        expect(text).toContain("No existing turn carries that word.");
      });

      test("refuses a namespace-prefixed tag — that namespace is the hooks'", () => {
        const segmentId = createViaTool("declare prefixed");
        const text = resultText(declareLane(segmentId, "compact:boundary"));
        expect(text).toStartWith("Parameter error:");
        expect(text).toContain("namespace prefix");
        expect(getLane(db, segmentId, "compact:boundary")).toBeNull();
      });

      test("refuses on a closed segment, naming close as the way back", () => {
        const segmentId = createViaTool("declare closed");
        rememberTool(db, { verb: "close", id: `E${segmentId}` });
        const text = resultText(declareLane(segmentId, "write-gate"));
        expect(text).toStartWith("Parameter error:");
        expect(text).toContain("closed");
        expect(text).toContain(`remember(close, id="E${segmentId}")`);
      });

      test("refuses a non-existent segment", () => {
        const text = resultText(declareLane(999999, "write-gate"));
        expect(text).toStartWith("Parameter error:");
      });

      // `create`'s lane tier has no separate `tag` parameter — the address IS
      // the whole target — so the old declare-era "missing tag" case becomes
      // "a bare segment id is not a lane address" instead.
      test('refuses a bare segment id — a lane address needs "#tag"', () => {
        const segmentId = createViaTool("declare bad input");
        const text = resultText(rememberTool(db, { verb: "create", id: `E${segmentId}` }));
        expect(text).toStartWith("Parameter error:");
        expect(text).toContain("lane address");
      });

      // Ticket 01 (spec D1 peer P2-10): declare REFUSES a non-canonical tag
      // rather than silently canonicalizing it — one case per violation kind.
      describe("canonical form", () => {
        test("rejects interior whitespace", () => {
          const segmentId = createViaTool("declare ws");
          const text = resultText(declareLane(segmentId, "write gate"));
          expect(text).toStartWith("Parameter error:");
          expect(text).toContain("interior whitespace");
        });

        test("rejects mixed case", () => {
          const segmentId = createViaTool("declare case");
          const text = resultText(declareLane(segmentId, "Write-Gate"));
          expect(text).toStartWith("Parameter error:");
          expect(text).toContain("not lowercase");
        });

        // Only the WHOLE `id` string's outer edges are trimmed before the
        // address is parsed (`parseLaneCreateAddress`'s own `raw.trim()`) —
        // a space sitting right after "#" is interior to that string, so it
        // survives into the captured tag and hits the SAME "not-trimmed"
        // check the old `declare`'s bare `tag: " write-gate "` parameter used
        // to.
        test("rejects a tag with leading/trailing whitespace baked into the address", () => {
          const segmentId = createViaTool("declare trim");
          const text = resultText(declareLane(segmentId, " write-gate "));
          expect(text).toStartWith("Parameter error:");
          expect(text).toContain("leading or trailing whitespace");
        });

        test("rejects an empty tag", () => {
          const segmentId = createViaTool("declare empty");
          const text = resultText(rememberTool(db, { verb: "create", id: `E${segmentId}/#` }));
          expect(text).toStartWith("Parameter error:");
        });

        test("rejects an NFD form whose NFC form would be canonical", () => {
          const segmentId = createViaTool("declare nfc");
          // "é" as e + combining acute accent (NFD) — decomposed, not the
          // single precomposed codepoint NFC form uses.
          const nfd = "café";
          expect(nfd.normalize("NFC")).not.toBe(nfd);
          const text = resultText(declareLane(segmentId, nfd));
          expect(text).toStartWith("Parameter error:");
          expect(text).toContain("not NFC-normalized");
        });
      });
    });

    // merge ([S15069/T1697]): the hand-operated door onto `mergeLaneTag`.
    // `undeclare` cannot retire a lane that was ever used — its members hold
    // it open, and clearing their tags by hand would leave every edge naming a
    // word its own endpoints no longer carry. These tests pin that merge moves
    // all three populations, and that it refuses rather than half-moving them.
    describe("merge", () => {
      // A member turn carries its SEGMENT's tag beside the lane tag — that is
      // what membership is. Seeding only the lane tag would make the merge's
      // own `deriveTurnSegmentMembership` (correctly) evict the turn from the
      // segment halfway through, and the edge-side rewrite, which resolves a
      // side's lane through its endpoint's owning segment, would then find no
      // owner. The fixture mirrors production instead of working around it.
      function seedSegmentTag(segmentId: number, tag: string) {
        rememberTool(db, { verb: "retag", id: `E${segmentId}`, tag });
      }
      function seedLaneMembers(
        segmentId: number,
        segmentTag: string,
        laneTags: readonly string[],
      ) {
        const ids = laneTags.map((tag, index) =>
          db
            .query<{ id: number }, [number, number, string, number]>(
              `INSERT INTO turns (session_id, prompt_number, status, tags, created_at_epoch)
               VALUES (?, ?, 'active', ?, ?) RETURNING id`,
            )
            .get(sessionId, index + 1, JSON.stringify([segmentTag, tag]), 100)!.id,
        );
        for (const id of ids) {
          db.query<unknown, [number, number]>(
            `INSERT INTO segment_members (segment_id, turn_id, created_at_epoch) VALUES (?, ?, 100)`,
          ).run(segmentId, id);
        }
        return ids;
      }

      test("folds the lane away: members retagged, edge sides rewritten, registry row gone", () => {
        const segmentId = createViaTool("merge me");
        seedSegmentTag(segmentId, "merge-me-seg");
        declareLane(segmentId, "child-lane");
        declareLane(segmentId, "parent-lane");
        const [t1, t2] = seedLaneMembers(segmentId, "merge-me-seg", ["child-lane", "child-lane"]);
        writeMemoryEdges(
          db,
          [
            {
              citing: { kind: "turn", id: t2 },
              cited: { kind: "turn", id: t1 },
              relation: "extends",
              provenance: "asserted",
              ...deriveSideTags(["child-lane"]),
            },
          ],
          100,
        );

        const text = resultText(
          rememberTool(db, {
            verb: "merge",
            id: `E${segmentId}`,
            tag: "child-lane",
            into: "parent-lane",
          }),
        );
        expect(text).toContain(`Merged E${segmentId}'s lane "child-lane" into "parent-lane"`);
        expect(text).toContain("member turns retagged: 2");
        expect(text).toContain("edge sides rewritten: 2");

        // All three populations moved, and none was left describing the lane
        // that no longer exists — the state a manual tag-strip would produce.
        expect(getLane(db, segmentId, "child-lane")).toBeNull();
        expect(getLane(db, segmentId, "parent-lane")).not.toBeNull();
        for (const id of [t1, t2]) {
          const tags = db
            .query<{ tags: string }, [number]>("SELECT tags FROM turns WHERE id = ?")
            .get(id)!.tags;
          expect(JSON.parse(tags)).toEqual(["merge-me-seg", "parent-lane"]);
        }
        const sides = db
          .query<{ tailTag: string; headTag: string }, []>(
            "SELECT tail_tag AS tailTag, head_tag AS headTag FROM memory_edges",
          )
          .all();
        expect(sides).toEqual([{ tailTag: "parent-lane", headTag: "parent-lane" }]);
      });

      test("a member already carrying the survivor keeps ONE copy, and says so", () => {
        const segmentId = createViaTool("merge dedupe");
        seedSegmentTag(segmentId, "merge-dedupe-seg");
        declareLane(segmentId, "child-lane");
        declareLane(segmentId, "parent-lane");
        const t1 = db
          .query<{ id: number }, [number, number, number]>(
            `INSERT INTO turns (session_id, prompt_number, status, tags, created_at_epoch)
             VALUES (?, ?, 'active', '["merge-dedupe-seg","child-lane","parent-lane"]', ?) RETURNING id`,
          )
          .get(sessionId, 1, 100)!.id;
        db.query<unknown, [number, number]>(
          `INSERT INTO segment_members (segment_id, turn_id, created_at_epoch) VALUES (?, ?, 100)`,
        ).run(segmentId, t1);

        const text = resultText(
          rememberTool(db, {
            verb: "merge",
            id: `E${segmentId}`,
            tag: "child-lane",
            into: "parent-lane",
          }),
        );
        expect(text).toContain("1 already carried");
        const tags = db
          .query<{ tags: string }, [number]>("SELECT tags FROM turns WHERE id = ?")
          .get(t1)!.tags;
        expect(JSON.parse(tags)).toEqual(["merge-dedupe-seg", "parent-lane"]);
      });

      test("refuses when the SURVIVOR is not declared — merge never mints it", () => {
        const segmentId = createViaTool("merge no survivor");
        declareLane(segmentId, "child-lane");
        const text = resultText(
          rememberTool(db, {
            verb: "merge",
            id: `E${segmentId}`,
            tag: "child-lane",
            into: "parent-lane",
          }),
        );
        expect(text).toStartWith("Parameter error:");
        expect(text).toContain('no declared lane "parent-lane"');
        expect(getLane(db, segmentId, "child-lane")).not.toBeNull();
      });

      test("refuses when the lane folded away is not declared", () => {
        const segmentId = createViaTool("merge no source");
        declareLane(segmentId, "parent-lane");
        const text = resultText(
          rememberTool(db, {
            verb: "merge",
            id: `E${segmentId}`,
            tag: "child-lane",
            into: "parent-lane",
          }),
        );
        expect(text).toStartWith("Parameter error:");
        expect(text).toContain('no declared lane "child-lane"');
      });

      test("refuses to merge a lane into itself", () => {
        const segmentId = createViaTool("merge self");
        declareLane(segmentId, "child-lane");
        const text = resultText(
          rememberTool(db, {
            verb: "merge",
            id: `E${segmentId}`,
            tag: "child-lane",
            into: "child-lane",
          }),
        );
        expect(text).toStartWith("Parameter error:");
        expect(text).toContain("two different lanes");
        expect(getLane(db, segmentId, "child-lane")).not.toBeNull();
      });

      test("refuses a missing or non-canonical survivor without touching anything", () => {
        const segmentId = createViaTool("merge bad into");
        declareLane(segmentId, "child-lane");
        expect(
          resultText(rememberTool(db, { verb: "merge", id: `E${segmentId}`, tag: "child-lane" })),
        ).toContain("into is required for merge");
        expect(
          resultText(
            rememberTool(db, {
              verb: "merge",
              id: `E${segmentId}`,
              tag: "child-lane",
              into: "Parent-Lane",
            }),
          ),
        ).toStartWith("Parameter error:");
        expect(getLane(db, segmentId, "child-lane")).not.toBeNull();
      });
    });

    // merge — TASK tier (container-unification ticket 08, spec D6). A call
    // with no `tag` routes here instead of the lane tier above; `into` names
    // the surviving task's own "E<n>" address rather than a lane's name.
    describe("merge — task tier (ticket 08)", () => {
      // Fresh per test (beforeEach rebuilds `db`), so a fixed prompt number
      // never collides across the describe's own tests.
      let taggedMemberPromptNumber = 500;

      /** Mirrors `create(members=[...])`'s own write shape — a member with the segment's own tag ALSO in `tags`, the state a real member normally carries. */
      function seedTaggedMember(segmentId: number, segmentTag: string, laneTag?: string): number {
        const tags = laneTag ? [segmentTag, laneTag] : [segmentTag];
        taggedMemberPromptNumber += 1;
        const id = db
          .query<{ id: number }, [number, number, string, number]>(
            `INSERT INTO turns (session_id, prompt_number, status, tags, created_at_epoch)
             VALUES (?, ?, 'active', ?, ?) RETURNING id`,
          )
          .get(sessionId, taggedMemberPromptNumber, JSON.stringify(tags), 100)!.id;
        db.query<unknown, [number, number]>(
          `INSERT INTO segment_members (segment_id, turn_id, created_at_epoch) VALUES (?, ?, 100)`,
        ).run(segmentId, id);
        return id;
      }

      test("hands members (by ownership) and lanes to the survivor, then leaves the roster", () => {
        const from = createViaTool("merge task from", "merge-task-from");
        const into = createViaTool("merge task into", "merge-task-into");
        declareLane(from, "shared-work");
        const t1 = seedTaggedMember(from, "merge-task-from", "shared-work");

        const text = resultText(rememberTool(db, { verb: "merge", id: `E${from}`, into: `E${into}` }));

        expect(text).toContain(`Merged E${from} into E${into}`);
        expect(text).toContain("member turns handed over: 1");
        expect(text).toContain("lane(s) handed over: 1");
        expect(getSegment(db, from)).toBeNull();
        expect(getLane(db, from, "shared-work")).toBeNull();
        expect(getLane(db, into, "shared-work")).not.toBeNull();
        expect(getSegmentMemberTurnIds(db, into)).toContain(t1);
        const tags = db
          .query<{ tags: string }, [number]>("SELECT tags FROM turns WHERE id = ?")
          .get(t1)!.tags;
        expect(JSON.parse(tags)).toEqual(["merge-task-into", "shared-work"]);
      });

      // Requirement 1 (peer #2 / spec D6): `create(members=[...])` seeds
      // `segment_members` WITHOUT the task's own tag — a selection keyed off
      // `turns.tags` would move NONE of this member, and the cascade off
      // `from`'s own deletion would then silently orphan it.
      test("a member seeded via create(members=[...]) — carrying NO task tag — still moves, and is backfilled", () => {
        const t1 = seedTurn(1, 100);
        const seedText = resultText(
          rememberTool(db, {
            verb: "create",
            title: "seeded from members",
            tag: "merge-task-from2",
            members: [`S${sessionId}/T1`],
          }),
        );
        const from = Number(/Created E(\d+)/.exec(seedText)![1]);
        const into = createViaTool("merge task into2", "merge-task-into2");
        // The precondition this test exists to pin: `create`'s own `members`
        // seeding never touched `t1`'s tags at all — it is a member ONLY by
        // `segment_members`, the exact state a tag-keyed selection would miss.
        expect(
          db.query<{ tags: string | null }, [number]>("SELECT tags FROM turns WHERE id = ?").get(t1)!.tags,
        ).toBeNull();
        expect(getSegmentMemberTurnIds(db, from)).toEqual([t1]);

        const text = resultText(rememberTool(db, { verb: "merge", id: `E${from}`, into: `E${into}` }));

        expect(text).toContain("member turns handed over: 1");
        expect(getSegmentMemberTurnIds(db, into)).toEqual([t1]);
        expect(getSegmentMemberTurnIds(db, from)).toEqual([]);
        expect(
          JSON.parse(db.query<{ tags: string }, [number]>("SELECT tags FROM turns WHERE id = ?").get(t1)!.tags),
        ).toEqual(["merge-task-into2"]);
      });

      test("a session attachment to `from` does not migrate", () => {
        const from = createViaTool("merge attach from", "merge-attach-from");
        const into = createViaTool("merge attach into", "merge-attach-into");
        rememberTool(db, { verb: "attach", id: `E${from}` }, { callerSessionId: sessionId });
        expect(getAttachedSegmentIds(db, sessionId)).toContain(from);

        rememberTool(db, { verb: "merge", id: `E${from}`, into: `E${into}` });

        expect(getAttachedSegmentIds(db, sessionId)).not.toContain(from);
        expect(getAttachedSegmentIds(db, sessionId)).not.toContain(into);
      });

      test("refuses a same-name lane collision between the two tasks, naming it — nothing moves", () => {
        const from = createViaTool("merge collide from", "merge-collide-from");
        const into = createViaTool("merge collide into", "merge-collide-into");
        declareLane(from, "contested");
        declareLane(into, "contested");

        const text = resultText(rememberTool(db, { verb: "merge", id: `E${from}`, into: `E${into}` }));

        expect(text).toStartWith("Parameter error:");
        expect(text).toContain("contested");
        expect(text).toContain(`E${from}`);
        expect(text).toContain(`E${into}`);
        expect(getSegment(db, from)).not.toBeNull();
        expect(getLane(db, from, "contested")).not.toBeNull();
      });

      // Ticket 10 (spec D6/D8): `force` proceeds despite the same-name lane
      // collision instead of refusing — the wiring `handleMergeTask` adds
      // over `mergeSegments`'s own `force` option.
      test("force: proceeds despite a same-name lane collision, folding the two lanes into one", () => {
        const from = createViaTool("merge force from", "merge-force-from");
        const into = createViaTool("merge force into", "merge-force-into");
        declareLane(from, "contested-force");
        declareLane(into, "contested-force");
        const t1 = seedTaggedMember(from, "merge-force-from", "contested-force");

        const text = resultText(
          rememberTool(db, { verb: "merge", id: `E${from}`, into: `E${into}`, force: true }),
        );

        expect(text).toContain(`Merged E${from} into E${into}`);
        expect(getSegment(db, from)).toBeNull();
        expect(getLane(db, from, "contested-force")).toBeNull();
        expect(getLane(db, into, "contested-force")).not.toBeNull();
        expect(getSegmentMemberTurnIds(db, into)).toContain(t1);
      });

      test("force must be a boolean when present", () => {
        const from = createViaTool("merge bad force from");
        const into = createViaTool("merge bad force into");
        const text = resultText(
          rememberTool(db, {
            verb: "merge",
            id: `E${from}`,
            into: `E${into}`,
            force: "yes" as unknown as boolean,
          }),
        );
        expect(text).toStartWith("Parameter error:");
        expect(text).toContain("force must be a boolean");
        expect(getSegment(db, from)).not.toBeNull();
      });

      test("refuses to merge a task into itself", () => {
        const from = createViaTool("merge self task");
        const text = resultText(rememberTool(db, { verb: "merge", id: `E${from}`, into: `E${from}` }));
        expect(text).toStartWith("Parameter error:");
        expect(text).toContain("two different tasks");
        expect(getSegment(db, from)).not.toBeNull();
      });

      test("refuses when `into` does not exist", () => {
        const from = createViaTool("merge missing into");
        const text = resultText(rememberTool(db, { verb: "merge", id: `E${from}`, into: "E999999" }));
        expect(text).toStartWith("Parameter error:");
        expect(text).toContain("E999999");
        expect(getSegment(db, from)).not.toBeNull();
      });

      test("refuses when `id` does not exist", () => {
        const into = createViaTool("merge missing from");
        const text = resultText(
          rememberTool(db, { verb: "merge", id: "E999999", into: `E${into}` }),
        );
        expect(text).toStartWith("Parameter error:");
      });

      test("refuses when `into` is closed, naming close as the way back", () => {
        const from = createViaTool("merge closed from");
        const into = createViaTool("merge closed into");
        rememberTool(db, { verb: "close", id: `E${into}` });

        const text = resultText(rememberTool(db, { verb: "merge", id: `E${from}`, into: `E${into}` }));

        expect(text).toStartWith("Parameter error:");
        expect(text).toContain("closed");
        expect(text).toContain(`remember(close, id="E${into}")`);
        expect(getSegment(db, from)).not.toBeNull();
      });

      test("`from` may be closed — merge is how a closed duplicate empties out", () => {
        const from = createViaTool("merge closed from2", "merge-closed-from2-tag");
        const into = createViaTool("merge closed into2", "merge-closed-into2-tag");
        rememberTool(db, { verb: "close", id: `E${from}` });

        const text = resultText(rememberTool(db, { verb: "merge", id: `E${from}`, into: `E${into}` }));

        expect(text).toContain(`Merged E${from} into E${into}`);
        expect(getSegment(db, from)).toBeNull();
      });

      test("requires `into`", () => {
        const from = createViaTool("merge no into task");
        const text = resultText(rememberTool(db, { verb: "merge", id: `E${from}` }));
        expect(text).toContain("into is required for merge");
      });
    });

    // Container-unification ticket 06 (spec D4): `undeclare`'s own guard,
    // inherited rather than rewritten — only the address collapses from an
    // `id` + `tag` pair into the one lane address `create`'s lane tier
    // already mints.
    describe("delete — lane tier (ticket 06)", () => {
      test("removes a lane nothing cites", () => {
        const segmentId = createViaTool("delete lane me");
        declareLane(segmentId, "write-gate");
        const text = resultText(
          rememberTool(db, { verb: "delete", id: `E${segmentId}/#write-gate` }),
        );
        expect(text).toContain(`Deleted lane "write-gate" on E${segmentId}`);
        expect(getLane(db, segmentId, "write-gate")).toBeNull();
      });

      test("refuses a tag that was never declared", () => {
        const segmentId = createViaTool("delete lane missing");
        const text = resultText(
          rememberTool(db, { verb: "delete", id: `E${segmentId}/#write-gate` }),
        );
        expect(text).toStartWith("Parameter error:");
        expect(text).toContain("no declared lane");
      });

      // Ticket 01 (spec D4), retargeted by lane-model-v12 ticket 10: the guard
      // counts MEMBER TURNS carrying the tag, not edges. Membership is a node
      // fact now, so a lane with members and no edge at all must still refuse —
      // the old edge-shaped condition would have retired it, leaving those
      // turns' tags pointing at a lane that no longer exists.
      test("refuses while a member turn in the segment still carries the tag, naming the count", () => {
        const segmentId = createViaTool("delete lane in-use");
        declareLane(segmentId, "write-gate");

        const t1 = db
          .query<{ id: number }, [number, number, number]>(
            `INSERT INTO turns (session_id, prompt_number, status, tags, created_at_epoch)
             VALUES (?, ?, 'active', '["write-gate"]', ?) RETURNING id`,
          )
          .get(sessionId, 1, 100)!.id;
        const t2 = db
          .query<{ id: number }, [number, number, number]>(
            `INSERT INTO turns (session_id, prompt_number, status, tags, created_at_epoch)
             VALUES (?, ?, 'active', '["write-gate"]', ?) RETURNING id`,
          )
          .get(sessionId, 2, 100)!.id;
        db.query<unknown, [number, number]>(
          `INSERT INTO segment_members (segment_id, turn_id, created_at_epoch) VALUES (?, ?, 100), (?, ?, 100)`,
        ).run(segmentId, t1, segmentId, t2);
        // The edge is deliberately left in place and is deliberately
        // IRRELEVANT: both turns already hold the lane open by carrying its
        // tag. Removing this write must not change the refusal.
        writeMemoryEdges(
          db,
          [
            {
              citing: { kind: "turn", id: t2 },
              cited: { kind: "turn", id: t1 },
              relation: "extends",
              provenance: "asserted",
              ...deriveSideTags(["write-gate"]),
            },
          ],
          100,
        );

        const text = resultText(
          rememberTool(db, { verb: "delete", id: `E${segmentId}/#write-gate` }),
        );
        expect(text).toStartWith("Parameter error:");
        expect(text).toContain("2 member turn(s)");
        expect(getLane(db, segmentId, "write-gate")).not.toBeNull();
      });

      test("refuses on a closed segment", () => {
        const segmentId = createViaTool("delete lane closed");
        declareLane(segmentId, "write-gate");
        rememberTool(db, { verb: "close", id: `E${segmentId}` });
        const text = resultText(
          rememberTool(db, { verb: "delete", id: `E${segmentId}/#write-gate` }),
        );
        expect(text).toStartWith("Parameter error:");
        expect(text).toContain("closed");
      });

      test("refuses a non-canonical tag, the same predicate create uses", () => {
        const segmentId = createViaTool("delete lane non-canonical");
        const text = resultText(
          rememberTool(db, { verb: "delete", id: `E${segmentId}/#Write-Gate` }),
        );
        expect(text).toStartWith("Parameter error:");
        expect(text).toContain("not lowercase");
      });

      test("refuses a non-existent segment", () => {
        const text = resultText(
          rememberTool(db, { verb: "delete", id: "E999999/#write-gate" }),
        );
        expect(text).toStartWith("Parameter error:");
      });
    });
  });

  // ---------------------------------------------------------------------
  // delete — task tier (container-unification ticket 06, spec D4)
  // ---------------------------------------------------------------------

  describe("delete — task tier (ticket 06)", () => {
    function createViaTool(title: string): number {
      const text = resultText(rememberTool(db, { verb: "create", title }));
      return Number(/Created E(\d+)/.exec(text)![1]);
    }

    test("an empty task — no members, no lanes — deletes", () => {
      const segmentId = createViaTool("empty task");
      const text = resultText(rememberTool(db, { verb: "delete", id: `E${segmentId}` }));
      expect(text).toContain(`Deleted E${segmentId}.`);
      expect(getSegment(db, segmentId)).toBeNull();
    });

    test("a closed empty task still deletes — close only toggles the roster", () => {
      const segmentId = createViaTool("closed empty task");
      rememberTool(db, { verb: "close", id: `E${segmentId}` });
      const text = resultText(rememberTool(db, { verb: "delete", id: `E${segmentId}` }));
      expect(text).toContain(`Deleted E${segmentId}.`);
      expect(getSegment(db, segmentId)).toBeNull();
    });

    // BRANCH 1 of 2 (spec D4): a member turn, by OWNERSHIP — not by tag.
    // `create(members=[...])` writes `segment_members` WITHOUT adding the
    // segment's tag to the turn (ticket 05's own seeding path), so a
    // tag-based count would read zero here and let delete cascade the row
    // away. This fixture is exactly that shape: a member the segment's own
    // tag column never mentions.
    test("BRANCH 1 — refuses a task with a member turn (by ownership, not tag), naming the count", () => {
      const turnId = seedTurn(1, 100);
      const text = resultText(
        rememberTool(db, {
          verb: "create",
          title: "task with an untagged member",
          tag: "untagged-member-task",
          members: [`S${sessionId}/T1`],
        }),
      );
      const segmentId = Number(/Created E(\d+)/.exec(text)![1]);
      // The member carries no tag naming this segment — confirms the fixture
      // actually exercises the ownership-not-tag reading: `create(members)`
      // seeds `segment_members` without touching the turn's own `tags`.
      const turnTags = db
        .query<{ tags: string | null }, [number]>("SELECT tags FROM turns WHERE id = ?")
        .get(turnId)!.tags;
      expect(turnTags ? JSON.parse(turnTags) : []).not.toContain("untagged-member-task");

      const deleteText = resultText(rememberTool(db, { verb: "delete", id: `E${segmentId}` }));
      expect(deleteText).toStartWith("Parameter error:");
      expect(deleteText).toContain("1 member turn(s)");
      expect(getSegment(db, segmentId)).not.toBeNull();
      expect(getSegmentMemberTurnIds(db, segmentId)).toEqual([turnId]);
    });

    // BRANCH 2 of 2: no members, but a declared lane — refused separately
    // and by its own count, never folded into the member branch's message.
    test("BRANCH 2 — refuses a task with no members but a declared lane, naming it", () => {
      const segmentId = createViaTool("task with only a lane");
      rememberTool(db, { verb: "create", id: `E${segmentId}/#solo-lane` });

      const text = resultText(rememberTool(db, { verb: "delete", id: `E${segmentId}` }));
      expect(text).toStartWith("Parameter error:");
      expect(text).toContain("1 lane(s)");
      expect(text).toContain("solo-lane");
      expect(getSegment(db, segmentId)).not.toBeNull();
    });

    test("rejects a missing id, and a nonexistent segment", () => {
      expect(resultText(rememberTool(db, { verb: "delete" }))).toStartWith(
        "Parameter error:",
      );
      expect(
        resultText(rememberTool(db, { verb: "delete", id: "E999999" })),
      ).toStartWith("Parameter error:");
    });
  });

  // ---------------------------------------------------------------------
  // clear (container-unification ticket 07, spec D5/D5b/D8)
  // ---------------------------------------------------------------------

  describe("clear (ticket 07)", () => {
    function createViaTool(title: string): number {
      const text = resultText(rememberTool(db, { verb: "create", title }));
      return Number(/Created E(\d+)/.exec(text)![1]);
    }
    function declareLane(segmentId: number, tag: string) {
      return rememberTool(db, { verb: "create", id: `E${segmentId}/#${tag}` });
    }
    function seedSegmentTag(segmentId: number, tag: string) {
      rememberTool(db, { verb: "retag", id: `E${segmentId}`, tag });
    }
    /**
     * A member turn carrying its SEGMENT's tag plus the given lane tags —
     * the real write-gate shape, same fixture discipline `merge`'s own
     * tests above use. `body` seeds title/content/insight so the D5b
     * bare-row-restore fixture can put a live citation in the prose.
     */
    function seedLaneMember(
      segmentId: number,
      segmentTag: string,
      promptNumber: number,
      laneTags: readonly string[],
      body?: { content?: string },
    ): number {
      const id = db
        .query<
          { id: number },
          [number, number, string, string | null, number]
        >(
          `INSERT INTO turns (session_id, prompt_number, status, tags, content, created_at_epoch)
           VALUES (?, ?, 'active', ?, ?, ?) RETURNING id`,
        )
        .get(
          sessionId,
          promptNumber,
          JSON.stringify([segmentTag, ...laneTags]),
          body?.content ?? null,
          100,
        )!.id;
      db.query<unknown, [number, number]>(
        `INSERT INTO segment_members (segment_id, turn_id, created_at_epoch) VALUES (?, ?, 100)`,
      ).run(segmentId, id);
      return id;
    }
    function tagsOf(turnId: number): string[] {
      const tags = db
        .query<{ tags: string }, [number]>("SELECT tags FROM turns WHERE id = ?")
        .get(turnId)!.tags;
      return JSON.parse(tags);
    }
    function edgeCount(): number {
      return db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM memory_edges").get()!.n;
    }

    describe("lane tier", () => {
      test("un-homes members and deletes the lane's own internal edges, leaving the registry row for delete", () => {
        const segmentId = createViaTool("clear me");
        seedSegmentTag(segmentId, "clear-me-seg");
        declareLane(segmentId, "child-lane");
        const t1 = seedLaneMember(segmentId, "clear-me-seg", 1, ["child-lane"]);
        const t2 = seedLaneMember(segmentId, "clear-me-seg", 2, ["child-lane"]);
        writeMemoryEdges(
          db,
          [
            {
              citing: { kind: "turn", id: t2 },
              cited: { kind: "turn", id: t1 },
              relation: "extends",
              provenance: "asserted",
              ...deriveSideTags(["child-lane"]),
            },
          ],
          100,
        );

        const text = resultText(
          rememberTool(db, { verb: "clear", id: `E${segmentId}/#child-lane` }),
        );
        expect(text).toContain(`Cleared E${segmentId}'s lane "child-lane"`);
        expect(text).toContain("2 member turn(s) released");
        expect(text).toContain("1 edge(s) deleted");

        expect(tagsOf(t1)).toEqual(["clear-me-seg"]);
        expect(tagsOf(t2)).toEqual(["clear-me-seg"]);
        expect(edgeCount()).toBe(0);
        // The lane row itself SURVIVES clear — delete removes it next, and
        // now can, since no member carries the tag any more.
        expect(getLane(db, segmentId, "child-lane")).not.toBeNull();
        const deleteText = resultText(
          rememberTool(db, { verb: "delete", id: `E${segmentId}/#child-lane` }),
        );
        expect(deleteText).toContain(`Deleted lane "child-lane" on E${segmentId}`);
        expect(getLane(db, segmentId, "child-lane")).toBeNull();
      });

      test("refuses a tag that was never declared", () => {
        const segmentId = createViaTool("clear lane missing");
        const text = resultText(
          rememberTool(db, { verb: "clear", id: `E${segmentId}/#write-gate` }),
        );
        expect(text).toStartWith("Parameter error:");
        expect(text).toContain("no declared lane");
      });

      test("refuses on a closed segment", () => {
        const segmentId = createViaTool("clear lane closed");
        declareLane(segmentId, "write-gate");
        rememberTool(db, { verb: "close", id: `E${segmentId}` });
        const text = resultText(
          rememberTool(db, { verb: "clear", id: `E${segmentId}/#write-gate` }),
        );
        expect(text).toStartWith("Parameter error:");
        expect(text).toContain("closed");
      });

      test("refuses a non-canonical tag, the same predicate delete uses", () => {
        const segmentId = createViaTool("clear lane non-canonical");
        const text = resultText(
          rememberTool(db, { verb: "clear", id: `E${segmentId}/#Write-Gate` }),
        );
        expect(text).toStartWith("Parameter error:");
        expect(text).toContain("not lowercase");
      });

      test("refuses a non-existent segment", () => {
        const text = resultText(
          rememberTool(db, { verb: "clear", id: "E999999/#write-gate" }),
        );
        expect(text).toStartWith("Parameter error:");
      });

      // THE MUTATION-CRITICAL TEST (spec D5, peer #4; Rev 3's own fixture
      // correction): running only `clear(force=true)` proves nothing here —
      // a wrong "compare the bare tag string" predicate calls this edge
      // INTERNAL and deletes it; the right "resolve through the endpoint's
      // owning segment" predicate calls it CROSS-LANE and force-deletes it.
      // Both leave the identical final row count. The fixture has to assert
      // the WITHOUT-force refusal first — the one place the two predicates
      // actually disagree — before it ever touches `force`.
      describe("side resolution — two segments declaring the SAME tag (spec D5 peer #4)", () => {
        test("without force: refuses, names the OTHER lane, and leaves the edge row untouched", () => {
          const seg1 = createViaTool("clear side e1");
          seedSegmentTag(seg1, "side-e1-seg");
          declareLane(seg1, "alpha");
          const t1 = seedLaneMember(seg1, "side-e1-seg", 1, ["alpha"]);

          const seg2 = createViaTool("clear side e2");
          seedSegmentTag(seg2, "side-e2-seg");
          declareLane(seg2, "alpha");
          const t2 = seedLaneMember(seg2, "side-e2-seg", 2, ["alpha"]);

          // E1/alpha -> E2/alpha: identical string on both sides, two
          // DIFFERENT lanes underneath.
          writeMemoryEdges(
            db,
            [
              {
                citing: { kind: "turn", id: t1 },
                cited: { kind: "turn", id: t2 },
                relation: "extends",
                provenance: "asserted",
                tailTag: "alpha",
                headTag: "alpha",
              },
            ],
            100,
          );
          expect(edgeCount()).toBe(1);

          const refused = resultText(
            rememberTool(db, { verb: "clear", id: `E${seg1}/#alpha` }),
          );
          expect(refused).toStartWith("Parameter error:");
          expect(refused).toContain("cross-lane");
          expect(refused).toContain(`E${seg2}/#alpha`);
          // Nothing moved: the edge, E1's member, E2's lane and E2's member
          // all stand exactly as they did.
          expect(edgeCount()).toBe(1);
          expect(tagsOf(t1)).toEqual(["side-e1-seg", "alpha"]);
          expect(getLane(db, seg2, "alpha")).not.toBeNull();
          expect(tagsOf(t2)).toEqual(["side-e2-seg", "alpha"]);

          const forced = resultText(
            rememberTool(db, { verb: "clear", id: `E${seg1}/#alpha`, force: true }),
          );
          expect(forced).toContain(`Cleared E${seg1}'s lane "alpha"`);
          expect(forced).toContain("1 edge(s) deleted");
          expect(edgeCount()).toBe(0);
          // E1's own member released...
          expect(tagsOf(t1)).toEqual(["side-e1-seg"]);
          // ...but E2's lane and its member are UNTOUCHED — only the
          // crossing edge (which belonged to neither lane's own
          // membership) is gone.
          expect(getLane(db, seg2, "alpha")).not.toBeNull();
          expect(tagsOf(t2)).toEqual(["side-e2-seg", "alpha"]);
        });
      });

      // The second `force` class (spec D5, peer #6): the OTHER side is the
      // unsettled sentinel, not another lane — a cross-lane-only warning
      // would miss it, leaving a stranded side after clear.
      test("half-settled edges (one side never settled) also need force, named as their own class", () => {
        const segmentId = createViaTool("clear half-settled");
        seedSegmentTag(segmentId, "half-seg");
        declareLane(segmentId, "alpha");
        const t1 = seedLaneMember(segmentId, "half-seg", 1, ["alpha"]);
        const t2 = seedLaneMember(segmentId, "half-seg", 2, []);
        writeMemoryEdges(
          db,
          [
            {
              citing: { kind: "turn", id: t1 },
              cited: { kind: "turn", id: t2 },
              relation: "extends",
              provenance: "asserted",
              tailTag: "alpha",
              // headTag omitted — stored as the unsettled sentinel.
            },
          ],
          100,
        );

        const refused = resultText(
          rememberTool(db, { verb: "clear", id: `E${segmentId}/#alpha` }),
        );
        expect(refused).toStartWith("Parameter error:");
        expect(refused).toContain("half-settled");
        expect(edgeCount()).toBe(1);

        const forced = resultText(
          rememberTool(db, { verb: "clear", id: `E${segmentId}/#alpha`, force: true }),
        );
        expect(forced).toContain(`Cleared E${segmentId}'s lane "alpha"`);
        expect(edgeCount()).toBe(0);
      });

      // D5b (Rev 3's own correction of a Rev 2 mistake): deleting a pair's
      // LAST relation row must not make a citation the citing prose still
      // asserts disappear — `restoreBareRowsForEmptiedPairs` puts a bare
      // `text-ref` row back. `clear` is a new bulk retraction path and has
      // to reuse that repair rather than reintroduce the defect it fixed.
      test("D5b: deleting the lane's last relation on a pair the prose still names restores a bare row", () => {
        const segmentId = createViaTool("clear d5b");
        seedSegmentTag(segmentId, "d5b-seg");
        declareLane(segmentId, "alpha");
        const b = seedLaneMember(segmentId, "d5b-seg", 2, []);
        const a = seedLaneMember(segmentId, "d5b-seg", 1, ["alpha"], {
          content: `Builds on [S${sessionId}/T2].`,
        });
        writeMemoryEdges(
          db,
          [
            {
              citing: { kind: "turn", id: a },
              cited: { kind: "turn", id: b },
              relation: "extends",
              provenance: "asserted",
              tailTag: "alpha",
              headTag: "alpha",
            },
          ],
          100,
        );

        const text = resultText(
          rememberTool(db, { verb: "clear", id: `E${segmentId}/#alpha` }),
        );
        expect(text).toContain("1 bare row(s) restored");

        const outgoing = getOutgoingEdges(db, { kind: "turn", id: a });
        expect(outgoing).toHaveLength(1);
        expect(outgoing[0]?.relation).toBeNull();
        expect(outgoing[0]?.provenance).toBe("text-ref");
        expect(outgoing[0]?.cited).toEqual({ kind: "turn", id: b });
      });

      // The negative of the D5b fixture above: when the prose does NOT name
      // the target any more, nothing is restored — clear must not invent a
      // citation the body never asserts.
      test("D5b: no prose naming the target means no bare row comes back", () => {
        const segmentId = createViaTool("clear d5b negative");
        seedSegmentTag(segmentId, "d5b-neg-seg");
        declareLane(segmentId, "alpha");
        const b = seedLaneMember(segmentId, "d5b-neg-seg", 2, []);
        const a = seedLaneMember(segmentId, "d5b-neg-seg", 1, ["alpha"]);
        writeMemoryEdges(
          db,
          [
            {
              citing: { kind: "turn", id: a },
              cited: { kind: "turn", id: b },
              relation: "extends",
              provenance: "asserted",
              tailTag: "alpha",
              headTag: "alpha",
            },
          ],
          100,
        );

        const text = resultText(
          rememberTool(db, { verb: "clear", id: `E${segmentId}/#alpha` }),
        );
        expect(text).not.toContain("bare row(s) restored");
        expect(getOutgoingEdges(db, { kind: "turn", id: a })).toEqual([]);
      });
    });

    describe("task tier", () => {
      test("refuses while any lane remains declared, listing them", () => {
        const segmentId = createViaTool("clear task with lane");
        declareLane(segmentId, "solo-lane");
        const text = resultText(rememberTool(db, { verb: "clear", id: `E${segmentId}` }));
        expect(text).toStartWith("Parameter error:");
        expect(text).toContain("1 lane(s)");
        expect(text).toContain("solo-lane");
        expect(getLane(db, segmentId, "solo-lane")).not.toBeNull();
      });

      // Ownership, not tag — the same reading `delete`'s own task tier
      // pins: `create(members=[...])` seeds `segment_members` without ever
      // writing the segment's tag onto the turn.
      test("with no lanes declared, releases every member by ownership — and delete then succeeds", () => {
        const turnId = seedTurn(1, 100);
        const created = resultText(
          rememberTool(db, {
            verb: "create",
            title: "clear task members",
            tag: "clear-task-seg",
            members: [`S${sessionId}/T1`],
          }),
        );
        const segmentId = Number(/Created E(\d+)/.exec(created)![1]);
        expect(getSegmentMemberTurnIds(db, segmentId)).toEqual([turnId]);

        const text = resultText(rememberTool(db, { verb: "clear", id: `E${segmentId}` }));
        expect(text).toContain(`Cleared E${segmentId}`);
        expect(text).toContain("1 member turn(s) released");
        expect(getSegmentMemberTurnIds(db, segmentId)).toEqual([]);
        expect(getSegment(db, segmentId)).not.toBeNull();

        const deleteText = resultText(rememberTool(db, { verb: "delete", id: `E${segmentId}` }));
        expect(deleteText).toContain(`Deleted E${segmentId}.`);
        expect(getSegment(db, segmentId)).toBeNull();
      });

      test("an empty task — nothing to release — clears trivially", () => {
        const segmentId = createViaTool("clear empty task");
        const text = resultText(rememberTool(db, { verb: "clear", id: `E${segmentId}` }));
        expect(text).toContain("0 member turn(s) released");
      });

      test("rejects a missing id, and a nonexistent segment", () => {
        expect(resultText(rememberTool(db, { verb: "clear" }))).toStartWith(
          "Parameter error:",
        );
        expect(
          resultText(rememberTool(db, { verb: "clear", id: "E999999" })),
        ).toStartWith("Parameter error:");
      });
    });
  });

  // ---------------------------------------------------------------------
  // attach
  // ---------------------------------------------------------------------

  describe("attach", () => {
    function createViaTool(label: string): number {
      const text = resultText(
        rememberTool(db, { verb: "create", title: `Segment for ${label}` }),
      );
      return Number(/Created E(\d+)/.exec(text)![1]);
    }

    test("binds the session by E id and returns the fields — refuses without a caller session", () => {
      const segmentId = createViaTool("attach-by-id");
      rememberTool(db, {
        verb: "write",
        id: `E${segmentId}`,
        field: "goal",
        value: "- land the tool",
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
        verb: "write",
        id: `E${segmentId}`,
        field: "goal",
        value: "- land the tool",
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
      expect(text).toContain("- goal:");
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

    // Ticket 15 (topic registry retirement): `id` resolves ONLY as a segment
    // address now — a caller that used to name a topic gets a rejection
    // echoing the "E<n>" address grammar, not a resolved segment.
    test("rejects a non-address name, echoing the E<n> address grammar", () => {
      createViaTool("not-an-address-anymore");
      const text = resultText(
        rememberTool(
          db,
          { verb: "attach", id: "not-an-address-anymore" },
          { callerSessionId: sessionId },
        ),
      );
      expect(text).toStartWith("Parameter error:");
      expect(text).toContain('"E<n>"');
    });

    test("rejects an id naming no real segment", () => {
      const text = resultText(
        rememberTool(db, { verb: "attach", id: "E999999" }, { callerSessionId: sessionId }),
      );
      expect(text).toStartWith("Parameter error:");
      expect(text).toContain("no segment E999999");
    });
  });

  // ---------------------------------------------------------------------
  // The pick list bare `attach` answers with (lane-model-v12 ticket 17,
  // spec D3g) — the menu behind the `/claude-mnemo:attach` slash command.
  // ---------------------------------------------------------------------

  describe("attach with no id — the pick list", () => {
    function createViaTool(title: string): number {
      return Number(
        /Created E(\d+)/.exec(resultText(rememberTool(db, { verb: "create", title })))![1],
      );
    }

    test("lists live segments as `E<n> <title> — #<tag>`, and does NOT bind anything", () => {
      const segmentId = createViaTool("Pickable container");
      rememberTool(db, { verb: "retag", id: `E${segmentId}`, tag: "pickable" });

      const text = resultText(rememberTool(db, { verb: "attach" }, { callerSessionId: sessionId }));

      expect(text).toContain("Attach this session to a segment");
      expect(text).toContain(`- E${segmentId} Pickable container — #pickable`);
      // A list is a READ: asking what the options are must not pick one.
      expect(
        db
          .query<{ count: number }, [number]>(
            "SELECT COUNT(*) AS count FROM segment_attachments WHERE session_id = ?",
          )
          .get(sessionId)!.count,
      ).toBe(0);
    });

    // Nine of the ten live standing containers are unnamed today (naming one
    // is a human's call, ticket 14), so this is the COMMON row, not an edge
    // case — the list has to render it as a fact rather than fall over or
    // print an empty tag.
    test("an untagged segment renders as (unnamed) — no crash, no empty tag, no `#`", () => {
      const segmentId = createViaTool("Nobody has named me");

      const text = resultText(rememberTool(db, { verb: "attach" }, { callerSessionId: sessionId }));

      expect(text).toContain(`- E${segmentId} Nobody has named me — (unnamed)`);
      expect(text).not.toContain("#(unnamed)");
      expect(text).not.toContain("— #\n");
      expect(text).not.toContain("undefined");
      expect(text).not.toContain("null");
    });

    test("marks the bindings this session already has, so re-picking is an informed choice", () => {
      const attachedId = createViaTool("Already mine");
      const looseId = createViaTool("Not mine");
      rememberTool(db, { verb: "attach", id: `E${attachedId}` }, { callerSessionId: sessionId });

      const lines = resultText(
        rememberTool(db, { verb: "attach" }, { callerSessionId: sessionId }),
      ).split("\n");

      expect(lines.find((line) => line.startsWith(`- E${attachedId} `))).toContain("(attached)");
      expect(lines.find((line) => line.startsWith(`- E${looseId} `))).not.toContain("(attached)");
    });

    // The slash command runs before anything is known about the session's
    // bindings, and a list that refused to render without a caller session
    // would be useless in exactly that case.
    test("renders without a caller session — only the (attached) markers need one", () => {
      const segmentId = createViaTool("Visible to a session-less caller");

      const text = resultText(rememberTool(db, { verb: "attach" }, {}));

      expect(text).toContain(`- E${segmentId} Visible to a session-less caller`);
      expect(text).not.toContain("(attached)");
      expect(text).not.toStartWith("Parameter error:");
    });

    test("a closed segment is off the list — the list is the LIVE roster", () => {
      const openId = createViaTool("Still open");
      const closedId = createViaTool("Since closed");
      rememberTool(db, { verb: "close", id: `E${closedId}` });

      const text = resultText(rememberTool(db, { verb: "attach" }, { callerSessionId: sessionId }));

      expect(text).toContain(`- E${openId} `);
      expect(text).not.toContain(`- E${closedId} `);
    });

    test("names both ways out — how to pick one, and how to cancel", () => {
      createViaTool("Anything");
      const text = resultText(rememberTool(db, { verb: "attach" }, { callerSessionId: sessionId }));
      expect(text).toContain('remember(attach, id="E<n>")');
      expect(text).toContain("remember(detach");
    });
  });

  // ---------------------------------------------------------------------
  // detach (lane-model-v12 ticket 17) — the way back out, which ADR-0005
  // deliberately did not have until auto-attach started minting bindings as
  // a side effect of a tags write.
  // ---------------------------------------------------------------------

  describe("detach", () => {
    function createViaTool(title: string): number {
      return Number(
        /Created E(\d+)/.exec(resultText(rememberTool(db, { verb: "create", title })))![1],
      );
    }

    test("cancels one binding by id, leaving the session's other bindings alone", () => {
      const dropped = createViaTool("Dropped");
      const kept = createViaTool("Kept");
      rememberTool(db, { verb: "attach", id: `E${dropped}` }, { callerSessionId: sessionId });
      rememberTool(db, { verb: "attach", id: `E${kept}` }, { callerSessionId: sessionId });

      const text = resultText(
        rememberTool(db, { verb: "detach", id: `E${dropped}` }, { callerSessionId: sessionId }),
      );

      expect(text).toContain(`Detached S${sessionId} from E${dropped}`);
      expect(
        db
          .query<{ segmentId: number }, [number]>(
            "SELECT segment_id AS segmentId FROM segment_attachments WHERE session_id = ?",
          )
          .all(sessionId)
          .map((row) => row.segmentId),
      ).toEqual([kept]);
    });

    test("bare detach cancels EVERY binding this session has", () => {
      for (const title of ["One", "Two", "Three"]) {
        const id = createViaTool(title);
        rememberTool(db, { verb: "attach", id: `E${id}` }, { callerSessionId: sessionId });
      }

      const text = resultText(rememberTool(db, { verb: "detach" }, { callerSessionId: sessionId }));

      expect(text).toContain("from 3 segment(s)");
      expect(
        db
          .query<{ count: number }, [number]>(
            "SELECT COUNT(*) AS count FROM segment_attachments WHERE session_id = ?",
          )
          .get(sessionId)!.count,
      ).toBe(0);
    });

    // The caller asked for an end state and got it — the same latitude
    // `attach`'s "(already attached)" already takes.
    test("a binding that was never there is reported, not rejected", () => {
      const id = createViaTool("Never attached");
      const text = resultText(
        rememberTool(db, { verb: "detach", id: `E${id}` }, { callerSessionId: sessionId }),
      );
      expect(text).not.toStartWith("Parameter error:");
      expect(text).toContain("nothing to cancel");
    });

    test("detach never deletes the segment — only the binding", () => {
      const id = createViaTool("Survives detach");
      rememberTool(db, { verb: "attach", id: `E${id}` }, { callerSessionId: sessionId });
      rememberTool(db, { verb: "detach", id: `E${id}` }, { callerSessionId: sessionId });
      expect(getSegment(db, id)).not.toBeNull();
    });

    test("detach cancels only the CALLING session's binding", () => {
      const other = upsertSession(db, {
        contentSessionId: "other-session",
        project: "/tmp/project-remember",
        title: null,
        insight: null,
        createdAtEpoch: 100,
        updatedAtEpoch: 100,
        completedAtEpoch: null,
      }).id;
      const id = createViaTool("Shared container");
      rememberTool(db, { verb: "attach", id: `E${id}` }, { callerSessionId: sessionId });
      rememberTool(db, { verb: "attach", id: `E${id}` }, { callerSessionId: other });

      rememberTool(db, { verb: "detach", id: `E${id}` }, { callerSessionId: sessionId });

      expect(
        db
          .query<{ count: number }, [number]>(
            "SELECT COUNT(*) AS count FROM segment_attachments WHERE session_id = ?",
          )
          .get(other)!.count,
      ).toBe(1);
    });

    test("refuses without a caller session — there is no binding to cancel", () => {
      const id = createViaTool("Unreachable");
      const text = resultText(rememberTool(db, { verb: "detach", id: `E${id}` }, {}));
      expect(text).toStartWith("Parameter error:");
      expect(text).toContain("caller session unknown");
    });

    test("rejects a non-address id, echoing the E<n> address grammar", () => {
      const text = resultText(
        rememberTool(db, { verb: "detach", id: "some-name" }, { callerSessionId: sessionId }),
      );
      expect(text).toStartWith("Parameter error:");
      expect(text).toContain('"E<n>"');
    });

    test("the schema accepts detach with and without an id", () => {
      expect(rememberInputSchema.safeParse({ verb: "detach" }).success).toBe(true);
      expect(rememberInputSchema.safeParse({ verb: "detach", id: "E1" }).success).toBe(true);
    });

    // Ticket 23 — the STORAGE contract behind the sticky detach. The flow it
    // exists for (auto-attach honouring the refusal) is pinned in
    // tests/hooks/session-attach-flow.test.ts; what is pinned here is that the
    // two tables can never contradict each other, which is what lets every
    // existing reader of `segment_attachments` stay filter-free.
    function detachmentCount(segmentId: number): number {
      return db
        .query<{ count: number }, [number, number]>(
          "SELECT COUNT(*) AS count FROM segment_detachments WHERE session_id = ? AND segment_id = ?",
        )
        .get(sessionId, segmentId)!.count;
    }

    test("an explicit detach RECORDS the refusal auto-attach reads", () => {
      const id = createViaTool("Refused once");
      rememberTool(db, { verb: "attach", id: `E${id}` }, { callerSessionId: sessionId });
      expect(detachmentCount(id)).toBe(0);

      rememberTool(db, { verb: "detach", id: `E${id}` }, { callerSessionId: sessionId });

      expect(detachmentCount(id)).toBe(1);
    });

    // The named form asks for an end state ("not attached to E<n>"), and the
    // end state must not depend on whether a binding happened to exist at that
    // instant — otherwise the same call sticks or does not for reasons the
    // caller cannot see.
    test("the named form records the refusal even when there was no binding to cancel", () => {
      const id = createViaTool("Refused before ever attaching");
      rememberTool(db, { verb: "detach", id: `E${id}` }, { callerSessionId: sessionId });
      expect(detachmentCount(id)).toBe(1);
    });

    // Bare detach names no segment, so it can only refuse what it holds — the
    // honest limit, recorded rather than hidden: it is not a standing
    // "never auto-attach me" switch, and ticket 23 does not ask for one.
    test("bare detach records one refusal per binding it cancelled, and none when it cancelled nothing", () => {
      const attachedId = createViaTool("Held");
      const looseId = createViaTool("Never held");
      rememberTool(db, { verb: "attach", id: `E${attachedId}` }, { callerSessionId: sessionId });

      rememberTool(db, { verb: "detach" }, { callerSessionId: sessionId });

      expect(detachmentCount(attachedId)).toBe(1);
      expect(detachmentCount(looseId)).toBe(0);
    });

    test("attach clears the recorded refusal — a pair is never both attached and refused", () => {
      const id = createViaTool("Back from refusal");
      rememberTool(db, { verb: "attach", id: `E${id}` }, { callerSessionId: sessionId });
      rememberTool(db, { verb: "detach", id: `E${id}` }, { callerSessionId: sessionId });
      expect(detachmentCount(id)).toBe(1);

      rememberTool(db, { verb: "attach", id: `E${id}` }, { callerSessionId: sessionId });

      expect(detachmentCount(id)).toBe(0);
      expect(
        db
          .query<{ count: number }, [number, number]>(
            "SELECT COUNT(*) AS count FROM segment_attachments WHERE session_id = ? AND segment_id = ?",
          )
          .get(sessionId, id)!.count,
      ).toBe(1);
    });

    test("a refusal is per session — one session's detach does not veto another's auto-attach", () => {
      const other = upsertSession(db, {
        contentSessionId: "other-refusing-session",
        project: "/tmp/project-remember",
        title: null,
        insight: null,
        createdAtEpoch: 100,
        updatedAtEpoch: 100,
        completedAtEpoch: null,
      }).id;
      const id = createViaTool("Shared again");
      rememberTool(db, { verb: "detach", id: `E${id}` }, { callerSessionId: sessionId });

      expect(
        db
          .query<{ count: number }, [number, number]>(
            "SELECT COUNT(*) AS count FROM segment_detachments WHERE session_id = ? AND segment_id = ?",
          )
          .get(other, id)!.count,
      ).toBe(0);
    });
  });

  // ---------------------------------------------------------------------
  // write (ticket 05, write-mode-edit-semantics: retires `append` — this
  // describe block used to be "append" and every test below exercised
  // accumulation; `write` replaces a field WHOLE, so the accumulation-shaped
  // tests are rewritten rather than merely renamed — see each test's own
  // comment for what changed and why.)
  // ---------------------------------------------------------------------

  describe("write", () => {
    // Fixed at epoch 100 — matching `seedTurn`/`seedTurnsSince`'s own baseline
    // — so the cadence tests below can control exactly how many of a
    // session's turns fall AFTER the segment's `updatedAtEpoch`.
    function createSegmentId(label: string): number {
      const text = resultText(
        rememberTool(db, { verb: "create", title: label }, { now: () => 100 }),
      );
      return Number(/Created E(\d+)/.exec(text)![1]);
    }

    // Ticket 05 (spec D11): rewritten — `append`'s "dash-prefixed even
    // without a leading dash" auto-normalization does not exist on `write`
    // (db/segments.ts's own `writeSegmentWorkingStateField` doc comment:
    // "no bullet-list normalization... write supplies the finished text
    // itself"). This is the positive counterpart: `value` lands verbatim.
    test("stores value verbatim — no automatic row-dashing (unlike the retired append)", () => {
      const segmentId = createSegmentId("write-verbatim");
      const text = resultText(
        rememberTool(db, {
          verb: "write",
          id: `E${segmentId}`,
          field: "next_steps",
          value: "already dashed\nnot yet dashed",
        }),
      );
      expect(text).toContain("Wrote next_steps");
      expect(getSegment(db, segmentId)?.nextSteps).toBe(
        "already dashed\nnot yet dashed",
      );
    });

    // Ticket 05 (spec D2): rewritten from "a second append accumulates onto
    // the first rather than overwriting" — that is exactly the behaviour
    // `write` does NOT have. A second `write` replaces the field whole; the
    // caller composes the full text (first row + new row) itself, which is
    // what the tool description's row-add idiom recommends `edit` for
    // instead (see the `edit` describe block below).
    test("a second write REPLACES the first rather than accumulating", () => {
      const segmentId = createSegmentId("write-replaces");
      rememberTool(db, { verb: "write", id: `E${segmentId}`, field: "done", value: "- row one" });
      expect(getSegment(db, segmentId)?.done).toBe("- row one");

      rememberTool(db, { verb: "write", id: `E${segmentId}`, field: "done", value: "- row two" });
      expect(getSegment(db, segmentId)?.done).toBe("- row two");
    });

    // Ticket 02 (cadence-simplification, [S15069/T1057]): the "too soon"
    // reminder (dense writes under 10 turns apart) retired outright, and with
    // it the `decisions` exemption that existed ONLY to exempt from that one
    // line — there is nothing left to exempt once the line is gone.
    test("dense writes under 10 turns apart no longer draw a too-soon reminder", () => {
      const segmentId = createSegmentId("write-dense");
      // Zero turns have happened in this session since the segment's creation.
      const text = resultText(
        rememberTool(
          db,
          { verb: "write", id: `E${segmentId}`, field: "next_steps", value: "- soon" },
          { callerSessionId: sessionId, now: () => 100 },
        ),
      );
      expect(text).not.toContain("over-maintaining");
      expect(text).not.toContain("too soon");
      expect(text).toContain("0 turns since this segment's last maintenance.");
    });

    test("decisions writes get the identical receipt as any other field — no field-level exemption remains", () => {
      const segmentId = createSegmentId("write-decisions-parity");
      const text = resultText(
        rememberTool(
          db,
          { verb: "write", id: `E${segmentId}`, field: "decisions", value: "- ruled" },
          { callerSessionId: sessionId, now: () => 100 },
        ),
      );
      expect(text).not.toContain("over-maintaining");
      expect(text).toContain("0 turns since this segment's last maintenance.");
    });

    test("under 20 turns since this segment's last field update, the receipt states the bare count", () => {
      const segmentId = createSegmentId("write-under-nudge");
      seedTurnsSince(100, 19, 1);
      const text = resultText(
        rememberTool(
          db,
          { verb: "write", id: `E${segmentId}`, field: "next_steps", value: "- still on track" },
          { callerSessionId: sessionId, now: () => 500 },
        ),
      );
      expect(text).not.toContain("consider a maintenance pass");
      expect(text).toContain("19 turns since this segment's last maintenance.");
    });

    // Ticket 09 (spec "write-mode-edit-semantics"): ticket 02's own `>= 20`
    // suffix branch on this receipt is retired — the session-wide 20-turn
    // check on the UserPromptSubmit channel (hooks/note-reminder.ts) is now
    // the ONE surviving maintenance reminder, so the receipt states the bare
    // turn count with no suffix regardless of how large the count gets.
    test("20+ consecutive turns with no update to any of this segment's fields still gets the bare count, no suffix", () => {
      const segmentId = createSegmentId("write-at-nudge");
      seedTurnsSince(100, 20, 1);
      const text = resultText(
        rememberTool(
          db,
          { verb: "write", id: `E${segmentId}`, field: "decisions", value: "- late ruling" },
          { callerSessionId: sessionId, now: () => 500 },
        ),
      );
      expect(text).not.toContain("consider a maintenance pass");
      expect(text).toContain("20 turns since this segment's last maintenance.");
    });

    // Ticket 05 (spec D2): rewritten — `append`'s "one row, one line"
    // newline rejection does not apply to `write`: `value` is the field's
    // WHOLE text, which is legitimately multi-line (that is the normal
    // shape of a multi-row field). This is the positive counterpart:
    // multi-line `value` is accepted and stored exactly.
    test("a multi-line value is accepted verbatim — write has no per-row shape to enforce", () => {
      const segmentId = createSegmentId("write-multiline");
      const text = resultText(
        rememberTool(db, {
          verb: "write",
          id: `E${segmentId}`,
          field: "goal",
          value: "- line one\n- line two",
        }),
      );
      expect(text).toContain("Wrote goal");
      expect(getSegment(db, segmentId)?.goal).toBe("- line one\n- line two");
    });

    test("tool-call markup in value is rejected, nothing stored", () => {
      const segmentId = createSegmentId("write-markup");
      const text = resultText(
        rememberTool(db, {
          verb: "write",
          id: `E${segmentId}`,
          field: "goal",
          value: '- bad <invoke name="x">',
        }),
      );
      expect(text).toContain("tool-call syntax");
      expect(getSegment(db, segmentId)?.goal).toBeNull();
    });

    // Ticket 05: null (or an all-whitespace value) clears the field — the
    // segment surface's first whole-field clear (spec D2/D11); previously
    // unrepresentable without append/replace juggling a field to empty.
    test("null clears the field — the segment surface's first whole-field clear", () => {
      const segmentId = createSegmentId("write-clear");
      rememberTool(db, { verb: "write", id: `E${segmentId}`, field: "goal", value: "- ship it" });
      expect(getSegment(db, segmentId)?.goal).toBe("- ship it");

      const text = resultText(
        rememberTool(db, { verb: "write", id: `E${segmentId}`, field: "goal", value: null }),
      );
      expect(text).toContain("Cleared goal");
      expect(getSegment(db, segmentId)?.goal).toBeNull();
    });

    // Ticket 05: the write gate is now `status === "closed"` only (not "any
    // non-open") — closing goes through remember's own `close` verb, and the
    // rejection names it as the way back.
    test("refuses a write on a closed segment, naming close as the way back", () => {
      const segmentId = createSegmentId("write-closed");
      rememberTool(db, { verb: "close", id: `E${segmentId}` });
      expect(getSegment(db, segmentId)?.status).toBe("closed");

      const text = resultText(
        rememberTool(db, { verb: "write", id: `E${segmentId}`, field: "goal", value: "- late" }),
      );
      expect(text).toStartWith("Parameter error:");
      expect(text).toContain("closed");
      expect(text).toContain(`remember(close, id="E${segmentId}")`);
    });

    test("citations in a written field create a memory edge (existing citation machinery reused)", () => {
      const turn = seedTurn(1, 100);
      const promptNumber = 1;
      const segmentId = createSegmentId("write-citation");
      rememberTool(db, {
        verb: "write",
        id: `E${segmentId}`,
        field: "decisions",
        value: `- ruled per [S${sessionId}/T${promptNumber}]`,
      });
      const edges = getOutgoingEdges(db, { kind: "segment", id: segmentId });
      expect(edges.some((edge) => edge.cited.kind === "turn" && edge.cited.id === turn)).toBe(true);
    });
  });

  // ---------------------------------------------------------------------
  // edit (ticket 05's rename of `replace` — identical oldString/newString
  // shape and three-state contract; only the verb word changed)
  // ---------------------------------------------------------------------

  describe("edit", () => {
    function createWithRow(label: string, field: string, row: string): number {
      const text = resultText(rememberTool(db, { verb: "create", title: label }));
      const segmentId = Number(/Created E(\d+)/.exec(text)![1]);
      rememberTool(db, { verb: "write", id: `E${segmentId}`, field, value: `- ${row}` });
      return segmentId;
    }

    test("replaces a unique match", () => {
      const segmentId = createWithRow("edit-basic", "constraints", "stay under budget");
      const text = resultText(
        rememberTool(db, {
          verb: "edit",
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
      const segmentId = createWithRow("edit-delete", "reference", "stale pointer");
      const text = resultText(
        rememberTool(db, {
          verb: "edit",
          id: `E${segmentId}`,
          field: "reference",
          oldString: "- stale pointer",
          newString: "",
        }),
      );
      expect(text).toContain("Removed a row from reference");
      expect(getSegment(db, segmentId)?.reference).toBeNull();
    });

    // [S15069/T1022] — the phantom-bullet regression: `append` used to
    // normalize a bare row INTO `- ` form, so callers naturally deleted by
    // the same bare text — which used to leave a contentless `- ` line the
    // trim()-only cleaner kept (two shipped live on E60's next_steps).
    // `append` is gone (ticket 05), but the cleanup this regression test
    // pins lives in the shared `replaceInSegmentWorkingStateField` `edit`
    // still calls, so the scenario is reproduced by seeding the row
    // dash-prefixed (as `write` requires) and deleting it by its bare text.
    test("deleting by BARE row text (no dash) leaves no phantom empty bullet", () => {
      const segmentId = createWithRow("edit-delete-bare", "next_steps", "run the campaign");
      const text = resultText(
        rememberTool(db, {
          verb: "edit",
          id: `E${segmentId}`,
          field: "next_steps",
          oldString: "run the campaign",
          newString: "",
        }),
      );
      expect(text).toContain("Removed a row from next_steps");
      expect(getSegment(db, segmentId)?.nextSteps).toBeNull();
    });

    test("a missing oldString rejects loudly and leaves the field untouched", () => {
      const segmentId = createWithRow("edit-missing", "goal", "ship it");
      const text = resultText(
        rememberTool(db, {
          verb: "edit",
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
      const segmentId = createWithRow("edit-ambiguous", "done", "shipped X");
      // Ticket 05: `append`'s second call is gone — `write` supplies the
      // full two-row text directly (the row-add idiom's OWN alternative,
      // "use write when you have the field read whole").
      rememberTool(db, {
        verb: "write",
        id: `E${segmentId}`,
        field: "done",
        value: "- shipped X\n- shipped X again",
      });
      const before = getSegment(db, segmentId)?.done;

      const text = resultText(
        rememberTool(db, {
          verb: "edit",
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

    test("dropping a row's only citation on edit removes its memory edge", () => {
      seedTurn(1, 100);
      const segmentId = createWithRow(
        "edit-citation",
        "decisions",
        `ruled per [S${sessionId}/T1]`,
      );
      expect(getOutgoingEdges(db, { kind: "segment", id: segmentId }).length).toBeGreaterThan(0);

      rememberTool(db, {
        verb: "edit",
        id: `E${segmentId}`,
        field: "decisions",
        oldString: `- ruled per [S${sessionId}/T1]`,
        newString: "- ruled, no longer citing the source turn",
      });
      expect(getOutgoingEdges(db, { kind: "segment", id: segmentId }).length).toBe(0);
    });

    test("refuses a write on a closed segment, naming close as the way back", () => {
      const segmentId = createWithRow("edit-closed", "goal", "ship it");
      rememberTool(db, { verb: "close", id: `E${segmentId}` });

      const text = resultText(
        rememberTool(db, {
          verb: "edit",
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

    // Ticket 05 (spec D7): the row-add idiom the tool description documents
    // — anchor on the last row and swap it for itself plus the new line —
    // actually works, now that `append` is gone and this is the only
    // dedicated add-a-row path.
    test("the row-add idiom: anchoring edit on the last row adds a new one", () => {
      const segmentId = createWithRow("edit-row-add-idiom", "next_steps", "first step");
      const text = resultText(
        rememberTool(db, {
          verb: "edit",
          id: `E${segmentId}`,
          field: "next_steps",
          oldString: "- first step",
          newString: "- first step\n- second step",
        }),
      );
      expect(text).toContain("Replaced text in next_steps");
      expect(getSegment(db, segmentId)?.nextSteps).toBe("- first step\n- second step");
    });
  });

  // Ticket 05 (write-mode-edit-semantics, spec D14), settlement-ergonomics
  // ticket 01 (spec D1): the retired verbs still name their replacement at
  // the RUNTIME entry point (`rememberTool` itself, via this file's own
  // `RETIRED_REMEMBER_VERB_REPLACEMENT`) — reachable only by a caller that
  // bypasses `rememberInputSchema` entirely, which is exactly what this
  // suite's direct `rememberTool()` calls do. Ticket 01 removed the three
  // verbs from `rememberInputShape.verb`'s enum outright, so a
  // schema-validated call (the real MCP path) no longer sees this message at
  // all — see "the schema layer no longer accepts the retired verbs at all"
  // below.
  describe("retired verbs (ticket 05, runtime belt-and-braces path)", () => {
    test("'append' names write/edit as its replacement, and nothing lands", () => {
      const created = rememberTool(db, { verb: "create", title: "retired-append-target" });
      const segmentId = /Created E(\d+)/.exec(resultText(created))![1];

      const text = resultText(
        rememberTool(db, { verb: "append", id: `E${segmentId}`, field: "goal", value: "- x" }),
      );
      expect(text).toStartWith("Parameter error:");
      expect(text).toContain("retired");
      expect(text).toContain("`write`");
      expect(text).toContain("`edit`");
      expect(getSegment(db, segmentId)?.goal).toBeNull();
    });

    test("'replace' names edit as its replacement, and nothing lands", () => {
      const created = rememberTool(db, { verb: "create", title: "retired-replace-target", goal: "seed" });
      const segmentId = /Created E(\d+)/.exec(resultText(created))![1];

      const text = resultText(
        rememberTool(db, {
          verb: "replace",
          id: `E${segmentId}`,
          field: "goal",
          oldString: "- seed",
          newString: "- changed",
        }),
      );
      expect(text).toStartWith("Parameter error:");
      expect(text).toContain("retired");
      expect(text).toContain("`edit`");
      expect(getSegment(db, segmentId)?.goal).toBe("- seed"); // untouched
    });

    // Container-unification ticket 05 (spec D3): `declare` retires into
    // `create`'s own id-tier routing — same belt-and-braces pairing as
    // `append`/`replace` above.
    //
    // ACCEPTANCE CRITERION 4's mutation target ("declare 继续工作, must
    // redden a test"). If `handleDeclare` were restored and re-wired into
    // the dispatch switch (or `RETIRED_REMEMBER_VERB_REPLACEMENT.declare`
    // deleted), this call would mint the lane instead of refusing — the
    // OBSERVABLE that distinguishes the two: `result` names `create`, not a
    // lane row, AND `getLane` stays null. A mutation that merely changed the
    // wording of the refusal (leaving it a refusal) would still leave both
    // assertions green, which is why `not.toContain("Created lane")` is
    // pinned alongside the "has retired" text, not instead of it.
    test("'declare' names create as its replacement, and nothing lands", () => {
      const created = rememberTool(db, { verb: "create", title: "retired-declare-target" });
      const segmentId = /Created E(\d+)/.exec(resultText(created))![1];

      const text = resultText(
        rememberTool(db, { verb: "declare", id: `E${segmentId}`, tag: "still-alive" }),
      );
      expect(text).toStartWith("Parameter error:");
      expect(text).toContain("retired");
      expect(text).toContain("`create`");
      expect(text).not.toContain("Created lane");
      expect(getLane(db, Number(segmentId), "still-alive")).toBeNull();
    });
  });

  // Ticket 01 (settlement-ergonomics spec D1): the schema layer itself no
  // longer accepts these three verbs at all — `rememberInputShape.verb`'s
  // enum dropped them, so a schema-validated call fails
  // `rememberInputSchema`'s own base-shape parse before `rememberTool()` (and
  // its named-replacement message above) ever runs. Mutation: put "append"
  // back in the enum (mcp/definitions.ts) with nothing else changed and this
  // goes green (`.success` flips to `true`).
  test("the schema layer no longer accepts the retired verbs at all", () => {
    expect(rememberInputSchema.safeParse({ verb: "append", id: "E1", field: "goal", value: "x" }).success).toBe(
      false,
    );
    expect(
      rememberInputSchema.safeParse({
        verb: "replace",
        id: "E1",
        field: "goal",
        oldString: "a",
        newString: "b",
      }).success,
    ).toBe(false);
    expect(rememberInputSchema.safeParse({ verb: "assign" }).success).toBe(false);
    // Container-unification ticket 05: same treatment for `declare`.
    expect(
      rememberInputSchema.safeParse({ verb: "declare", id: "E1", tag: "write-gate" }).success,
    ).toBe(false);
  });

  // ---------------------------------------------------------------------
  // close
  // ---------------------------------------------------------------------

  describe("close", () => {
    function createViaTool(label: string): number {
      const text = resultText(
        rememberTool(db, { verb: "create", title: `Segment for ${label}` }),
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
      const writeText = resultText(
        rememberTool(db, { verb: "write", id: `E${segmentId}`, field: "goal", value: "- back open" }),
      );
      expect(writeText).toStartWith("Wrote");
    });

    // Ticket 15 (topic registry retirement): `id` resolves ONLY as a
    // segment address — a non-address name is rejected, echoing the "E<n>"
    // grammar, same as attach/write/edit.
    test("rejects a non-address name, echoing the E<n> address grammar", () => {
      createViaTool("not-an-address-anymore");
      const text = resultText(rememberTool(db, { verb: "close", id: "not-an-address-anymore" }));
      expect(text).toStartWith("Parameter error:");
      expect(text).toContain('"E<n>"');
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
  // -------------------------------------------------------------------
  // Ticket 14 (lane-model-v12 spec D3e): `assign` retired with the whole
  // explicit-membership model. What used to be twenty-odd tests of an
  // assignment verb is now one test that the verb is GONE and names its
  // replacement; the behaviour it used to cover lives in
  // `tests/db/turn-tag-gate.test.ts` (the gate) and in this file's own
  // derivation test below (the consequence).
  // -------------------------------------------------------------------

  describe("assign — retired (ticket 14)", () => {
    test("the verb is refused, naming where membership comes from now", () => {
      const text = resultText(
        rememberTool(db, { verb: "assign", id: "E1", turns: [`S${sessionId}/T1`] }),
      );
      expect(text).toStartWith("Parameter error:");
      expect(text).toContain("has retired");
      expect(text).toContain("derived from a turn's tags");
    });

    test("the schema layer refuses it too, so the MCP path and the direct path agree", () => {
      const parsed = rememberInputSchema.safeParse({
        verb: "assign",
        id: "E1",
        turns: ["S1/T1"],
      });
      expect(parsed.success).toBe(false);
    });
  });

  // Membership with no verb at all: the turn carries the segment's tag, and
  // that IS the membership (ticket 14).
  describe("membership is derived from the turn's own tags (ticket 14)", () => {
    test("a turn whose tags carry a segment's tag becomes its member; dropping the tag makes it homeless", () => {
      const turnId = seedTurn(1, 100);
      const text = resultText(
        rememberTool(db, { verb: "create", title: "Named", tag: "named-container" }),
      );
      const segmentId = Number(/Created E(\d+)/.exec(text)![1]);
      expect(getSegmentMemberTurnIds(db, segmentId)).toEqual([]);

      updateTurnById(db, turnId, { tags: ["named-container"], updatedAtEpoch: 200 });
      expect(getSegmentMemberTurnIds(db, segmentId)).toEqual([turnId]);

      updateTurnById(db, turnId, { tags: [], updatedAtEpoch: 300 });
      expect(getSegmentMemberTurnIds(db, segmentId)).toEqual([]);
    });

    test("two segments cannot share a tag — the second create is refused naming the first", () => {
      const first = resultText(
        rememberTool(db, { verb: "create", title: "First", tag: "contested" }),
      );
      const firstId = Number(/Created E(\d+)/.exec(first)![1]);
      const second = resultText(
        rememberTool(db, { verb: "create", title: "Second", tag: "contested" }),
      );
      expect(second).toStartWith("Parameter error:");
      expect(second).toContain(`E${firstId}`);
      expect(second).toContain("globally unique");
    });
  });
});

// ---------------------------------------------------------------------------
// Write gate (ticket 02, read-write-contract spec) — the gate's first
// consumer surface: `remember`'s segment field writes (`write`/`edit` —
// ticket 05's rename of `append`/`replace` — Working State included).
// `.scratch/read-write-contract/spec.md` "门(写面)".
// ---------------------------------------------------------------------------

describe("remember write gate (ticket 02)", () => {
  let db: Database;
  let sessionA: number;
  let sessionB: number;

  function createSegmentAs(label: string): number {
    const text = resultText(
      rememberTool(db, { verb: "create", title: label }, { callerSessionId: sessionA }),
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
        { verb: "write", id: `E${segmentId}`, field: "goal", value: "- ship it" },
        { callerSessionId: sessionB },
      ),
    );
    expect(text).toStartWith("Wrote");
  });

  test("the same session may keep rewriting its own field with no read in between", () => {
    const segmentId = createSegmentAs("self-rewrite");
    rememberTool(
      db,
      { verb: "write", id: `E${segmentId}`, field: "goal", value: "- first" },
      { callerSessionId: sessionA },
    );
    const text = resultText(
      rememberTool(
        db,
        { verb: "edit", id: `E${segmentId}`, field: "goal", oldString: "- first", newString: "- second" },
        { callerSessionId: sessionA },
      ),
    );
    expect(text).toStartWith("Replaced text in");
  });

  test("a second session writing a field someone else already wrote, without ever reading it, is rejected — never-read", () => {
    const segmentId = createSegmentAs("never-read");
    rememberTool(
      db,
      { verb: "write", id: `E${segmentId}`, field: "goal", value: "- from A" },
      { callerSessionId: sessionA },
    );

    const text = resultText(
      rememberTool(
        db,
        { verb: "write", id: `E${segmentId}`, field: "goal", value: "- from B, blind" },
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
      { verb: "write", id: `E${segmentId}`, field: "decisions", value: "- A ruled first" },
      { callerSessionId: sessionA },
    );

    // B's grant predates A's write — B is stale on `decisions`, and the
    // message names A and points back at recall (distinguishable from
    // never-read by its own text).
    const staleAttempt = resultText(
      rememberTool(
        db,
        { verb: "write", id: `E${segmentId}`, field: "decisions", value: "- B ruled blind" },
        { callerSessionId: sessionB },
      ),
    );
    expect(staleAttempt).toStartWith("Parameter error:");
    expect(staleAttempt).toContain("decisions");
    expect(staleAttempt).toContain(`S${sessionA}`);
    expect(staleAttempt).toContain("recall");
    expect(getSegment(db, segmentId)?.decisions).toBe("- A ruled first");

    // B recalls again, now sees A's write, and may proceed. Uses `edit`
    // (ticket 05's row-add idiom) rather than a second `write`, so the
    // assertion below can still check A's row survived alongside B's.
    recallMemory(db, { id: `E${segmentId}`, readerId: sessionWriterId(sessionB) });
    const retried = resultText(
      rememberTool(
        db,
        {
          verb: "edit",
          id: `E${segmentId}`,
          field: "decisions",
          oldString: "- A ruled first",
          newString: "- A ruled first\n- B ruled after re-reading",
        },
        { callerSessionId: sessionB },
      ),
    );
    expect(retried).toStartWith("Replaced text in");
    expect(getSegment(db, segmentId)?.decisions).toBe(
      "- A ruled first\n- B ruled after re-reading",
    );
  });

  test("a read grant on the segment covers a DIFFERENT field too — entity-level, not per-field", () => {
    const segmentId = createSegmentAs("entity-level-grant");
    rememberTool(
      db,
      { verb: "write", id: `E${segmentId}`, field: "goal", value: "- from A" },
      { callerSessionId: sessionA },
    );
    // B reads the segment card once — it covers every field, not just `goal`.
    recallMemory(db, { id: `E${segmentId}`, readerId: sessionWriterId(sessionB) });

    const text = resultText(
      rememberTool(
        db,
        { verb: "write", id: `E${segmentId}`, field: "goal", value: "- from B, after reading" },
        { callerSessionId: sessionB },
      ),
    );
    expect(text).toStartWith("Wrote");
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
        { verb: "write", id: `E${segmentId}`, field: "goal", value: "- should not land" },
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

// ---------------------------------------------------------------------------
// Ticket 06 (write-mode-edit-semantics spec D2/D5/D6): the segment surface's
// half of "both modes are gated the same, `write` alone also needs a complete
// read". The segment card elides field rows against `pageBudget` (not
// recall's per-item `turn` cap), so this is also where that knob's own remedy
// wording is pinned.
// ---------------------------------------------------------------------------

describe("remember write gate: the complete-read requirement (ticket 06)", () => {
  let db: Database;
  let sessionA: number;
  let sessionB: number;
  let segmentId: number;

  const LONG_DECISIONS = Array.from(
    { length: 40 },
    (_, i) => `- decision ${i}: a sentence long enough to make the card's ladder work`,
  ).join("\n");

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionA = upsertSession(db, {
      contentSessionId: "complete-read-a",
      project: "/tmp/complete-read",
      title: null,
      insight: null,
      createdAtEpoch: 100,
      updatedAtEpoch: 100,
      completedAtEpoch: null,
    }).id;
    sessionB = upsertSession(db, {
      contentSessionId: "complete-read-b",
      project: "/tmp/complete-read",
      title: null,
      insight: null,
      createdAtEpoch: 100,
      updatedAtEpoch: 100,
      completedAtEpoch: null,
    }).id;

    segmentId = Number(
      /Created E(\d+)/.exec(
        resultText(
          rememberTool(db, { verb: "create", title: "Complete-read lane" }, { callerSessionId: sessionA }),
        ),
      )![1],
    );
    // A owns both fields: one long, one short.
    rememberTool(
      db,
      { verb: "write", id: `E${segmentId}`, field: "decisions", value: LONG_DECISIONS },
      { callerSessionId: sessionA },
    );
    rememberTool(
      db,
      { verb: "write", id: `E${segmentId}`, field: "goal", value: "- ship the gate" },
      { callerSessionId: sessionA },
    );
  });

  afterEach(() => {
    db.close();
  });

  /** B reads the card under a budget too small to deliver `decisions` whole. */
  function readTruncated(): void {
    recallMemory(db, {
      id: `E${segmentId}`,
      pageBudget: 60,
      readerId: sessionWriterId(sessionB),
    });
  }

  test("a truncated card refuses the whole-field write, names the field, and names the budget that would fix it", () => {
    readTruncated();

    const refused = resultText(
      rememberTool(
        db,
        { verb: "write", id: `E${segmentId}`, field: "decisions", value: "- B's single decision" },
        { callerSessionId: sessionB },
      ),
    );

    expect(refused).toStartWith("Parameter error:");
    expect(refused).toContain("decisions");
    expect(refused).toContain(`E${segmentId}`);
    // The card's own knob, not recall's per-item `turn` cap — a writer sent
    // to the wrong knob would re-read forever.
    expect(refused).toContain("pageBudget");
    expect(getSegment(db, segmentId)?.decisions).toBe(LONG_DECISIONS);

    // Reading it whole is what clears the rejection.
    recallMemory(db, {
      id: `E${segmentId}`,
      pageBudget: 8000,
      readerId: sessionWriterId(sessionB),
    });
    const admitted = resultText(
      rememberTool(
        db,
        { verb: "write", id: `E${segmentId}`, field: "decisions", value: "- B's single decision" },
        { callerSessionId: sessionB },
      ),
    );
    expect(admitted).toStartWith("Wrote");
    expect(getSegment(db, segmentId)?.decisions).toBe("- B's single decision");
  });

  test("under that SAME truncated card an `edit` is admitted", () => {
    readTruncated();

    const text = resultText(
      rememberTool(
        db,
        {
          verb: "edit",
          id: `E${segmentId}`,
          field: "decisions",
          oldString: "- decision 0: a sentence long enough to make the card's ladder work",
          newString: "- decision 0: rewritten by B",
        },
        { callerSessionId: sessionB },
      ),
    );

    expect(text).toStartWith("Replaced text in");
    const stored = getSegment(db, segmentId)!.decisions!;
    expect(stored).toContain("- decision 0: rewritten by B");
    // The rows B's read never showed survive — the reason `edit` needs no
    // complete read in the first place.
    expect(stored).toContain("- decision 39");
  });

  test("the long field's truncation does not block the short field's write on the same card", () => {
    readTruncated();

    const shortWrite = resultText(
      rememberTool(
        db,
        { verb: "write", id: `E${segmentId}`, field: "goal", value: "- ship the gate, then rest" },
        { callerSessionId: sessionB },
      ),
    );

    expect(shortWrite).toStartWith("Wrote");
    expect(getSegment(db, segmentId)?.goal).toBe("- ship the gate, then rest");
  });

  test("clearing a field to null is exempt from the requirement — an empty field has nothing to lose", () => {
    readTruncated();
    // A clears the long field. B's grant is now stale on `decisions`...
    rememberTool(
      db,
      { verb: "write", id: `E${segmentId}`, field: "decisions", value: null },
      { callerSessionId: sessionA },
    );
    // ...so B re-reads (the field is empty now, so nothing is truncated),
    // then writes it whole. The completeness requirement never applies: the
    // field holds nothing.
    recallMemory(db, {
      id: `E${segmentId}`,
      pageBudget: 60,
      readerId: sessionWriterId(sessionB),
    });

    const text = resultText(
      rememberTool(
        db,
        { verb: "write", id: `E${segmentId}`, field: "decisions", value: "- B starts it over" },
        { callerSessionId: sessionB },
      ),
    );
    expect(text).toStartWith("Wrote");
    expect(getSegment(db, segmentId)?.decisions).toBe("- B starts it over");
  });

  test("an `edit` success stamps the field — the next writer is judged stale against it", () => {
    // Both sessions hold a complete read of the card.
    recallMemory(db, { id: `E${segmentId}`, pageBudget: 8000, readerId: sessionWriterId(sessionA) });
    recallMemory(db, { id: `E${segmentId}`, pageBudget: 8000, readerId: sessionWriterId(sessionB) });

    const edited = resultText(
      rememberTool(
        db,
        {
          verb: "edit",
          id: `E${segmentId}`,
          field: "goal",
          oldString: "- ship the gate",
          newString: "- ship the gate (B)",
        },
        { callerSessionId: sessionB },
      ),
    );
    expect(edited).toStartWith("Replaced text in");

    // A's grant predates B's edit: both of A's modes are now refused as
    // stale, naming B.
    const staleWrite = resultText(
      rememberTool(
        db,
        { verb: "write", id: `E${segmentId}`, field: "goal", value: "- A overrides" },
        { callerSessionId: sessionA },
      ),
    );
    const staleEdit = resultText(
      rememberTool(
        db,
        {
          verb: "edit",
          id: `E${segmentId}`,
          field: "goal",
          oldString: "- ship the gate (B)",
          newString: "- ship the gate (A)",
        },
        { callerSessionId: sessionA },
      ),
    );

    for (const text of [staleWrite, staleEdit]) {
      expect(text).toStartWith("Parameter error:");
      expect(text).toContain("goal");
      expect(text).toContain(`S${sessionB}`);
    }
    expect(getSegment(db, segmentId)?.goal).toBe("- ship the gate (B)");
  });
});

// Ticket 13 (spec "节奏与建段指导"), verb scope narrowed by ticket 09 and
// renamed by ticket 05 (both spec "write-mode-edit-semantics"): every
// successful FIELD-WRITING `remember` call — `create`, `write`, `edit` —
// stamps
// `sessions.last_remember_turn_id` — the session's MAX turn row id at that
// moment (0 when no turn exists yet), the anchor `hooks/note-reminder.ts`'s
// universal 20-turn check counts turns after. `attach`/`close`/`assign` do
// NOT stamp it: none of them writes a segment field. A turn ID, not an epoch
// (0.12.1): second-granularity timestamps cannot order same-second turns
// against the call. A parameter-error call must not reset that clock either:
// nothing was checked or written, so it is not a "call" for this purpose.
describe("last_remember_turn_id stamp (ticket 13, id anchor 0.12.1)", () => {
  let db: Database;
  let sessionId: number;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionId = upsertSession(db, {
      contentSessionId: "remember-cadence-session",
      project: "/tmp/project-remember-cadence",
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

  test("a successful create stamps the caller session's MAX turn id — same-second turns still count as after it", () => {
    expect(getSession(db, sessionId)?.lastRememberTurnId).toBeNull();

    const anchorTurn = db
      .query<{ id: number }, [number]>(
        `INSERT INTO turns (session_id, prompt_number, status, created_at_epoch)
         VALUES (?, 1, 'active', 5000) RETURNING id`,
      )
      .get(sessionId)!.id;

    rememberTool(
      db,
      { verb: "create", title: "stamps the clock" },
      { callerSessionId: sessionId, now: () => 5000 },
    );

    expect(getSession(db, sessionId)?.lastRememberTurnId).toBe(anchorTurn);

    // The peer-round-2 regression shape: a turn created in the SAME second as
    // the remember call, but with a newer row, must count as "after" it.
    db.query<unknown, [number]>(
      `INSERT INTO turns (session_id, prompt_number, status, created_at_epoch)
       VALUES (?, 2, 'active', 5000)`,
    ).run(sessionId);
    expect(
      countTurnsAfterTurnId(db, sessionId, getSession(db, sessionId)!.lastRememberTurnId!),
    ).toBe(1);
  });

  test("a call before any turn exists anchors at 0, so every future turn counts", () => {
    rememberTool(
      db,
      { verb: "create", title: "pre-turn call" },
      { callerSessionId: sessionId, now: () => 5000 },
    );
    expect(getSession(db, sessionId)?.lastRememberTurnId).toBe(0);
  });

  test("a rejected call (Parameter error) does not stamp anything", () => {
    const result = rememberTool(
      db,
      { verb: "create" }, // missing required `title`
      { callerSessionId: sessionId, now: () => 5000 },
    );

    expect(resultText(result)).toContain("Parameter error:");
    expect(getSession(db, sessionId)?.lastRememberTurnId).toBeNull();
  });

  test("write also stamps it — a field-writing verb resets the clock same as create", () => {
    const created = rememberTool(db, {
      verb: "create",
      title: "target segment",
    });
    const segmentId = /Created E(\d+)/.exec(resultText(created))![1];

    rememberTool(
      db,
      { verb: "write", id: `E${segmentId}`, field: "goal", value: "- a goal row" },
      { callerSessionId: sessionId, now: () => 6000 },
    );

    expect(getSession(db, sessionId)?.lastRememberTurnId).toBe(0);
  });

  test("edit also stamps it — the other field-writing verb resets the clock too", () => {
    const created = rememberTool(db, {
      verb: "create",
      title: "target segment for edit",
      goal: "seed row",
    });
    const segmentId = /Created E(\d+)/.exec(resultText(created))![1];

    rememberTool(
      db,
      {
        verb: "edit",
        id: `E${segmentId}`,
        field: "goal",
        oldString: "- seed row",
        newString: "- revised row",
      },
      { callerSessionId: sessionId, now: () => 6000 },
    );

    expect(getSession(db, sessionId)?.lastRememberTurnId).toBe(0);
  });

  test("attach/close/assign do NOT stamp the clock — none of them writes a segment field", () => {
    const created = rememberTool(db, { verb: "create", title: "verb-scoped clock" });
    const segmentId = /Created E(\d+)/.exec(resultText(created))![1];

    // A field write anchors the clock at the turn existing at that moment.
    const fieldWriteTurn = db
      .query<{ id: number }, [number]>(
        `INSERT INTO turns (session_id, prompt_number, status, created_at_epoch)
         VALUES (?, 1, 'active', 5000) RETURNING id`,
      )
      .get(sessionId)!.id;
    rememberTool(
      db,
      { verb: "write", id: `E${segmentId}`, field: "goal", value: "- field write" },
      { callerSessionId: sessionId, now: () => 5000 },
    );
    expect(getSession(db, sessionId)?.lastRememberTurnId).toBe(fieldWriteTurn);

    // A newer turn lands, then attach/close/assign all succeed in a row — if
    // any of them incorrectly touched the clock, it would move to this turn's
    // (newer) id instead of staying pinned at the field write above.
    db.query<unknown, [number]>(
      `INSERT INTO turns (session_id, prompt_number, status, created_at_epoch)
       VALUES (?, 2, 'active', 6000)`,
    ).run(sessionId);

    rememberTool(
      db,
      { verb: "attach", id: `E${segmentId}` },
      { callerSessionId: sessionId, now: () => 7000 },
    );
    expect(getSession(db, sessionId)?.lastRememberTurnId).toBe(fieldWriteTurn);

    rememberTool(
      db,
      { verb: "close", id: `E${segmentId}` },
      { callerSessionId: sessionId, now: () => 7000 },
    );
    expect(getSession(db, sessionId)?.lastRememberTurnId).toBe(fieldWriteTurn);

    rememberTool(
      db,
      { verb: "assign", id: `E${segmentId}`, turns: [`S${sessionId}/T2`] },
      { callerSessionId: sessionId, now: () => 7000 },
    );
    expect(getSession(db, sessionId)?.lastRememberTurnId).toBe(fieldWriteTurn);
  });

  test("without a caller session, nothing is stamped (there is nothing to attribute it to)", () => {
    rememberTool(
      db,
      { verb: "create", title: "no caller session" },
      { now: () => 5000 },
    );

    expect(getSession(db, sessionId)?.lastRememberTurnId).toBeNull();
  });
});
