import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import {
  deriveProcessIdentityKeys,
  getMnemoSessionIdForProcessSession,
  upsertProcessSessionMap,
} from "../../src/db/process-session-map";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";

describe("process-session identity map (spec D1)", () => {
  let db: Database;
  let sessionId: number;
  let otherSessionId: number;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);

    sessionId = upsertSession(db, {
      contentSessionId: "content-a",
      project: "claude-mnemo",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 100,
      updatedAtEpoch: 100,
      completedAtEpoch: null,
    }).id;
    otherSessionId = upsertSession(db, {
      contentSessionId: "content-b",
      project: "claude-mnemo",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 100,
      updatedAtEpoch: 100,
      completedAtEpoch: null,
    }).id;
  });

  afterEach(() => {
    db.close();
  });

  test("an unrecorded identity key reads as unknown", () => {
    expect(getMnemoSessionIdForProcessSession(db, "never-seen")).toBeNull();
  });

  test("records a fresh mapping", () => {
    upsertProcessSessionMap(db, "proc-1", sessionId, 100);
    expect(getMnemoSessionIdForProcessSession(db, "proc-1")).toBe(sessionId);
  });

  test("re-upserting the same identity key moves it to a different session", () => {
    // The one-key-to-one-session invariant, and the whole of the pid-reuse
    // story: a later upsert overwrites rather than erroring or accumulating,
    // so a live session claiming a dead one's key takes it outright.
    upsertProcessSessionMap(db, "proc-1", sessionId, 100);
    upsertProcessSessionMap(db, "proc-1", otherSessionId, 200);

    expect(getMnemoSessionIdForProcessSession(db, "proc-1")).toBe(
      otherSessionId,
    );
  });

  test("a session can be mapped from more than one identity key", () => {
    upsertProcessSessionMap(db, "proc-before", sessionId, 100);
    upsertProcessSessionMap(db, "proc-after", sessionId, 200);

    expect(getMnemoSessionIdForProcessSession(db, "proc-before")).toBe(
      sessionId,
    );
    expect(getMnemoSessionIdForProcessSession(db, "proc-after")).toBe(
      sessionId,
    );
  });

  test("a session's rows are dropped when the session is deleted", () => {
    upsertProcessSessionMap(db, "proc-1", sessionId, 100);
    db.query("DELETE FROM sessions WHERE id = ?").run(sessionId);

    expect(getMnemoSessionIdForProcessSession(db, "proc-1")).toBeNull();
  });
});

describe("deriveProcessIdentityKeys", () => {
  test("the socket key comes before the session key", () => {
    // Order is the whole contract with the reader, which takes the first hit:
    // the socket holds the identical string in both processes, the session
    // variable only on a session that was never resumed.
    const keys = deriveProcessIdentityKeys({
      CLAUDE_CODE_SESSION_ID: "conversation-id",
      CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/cc-socks/52426.sock",
    });

    expect(keys).toHaveLength(2);
    expect(keys[0]).toContain("/tmp/cc-socks/52426.sock");
    expect(keys[1]).toContain("conversation-id");
  });

  test("a socket path and a session id carrying the same string do not collide", () => {
    // Both land in one TEXT primary-key column, so the source has to be part of
    // the key — otherwise a session id that happened to equal a socket path
    // would silently claim its row.
    const [socketKey, sessionKey] = deriveProcessIdentityKeys({
      CLAUDE_CODE_MESSAGING_SOCKET: "identical",
      CLAUDE_CODE_SESSION_ID: "identical",
    });

    expect(socketKey).not.toBe(sessionKey);
  });

  test("only the variables actually present yield keys", () => {
    expect(
      deriveProcessIdentityKeys({ CLAUDE_CODE_SESSION_ID: "only-this" }),
    ).toHaveLength(1);
    expect(
      deriveProcessIdentityKeys({
        CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/cc-socks/1.sock",
      }),
    ).toHaveLength(1);
  });

  test("an unrecognised or blank environment yields nothing", () => {
    // Deriving nothing is a supported case on both sides: the hook writes no
    // row and the reader resolves unknown, which admits. A blank value is
    // treated as absent rather than as a key every blank environment shares.
    expect(deriveProcessIdentityKeys({})).toEqual([]);
    expect(deriveProcessIdentityKeys({ SOME_OTHER_VAR: "x" })).toEqual([]);
    expect(
      deriveProcessIdentityKeys({
        CLAUDE_CODE_MESSAGING_SOCKET: "",
        CLAUDE_CODE_SESSION_ID: "   ",
      }),
    ).toEqual([]);
  });
});
