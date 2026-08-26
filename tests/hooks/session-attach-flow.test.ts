import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import {
  createSegment,
  getAttachedSegmentIds,
  SEGMENT_CONTAINER_ERA_CUTOFF_EPOCH,
} from "../../src/db/segments";
import { upsertSession } from "../../src/db/sessions";
import { createContextHandler } from "../../src/hooks/handlers/context";
import { createSegmentBlockContextHandler } from "../../src/hooks/handlers/context-segments";
import { ATTACHED_SEGMENT_BLOCK_SLOTS } from "../../src/hooks/session-composition";
import type { NormalizedHookInput } from "../../src/hooks/types";
import { noteTool } from "../../src/mcp/note";
import { rememberTool } from "../../src/mcp/remember";

/**
 * lane-model-v12 ticket 17 (spec D3g) — the ONE flow this ticket owns end to
 * end: a session sees the roster and nothing else until it is attached to a
 * segment; attached, that segment's card is injected; and an attachment made
 * mid-conversation can only be answered by the tool's RETURN VALUE, because
 * injection blocks are emitted on SessionStart alone.
 */

const ERA = SEGMENT_CONTAINER_ERA_CUTOFF_EPOCH;

function setup(): {
  db: ReturnType<typeof createDatabase>;
  sessionId: number;
  contentSessionId: string;
  turnId: number;
} {
  const db = createDatabase(":memory:");
  initializeSchema(db);
  const contentSessionId = "attach-flow";
  const session = upsertSession(db, {
    contentSessionId,
    project: "/projects/attach-flow",
    title: "Attach flow",
    insight: null,
    createdAtEpoch: ERA + 10,
    updatedAtEpoch: null,
    completedAtEpoch: null,
  });
  const turn = db
    .query<{ id: number }, [number]>(
      `INSERT INTO turns (
        session_id, prompt_number, status, user_prompt, assistant_response,
        title, created_at_epoch
      ) VALUES (?, 1, 'extracted', 'prompt', 'response', 'A turn', ${ERA + 20})
      RETURNING id`,
    )
    .get(session.id)!;
  return { db, sessionId: session.id, contentSessionId, turnId: turn.id };
}

function sessionStart(
  contentSessionId: string,
  source: NormalizedHookInput["source"] = "resume",
): NormalizedHookInput {
  return {
    eventName: "SessionStart",
    source,
    sessionId: contentSessionId,
    cwd: "/projects/attach-flow",
    stopHookActive: false,
    raw: {},
  };
}

function resultText(result: { content: Array<{ text: string }> }): string {
  return result.content[0]!.text;
}

/** Every segment block the fixed slot pool would emit for this SessionStart. */
async function renderSlots(
  db: ReturnType<typeof createDatabase>,
  input: NormalizedHookInput,
): Promise<string[]> {
  const blocks: string[] = [];
  for (let slot = 1; slot <= ATTACHED_SEGMENT_BLOCK_SLOTS; slot += 1) {
    const fields = await createSegmentBlockContextHandler({ db }, slot, "fields")(input);
    if (fields.hookSpecificOutput) {
      blocks.push(fields.hookSpecificOutput);
    }
  }
  return blocks;
}

describe("ticket 17 — the session's attachment decides which cards it sees", () => {
  test("unattached: the roster is injected and NOT one segment card", async () => {
    const { db, contentSessionId } = setup();
    const segment = createSegment(db, {
      title: "Standing container",
      tags: ["standing"],
      nowEpoch: ERA + 100,
    });

    const input = sessionStart(contentSessionId);
    const roster = await createContextHandler({ db })(input);
    const slots = await renderSlots(db, input);

    // The roster always ships — that is the whole of an unattached session's
    // vocabulary, and it is enough to pick from (spec D3g: "会话开始 → 只看到
    // 花名册").
    expect(roster.hookSpecificOutput).toContain("## Segment roster");
    expect(roster.hookSpecificOutput).toContain(`E${segment.id}`);
    // …and nothing else. No card, from any slot.
    expect(slots).toEqual([]);
    db.close();
  });

  test("attached: THAT segment's card is injected, carrying its own tag", async () => {
    const { db, contentSessionId, sessionId } = setup();
    const attached = createSegment(db, {
      title: "The attached one",
      tags: ["attached-tag"],
      nowEpoch: ERA + 100,
    });
    const other = createSegment(db, {
      title: "The other one",
      tags: ["other-tag"],
      nowEpoch: ERA + 101,
    });
    rememberTool(
      db,
      { verb: "attach", id: `E${attached.id}` },
      { callerSessionId: sessionId },
    );

    const input = sessionStart(contentSessionId);
    const slots = await renderSlots(db, input);

    expect(slots).toHaveLength(1);
    expect(slots[0]).toContain(`[E${attached.id}] · fields`);
    // The segment's own tag rides the card header (spec D3f) — this is the
    // second of the two legal `tags` sources an attached session gains.
    expect(slots[0]).toContain(`[E${attached.id}] #attached-tag`);
    // An unattached segment stays a roster row; attaching one does not open
    // the others.
    expect(slots.join("\n")).not.toContain(`[E${other.id}] · fields`);
    db.close();
  });

  test("detach takes the card away again — the roster row survives", async () => {
    const { db, contentSessionId, sessionId } = setup();
    const segment = createSegment(db, {
      title: "Briefly attached",
      tags: ["brief"],
      nowEpoch: ERA + 100,
    });
    rememberTool(db, { verb: "attach", id: `E${segment.id}` }, { callerSessionId: sessionId });
    expect(await renderSlots(db, sessionStart(contentSessionId))).toHaveLength(1);

    const receipt = resultText(
      rememberTool(db, { verb: "detach", id: `E${segment.id}` }, { callerSessionId: sessionId }),
    );
    expect(receipt).toContain(`Detached S${sessionId} from E${segment.id}`);

    const input = sessionStart(contentSessionId);
    expect(await renderSlots(db, input)).toEqual([]);
    // Detaching cancels the CARD, not the segment: it is still live, still on
    // the roster, still pickable.
    const roster = await createContextHandler({ db })(input);
    expect(roster.hookSpecificOutput).toContain(`E${segment.id}`);
    db.close();
  });

  test("the three-slot cap is unchanged — a fourth attachment renders no fourth card", async () => {
    const { db, contentSessionId, sessionId } = setup();
    const ids: number[] = [];
    for (let index = 1; index <= ATTACHED_SEGMENT_BLOCK_SLOTS + 1; index += 1) {
      const segment = createSegment(db, {
        title: `Container ${index}`,
        tags: [`container-${index}`],
        nowEpoch: ERA + 100 + index,
      });
      rememberTool(db, { verb: "attach", id: `E${segment.id}` }, { callerSessionId: sessionId });
      ids.push(segment.id);
    }

    const slots = await renderSlots(db, sessionStart(contentSessionId));
    expect(ATTACHED_SEGMENT_BLOCK_SLOTS).toBe(3);
    expect(slots).toHaveLength(ATTACHED_SEGMENT_BLOCK_SLOTS);
    // Four attachments, three cards: the pool is fixed and the overflow one
    // gets a roster pointer instead (ticket 10's own contract, untouched here).
    expect(getAttachedSegmentIds(db, sessionId)).toHaveLength(ids.length);
    db.close();
  });
});

describe("ticket 17 — a mid-conversation attachment can only come back as a return value", () => {
  // The decisive mechanical fact behind that claim, pinned at its source:
  // UserPromptSubmit runs session-init and prompt-dispatch, and neither is a
  // `context` entry. There is no injection channel between two SessionStarts,
  // so a card that is not in the tool result is a card the session never sees.
  test("UserPromptSubmit registers no injection (`context`) entry at all", () => {
    const config = JSON.parse(
      readFileSync(join(process.cwd(), "plugin", "hooks", "hooks.json"), "utf8"),
    ) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    const commands =
      config.hooks.UserPromptSubmit?.flatMap((entry) =>
        entry.hooks.map((hook) => hook.command),
      ) ?? [];
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) {
      expect(command).not.toContain("hook-command.cjs context");
    }
  });

  test("remember(attach) returns the card itself, not a pointer to a future injection", () => {
    const { db, sessionId } = setup();
    const segment = createSegment(db, {
      title: "Picked mid-conversation",
      tags: ["mid-pick"],
      nowEpoch: ERA + 100,
    });

    const text = resultText(
      rememberTool(db, { verb: "attach", id: `E${segment.id}` }, { callerSessionId: sessionId }),
    );
    expect(text).toContain(`Attached S${sessionId} to E${segment.id}`);
    expect(text).toContain(`[E${segment.id}] #mid-pick`);
    db.close();
  });
});

describe("ticket 17 auto-attach (ruling [S15069/T1663])", () => {
  test("writing a segment's tag into `tags` attaches the session and returns that segment's card", () => {
    const { db, sessionId } = setup();
    const segment = createSegment(db, {
      title: "Joined by tag",
      tags: ["joined"],
      nowEpoch: ERA + 100,
    });

    const text = resultText(
      noteTool(
        db,
        { turn: `S${sessionId}/T1`, tags: ["joined"] },
        { callerSessionId: sessionId },
      ),
    );

    expect(getAttachedSegmentIds(db, sessionId)).toEqual([segment.id]);
    // The card rides the return value — the whole point of the ruling.
    expect(text).toContain(`[E${segment.id}] #joined`);
    expect(text).toContain("This session is now attached");
    db.close();
  });

  test("the card rides back exactly ONCE — a later tags write on the same segment repeats nothing", () => {
    const { db, sessionId } = setup();
    const segment = createSegment(db, {
      title: "Joined by tag",
      tags: ["joined"],
      nowEpoch: ERA + 100,
    });
    db.query(
      `INSERT INTO turns (
        session_id, prompt_number, status, user_prompt, assistant_response,
        title, created_at_epoch
      ) VALUES (?, 2, 'extracted', 'prompt 2', 'response 2', 'Another turn', ${ERA + 30})`,
    ).run(sessionId);

    noteTool(db, { turn: `S${sessionId}/T1`, tags: ["joined"] }, { callerSessionId: sessionId });
    const second = resultText(
      noteTool(db, { turn: `S${sessionId}/T2`, tags: ["joined"] }, { callerSessionId: sessionId }),
    );

    expect(second).not.toContain("This session is now attached");
    expect(second).not.toContain(`[E${segment.id}] #joined`);
    expect(getAttachedSegmentIds(db, sessionId)).toEqual([segment.id]);
    db.close();
  });

  test("a tags write that leaves the turn unowned attaches nothing", () => {
    const { db, sessionId } = setup();
    createSegment(db, { title: "Not joined", tags: ["not-joined"], nowEpoch: ERA + 100 });

    const text = resultText(
      noteTool(
        db,
        { turn: `S${sessionId}/T1`, title: "t", content: "c" },
        { callerSessionId: sessionId },
      ),
    );

    expect(getAttachedSegmentIds(db, sessionId)).toEqual([]);
    expect(text).not.toContain("This session is now attached");
    db.close();
  });

  test("no caller session, no auto-attach — the write still lands", () => {
    const { db, sessionId } = setup();
    const segment = createSegment(db, {
      title: "Joined by tag",
      tags: ["joined"],
      nowEpoch: ERA + 100,
    });

    const text = resultText(noteTool(db, { turn: `S${sessionId}/T1`, tags: ["joined"] }, {}));

    expect(text).toContain(`Now belongs to E${segment.id}`);
    expect(getAttachedSegmentIds(db, sessionId)).toEqual([]);
    db.close();
  });

  test("auto-attach then detach: the override wins and re-tagging the SAME segment re-attaches", () => {
    const { db, sessionId } = setup();
    const segment = createSegment(db, {
      title: "Joined by tag",
      tags: ["joined"],
      nowEpoch: ERA + 100,
    });
    noteTool(db, { turn: `S${sessionId}/T1`, tags: ["joined"] }, { callerSessionId: sessionId });
    rememberTool(db, { verb: "detach" }, { callerSessionId: sessionId });
    expect(getAttachedSegmentIds(db, sessionId)).toEqual([]);

    // Honest limit of the override, recorded rather than hidden: detach
    // cancels the binding, it does not blacklist the segment. The next tags
    // write on it re-attaches — and, because the binding is new again, the
    // card rides back again. (`mode.tags` is required only because this turn
    // already holds a tag set; a fresh turn needs no mode.)
    const again = resultText(
      noteTool(
        db,
        { turn: `S${sessionId}/T1`, tags: ["joined"], mode: { tags: "write" } },
        { callerSessionId: sessionId },
      ),
    );
    expect(getAttachedSegmentIds(db, sessionId)).toEqual([segment.id]);
    expect(again).toContain("This session is now attached");
    db.close();
  });
});
