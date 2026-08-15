import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeDatabase } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { createSessionInitHandler } from "../../src/hooks/handlers/session-init";
import { recallInputSchema } from "../../src/mcp/definitions";
import {
  createDatabaseBackedHandlers,
  WORKER_TOOL_RESULT_MAX_CHARS,
  WORKER_TOOL_RESULT_TRUNCATION_HINT,
  toTimelineQueryInput,
} from "../../src/mcp/handlers";
import { resolveCallerSessionIdFromEnv } from "../../src/mcp/server";

describe("database-backed MCP handlers", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeDatabase(db);
  });

  afterEach(() => {
    db.close();
  });

  test("recall schema accepts the new surface and rejects removed fields", () => {
    expect(
      recallInputSchema.parse({
        id: "S1/T2",
        depth: "expanded",
        page: 2,
        pageSize: 10,
        truncate: 500,
      }),
    ).toEqual({
      id: "S1/T2",
      depth: "expanded",
      page: 2,
      pageSize: 10,
      truncate: 500,
    });

    expect(() =>
      recallInputSchema.parse({
        id: "S1",
        limit: 10,
      }),
    ).toThrow();
    expect(() =>
      recallInputSchema.parse({
        id: "S1",
        depth: "full",
      }),
    ).toThrow();
  });

  test("routes timeline requests through the database-backed handler set", async () => {
    const handlers = createDatabaseBackedHandlers(db, {
      defaultProject: "claude-mnemo",
    });

    const session = upsertSession(db, {
      contentSessionId: "timeline-session",
      project: "claude-mnemo",
      title: "Timeline fixture",
      insight: null,
      createdAtEpoch: 1_700_000_000,
      updatedAtEpoch: 1_700_000_100,
      completedAtEpoch: null,
    });

    db.query(
      `INSERT INTO turns (
        session_id,
        prompt_number,
        content_prompt_id,
        transcript_line_start,
        status,
        user_prompt,
        assistant_response,
        title,
        content,
        insight,
        type,
        tags,
        files_read,
        files_modified,
        tool_call_count,
        created_at_epoch,
        updated_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      session.id,
      1,
      null,
      null,
      "extracted",
      "Investigate timeline registration",
      null,
      "Wire timeline tool",
      null,
      null,
      JSON.stringify(["change"]),
      JSON.stringify([]),
      JSON.stringify([]),
      JSON.stringify([]),
      1,
      1_700_000_100,
      null,
    );
    db.query(
      `INSERT INTO turns (
        session_id,
        prompt_number,
        content_prompt_id,
        transcript_line_start,
        status,
        user_prompt,
        assistant_response,
        title,
        content,
        insight,
        type,
        tags,
        files_read,
        files_modified,
        tool_call_count,
        created_at_epoch,
        updated_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      session.id,
      2,
      null,
      null,
      "extracted",
      "Investigate timeline pagination",
      null,
      "Page two turn",
      null,
      null,
      JSON.stringify(["change"]),
      JSON.stringify([]),
      JSON.stringify([]),
      JSON.stringify([]),
      1,
      1_700_000_110,
      null,
    );

    const result = await handlers.timeline?.({
      id: `S${session.id}`,
      page: 2,
      pageSize: 1,
    });

    expect(result?.content[0]?.text).toContain("claude-mnemo | 2 turns | 2 tool_calls");
    expect(result?.content[0]?.text).toContain("showing: turns · page 2/2 (2)");
    expect(result?.content[0]?.text).toContain("T2");
    expect(result?.content[0]?.text).not.toContain("T1  ");
  });

  test("worker recall accepts fields beyond 2000, strips private tags, and gates the total result", async () => {
    const visible = "v".repeat(3_000);
    const session = upsertSession(db, {
      contentSessionId: "worker-long-recall",
      project: "claude-mnemo",
      title: "Long worker recall",
      content: `${visible}<private>hidden</private>`,
      insight: null,
      createdAtEpoch: 1,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });
    const worker = createDatabaseBackedHandlers(db, { audience: "worker" });
    const longResult = await worker.recall?.({
      id: `S${session.id}`,
      depth: "expanded",
      truncate: 5_000,
    });
    expect(longResult?.content[0]?.text).toContain(visible);
    expect(longResult?.content[0]?.text).not.toContain("hidden");

    db.query("UPDATE sessions SET content = ? WHERE id = ?").run(
      "x".repeat(WORKER_TOOL_RESULT_MAX_CHARS + 10_000),
      session.id,
    );
    const capped = await worker.recall?.({
      id: `S${session.id}`,
      depth: "expanded",
      truncate: WORKER_TOOL_RESULT_MAX_CHARS + 10_000,
    });
    expect(capped?.content[0]?.text.length).toBe(WORKER_TOOL_RESULT_MAX_CHARS);
    expect(capped?.content[0]?.text).toEndWith(WORKER_TOOL_RESULT_TRUNCATION_HINT);
  });

  test("timeline handler input forwards view enum and drops removed flags", () => {
    expect(
      toTimelineQueryInput({
        id: "S42/T10..30",
        page: 2,
        pageSize: 10,
        view: "milestones",
        milestones: true,
        phases: false,
      }),
    ).toEqual({
      id: "S42/T10..30",
      page: 2,
      pageSize: 10,
      view: "milestones",
    });
  });

  describe("note's caller identity option (spec D2)", () => {
    let sessionId: number;
    let otherSessionId: number;
    let otherTurnId: number;

    beforeEach(() => {
      sessionId = upsertSession(db, {
        contentSessionId: "handlers-identity-caller",
        project: "claude-mnemo",
        title: null,
        content: null,
        insight: null,
        createdAtEpoch: 1,
        updatedAtEpoch: 1,
        completedAtEpoch: null,
      }).id;
      otherSessionId = upsertSession(db, {
        contentSessionId: "handlers-identity-other",
        project: "claude-mnemo",
        title: null,
        content: null,
        insight: null,
        createdAtEpoch: 1,
        updatedAtEpoch: 1,
        completedAtEpoch: null,
      }).id;
      otherTurnId = db
        .query<{ id: number }, [number]>(
          `INSERT INTO turns (session_id, prompt_number, status, user_prompt, created_at_epoch)
           VALUES (?, 1, 'active', 'their current turn', 1) RETURNING id`,
        )
        .get(otherSessionId)!.id;
    });

    // Pinned: a worker tool channel calls this same factory (see
    // note-settlement-sdk-query.ts, diary-agent-tools.ts) and inherits the
    // hook's process environment wholesale. If `note` ever read identity from
    // process.env directly instead of this explicit option, a worker process
    // would silently "look like" whichever session its host hook belonged to.
    // The factory default (no `resolveCallerSessionId`) must keep identity
    // unknown so a cross-session write is never wrongly blocked here.
    test("no resolveCallerSessionId option (the worker/default shape) leaves identity unknown", async () => {
      // The environment is made to resolve — a mapping is on record for exactly
      // the keys this process holds — so the assertion below fails the moment
      // anything on the note path reaches for process.env on its own, rather
      // than passing vacuously because nothing could have resolved anyway.
      const socket = "/tmp/cc-socks/worker-host.sock";
      const previousSocket = process.env.CLAUDE_CODE_MESSAGING_SOCKET;
      const previousSessionVar = process.env.CLAUDE_CODE_SESSION_ID;
      process.env.CLAUDE_CODE_MESSAGING_SOCKET = socket;
      process.env.CLAUDE_CODE_SESSION_ID = "worker-host-session";

      try {
        await createSessionInitHandler({ db, env: { ...process.env } })({
          eventName: "UserPromptSubmit",
          sessionId: "handlers-identity-caller",
          cwd: "/Users/zhaoqixuan/Projects/claude-mnemo",
          prompt: "the host hook's prompt",
          stopHookActive: false,
          raw: {},
        });
        expect(resolveCallerSessionIdFromEnv(db, process.env)).toBe(sessionId);

        const handlers = createDatabaseBackedHandlers(db, { audience: "worker" });

        const result = await handlers.note!({
          turn: `S${otherSessionId}/T1`,
          title: "t",
          content: "c",
        });

        expect(result.content[0]?.text).toStartWith("Noted ");
      } finally {
        if (previousSocket === undefined) {
          delete process.env.CLAUDE_CODE_MESSAGING_SOCKET;
        } else {
          process.env.CLAUDE_CODE_MESSAGING_SOCKET = previousSocket;
        }
        if (previousSessionVar === undefined) {
          delete process.env.CLAUDE_CODE_SESSION_ID;
        } else {
          process.env.CLAUDE_CODE_SESSION_ID = previousSessionVar;
        }
      }
    });

    test("a foreign turn that owes nothing is refused for being foreign, and the flag gets past that", async () => {
      // The commonest foreign address of all: another session's FINISHED turn.
      // It owes no note, so behind the debt check the identity guard was
      // unreachable — the call came back "owes no note", which names the wrong
      // problem, and `crossSession: true` could not get past it either, leaving
      // the documented escape hatch inoperable for this whole class.
      db.query<unknown, [number]>(
        `INSERT INTO turns (session_id, prompt_number, status, user_prompt, created_at_epoch)
         VALUES (?, 0, 'extracted', 'their finished turn', 1)`,
      ).run(otherSessionId);
      const handlers = createDatabaseBackedHandlers(db, {
        resolveCallerSessionId: () => sessionId,
      });

      const refused = await handlers.note!({
        turn: `S${otherSessionId}/T0`,
        title: "t",
        content: "c",
      });
      expect(refused.content[0]?.text).toContain("crossSession: true");

      // Declaring it clears the identity guard. What answers now is the
      // debt rule, on its own terms — a different refusal, honestly named.
      const declared = await handlers.note!({
        turn: `S${otherSessionId}/T0`,
        title: "t",
        content: "c",
        crossSession: true,
      });
      expect(declared.content[0]?.text).not.toContain("crossSession: true");
    });

    test("a resumed session's real environment refuses a foreign turn, and the flag gets past it", async () => {
      // End to end through the production wiring: the UserPromptSubmit hook
      // records the mapping from its own environment, the MCP entry point's
      // resolver reads it from a DIFFERENT one — same messaging socket, a stale
      // session id snapshotted when the server was spawned — and `note` gets
      // the identity that comes out. This is the shape in which the guard was
      // measured inert: the address was refused for owing no note, which is a
      // true statement about the wrong problem.
      await createSessionInitHandler({
        db,
        env: {
          CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/cc-socks/52426.sock",
          CLAUDE_CODE_SESSION_ID: "resumed-conversation-id",
        },
      })({
        eventName: "UserPromptSubmit",
        sessionId: "handlers-identity-caller",
        cwd: "/Users/zhaoqixuan/Projects/claude-mnemo",
        prompt: "the caller's own prompt",
        stopHookActive: false,
        raw: {},
      });

      const mcpEnv = {
        CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/cc-socks/52426.sock",
        CLAUDE_CODE_SESSION_ID: "boot-id-frozen-at-spawn",
      };
      expect(resolveCallerSessionIdFromEnv(db, mcpEnv)).toBe(sessionId);

      const handlers = createDatabaseBackedHandlers(db, {
        resolveCallerSessionId: () => resolveCallerSessionIdFromEnv(db, mcpEnv),
      });

      const refused = await handlers.note!({
        turn: `S${otherSessionId}/T1`,
        title: "t",
        content: "c",
      });
      expect(refused.content[0]?.text).toStartWith("Parameter error:");
      expect(refused.content[0]?.text).toContain("belongs to a different session");
      expect(refused.content[0]?.text).toContain("crossSession: true");

      const declared = await handlers.note!({
        turn: `S${otherSessionId}/T1`,
        title: "t",
        content: "c",
        crossSession: true,
      });
      expect(declared.content[0]?.text).toStartWith("Noted ");
    });

    test("a supplied resolveCallerSessionId is read fresh on every note call", async () => {
      let current = sessionId;
      const handlers = createDatabaseBackedHandlers(db, {
        resolveCallerSessionId: () => current,
      });

      const blocked = await handlers.note!({
        turn: `S${otherSessionId}/T1`,
        title: "t",
        content: "c",
      });
      expect(blocked.content[0]?.text).toStartWith("Parameter error:");
      expect(blocked.content[0]?.text).toContain("crossSession: true");

      // Simulates the resolver picking up a mapping row written after these
      // handlers were constructed (spec: the MCP server can connect before
      // the session's first UserPromptSubmit hook runs).
      current = otherSessionId;
      const allowed = await handlers.note!({
        turn: `S${otherSessionId}/T1`,
        title: "t",
        content: "c",
      });
      expect(allowed.content[0]?.text).toStartWith("Noted ");
    });
  });
});
