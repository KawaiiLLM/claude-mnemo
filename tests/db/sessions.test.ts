import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { getOutgoingEdges, writeMemoryEdges } from "../../src/db/memory-edges";
import { recordNoteIdExposure } from "../../src/db/note-debt";
import { initializeSchema } from "../../src/db/schema";
import {
  getRecentSessions,
  getSession,
  getSessionByContentId,
  setSessionTranscriptPathIfAbsent,
  updateCompactAnchor,
  updateSessionSummaryRewrite,
  upsertSession,
} from "../../src/db/sessions";

describe("session queries", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  test("upsert creates a new session and reads it back", () => {
    const session = upsertSession(db, {
      contentSessionId: "content-1",
      project: "claude-mnemo",
      title: "Auth fixes",
      content: "Investigated and fixed token refresh issues",
      insight: "- race condition reproduced",
      nextSteps: "- verify refresh token rotation",
      createdAtEpoch: 100,
      updatedAtEpoch: 110,
      completedAtEpoch: 120,
    });

    expect(session.id).toBeNumber();
    expect(getSession(db, session.id)).toEqual(session);
    expect(getSessionByContentId(db, "content-1")).toEqual(session);
  });

  test("upsert updates an existing session instead of inserting a second row", () => {
    const created = upsertSession(db, {
      contentSessionId: "content-2",
      project: "claude-mnemo",
      title: "Initial title",
      content: "Initial description",
      insight: "- first insight",
      nextSteps: "- draft follow-up",
      createdAtEpoch: 200,
      updatedAtEpoch: 210,
      completedAtEpoch: null,
    });

    const updated = upsertSession(db, {
      contentSessionId: "content-2",
      project: "claude-mnemo",
      title: "Updated title",
      content: "Updated description",
      insight: "- updated insight",
      createdAtEpoch: 200,
      updatedAtEpoch: 260,
      completedAtEpoch: 300,
    });

    const rowCount = db
      .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM sessions")
      .get().count;

    expect(updated.id).toBe(created.id);
    expect(updated.title).toBe("Updated title");
    expect(updated.content).toBe("Updated description");
    expect(updated.insight).toBe("- updated insight");
    expect(updated.updatedAtEpoch).toBe(260);
    expect(updated.completedAtEpoch).toBe(300);
    expect(rowCount).toBe(1);
  });

  test("keeps the first transcript path across a cwd change while project follows the latest cwd", () => {
    const created = upsertSession(db, {
      contentSessionId: "content-drift",
      project: "/Users/me/alpha",
      transcriptPath: "/Users/me/.claude/projects/-Users-me-alpha/content-drift.jsonl",
      title: null,
      insight: null,
      createdAtEpoch: 400,
      updatedAtEpoch: 400,
      completedAtEpoch: null,
    });

    // Same session, later prompt, different cwd — and Claude Code keeps writing
    // the transcript into the STARTING cwd's directory.
    const afterCd = upsertSession(db, {
      contentSessionId: "content-drift",
      project: "/Users/me/beta",
      transcriptPath: "/Users/me/.claude/projects/-Users-me-beta/content-drift.jsonl",
      title: null,
      insight: null,
      createdAtEpoch: 400,
      updatedAtEpoch: 410,
      completedAtEpoch: null,
    });

    expect(afterCd.id).toBe(created.id);
    expect(afterCd.project).toBe("/Users/me/beta");
    expect(afterCd.transcriptPath).toBe(
      "/Users/me/.claude/projects/-Users-me-alpha/content-drift.jsonl",
    );

    // An upsert that carries no transcript path at all cannot clear it either.
    const withoutPath = upsertSession(db, {
      contentSessionId: "content-drift",
      project: "/Users/me/gamma",
      title: null,
      insight: null,
      createdAtEpoch: 400,
      updatedAtEpoch: 420,
      completedAtEpoch: null,
    });

    expect(withoutPath.transcriptPath).toBe(
      "/Users/me/.claude/projects/-Users-me-alpha/content-drift.jsonl",
    );
  });

  test("fills the transcript path only while it is absent", () => {
    const created = upsertSession(db, {
      contentSessionId: "content-late-path",
      project: "/Users/me/alpha",
      title: null,
      insight: null,
      createdAtEpoch: 500,
      updatedAtEpoch: 500,
      completedAtEpoch: null,
    });

    expect(created.transcriptPath).toBeNull();
    expect(setSessionTranscriptPathIfAbsent(db, created.id, "/first.jsonl")).toBe(
      true,
    );
    expect(setSessionTranscriptPathIfAbsent(db, created.id, "/second.jsonl")).toBe(
      false,
    );
    expect(getSession(db, created.id)?.transcriptPath).toBe("/first.jsonl");
  });

  test("preserves nextSteps when an update omits it", () => {
    const created = upsertSession(db, {
      contentSessionId: "content-8",
      project: "claude-mnemo",
      title: "Initial title",
      content: "Initial description",
      insight: "- first insight",
      nextSteps: "- keep working",
      createdAtEpoch: 300,
      updatedAtEpoch: 310,
      completedAtEpoch: null,
    });

    const updated = upsertSession(db, {
      contentSessionId: "content-8",
      project: "claude-mnemo",
      title: "Updated title",
      content: "Updated description",
      insight: "- updated insight",
      createdAtEpoch: 300,
      updatedAtEpoch: 360,
      completedAtEpoch: null,
    });

    expect(updated.id).toBe(created.id);
    expect(updated.nextSteps).toBe("- keep working");
  });

  test("getRecentSessions orders by createdAtEpoch descending", () => {
    upsertSession(db, {
      contentSessionId: "content-3",
      project: "claude-mnemo",
      title: "Earlier",
      content: "Earlier work",
      insight: null,
      createdAtEpoch: 100,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });

    upsertSession(db, {
      contentSessionId: "content-4",
      project: "claude-mnemo",
      title: "Latest",
      content: "Later work",
      insight: null,
      createdAtEpoch: 400,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });

    upsertSession(db, {
      contentSessionId: "content-5",
      project: "claude-mnemo",
      title: "Middle",
      content: "Middle work",
      insight: null,
      createdAtEpoch: 250,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });

    const sessions = getRecentSessions(db);

    expect(sessions.map((session) => session.contentSessionId)).toEqual([
      "content-4",
      "content-5",
      "content-3",
    ]);
  });

  test("getRecentSessions filters by project", () => {
    upsertSession(db, {
      contentSessionId: "content-6",
      project: "claude-mnemo",
      title: "Mnemo work",
      content: "Memory feature work",
      insight: null,
      createdAtEpoch: 100,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });

    upsertSession(db, {
      contentSessionId: "content-7",
      project: "other-project",
      title: "Other work",
      content: "Something else",
      insight: null,
      createdAtEpoch: 200,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });

    const sessions = getRecentSessions(db, { project: "claude-mnemo" });

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.contentSessionId).toBe("content-6");
  });

  test("updateCompactAnchor ignores active turns and anchors on the latest finalized turn", () => {
    const session = upsertSession(db, {
      contentSessionId: "content-9",
      project: "claude-mnemo",
      title: "Anchor test",
      content: "Anchor content",
      insight: null,
      createdAtEpoch: 100,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });

    db.query(
      `INSERT INTO turns (
        session_id, prompt_number, status, user_prompt, created_at_epoch
      ) VALUES
        (?, 1, 'extracted', 'first', 110),
        (?, 2, 'undone', 'second', 120),
        (?, 3, 'active', 'third', 130)`,
    ).run(session.id, session.id, session.id);

    updateCompactAnchor(db, session.id);

    expect(getSession(db, session.id)?.lastCompactTurn).toBe(2);
  });

  test("updateCompactAnchor does not advance past a provisional (not-yet-finalized) turn", () => {
    const session = upsertSession(db, {
      contentSessionId: "content-10",
      project: "claude-mnemo",
      title: "Provisional anchor test",
      content: null,
      insight: null,
      createdAtEpoch: 100,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });

    db.query(
      `INSERT INTO turns (
        session_id, prompt_number, status, user_prompt, created_at_epoch
      ) VALUES
        (?, 1, 'extracted', 'first', 110),
        (?, 2, 'provisional', 'second', 120),
        (?, 3, 'active', 'third', 130)`,
    ).run(session.id, session.id, session.id);

    updateCompactAnchor(db, session.id);

    // provisional (T2) and active (T3) are both in-progress re-extraction
    // targets; the anchor must stay on the last finalized turn (T1).
    expect(getSession(db, session.id)?.lastCompactTurn).toBe(1);
  });

  // Spec C6/C10: a session field can carry a bare `[S<session>/T<n>]`
  // citation, same grammar as a turn or segment body — `updateSessionSummaryRewrite`
  // is the ONE session write path (spec D2), so it is where the recompute lives.
  describe("cited pairs from a session summary (spec C6/C10)", () => {
    function seedSessionAndTurn(): { sessionId: number; turnId: number } {
      const session = upsertSession(db, {
        contentSessionId: "session-cites",
        project: "claude-mnemo",
        title: null,
        content: null,
        insight: null,
        createdAtEpoch: 100,
        updatedAtEpoch: null,
        completedAtEpoch: null,
      });
      const turnId = db
        .query<{ id: number }, [number]>(
          `INSERT INTO turns (session_id, prompt_number, status, created_at_epoch)
           VALUES (?, 1, 'extracted', 100) RETURNING id`,
        )
        .get(session.id)!.id;
      // The recompute's writer-session IS the session being written (a
      // session states nothing about anyone else's exposure ledger), so its
      // own citations are exposure-gated the same way a note's are.
      recordNoteIdExposure(db, {
        sessionId: session.id,
        rideTurnId: turnId,
        exposedTurnIds: [turnId],
        source: "reminder",
        nowEpoch: 100,
      });
      return { sessionId: session.id, turnId };
    }

    const emptySummary = {
      title: "",
      content: "",
      decision: "",
      done: "",
      current: "",
      nextSteps: "",
      reference: "",
    };

    test("a bare qualified reference in ANY summary field creates an unattributed pair", () => {
      const { sessionId, turnId } = seedSessionAndTurn();

      updateSessionSummaryRewrite(
        db,
        sessionId,
        { ...emptySummary, decision: `Chose the fold-in over a rewrite, per [S${sessionId}/T1].` },
        200,
      );

      expect(
        getOutgoingEdges(db, { kind: "session", id: sessionId }),
      ).toEqual([
        {
          citing: { kind: "session", id: sessionId },
          cited: { kind: "turn", id: turnId },
          relation: null,
          provenance: "text-ref",
          createdAtEpoch: 200,
        },
      ]);
    });

    // Acceptance criterion 3 (session side): the rewrite-drops-citation
    // sequence, relation included.
    test("a rewrite that drops a reference drops its pair and any relation it carried", () => {
      const { sessionId, turnId } = seedSessionAndTurn();
      const other = db
        .query<{ id: number }, [number]>(
          `INSERT INTO turns (session_id, prompt_number, status, created_at_epoch)
           VALUES (?, 2, 'extracted', 100) RETURNING id`,
        )
        .get(sessionId)!.id;
      recordNoteIdExposure(db, {
        sessionId,
        rideTurnId: turnId,
        exposedTurnIds: [other],
        source: "reminder",
        nowEpoch: 100,
      });

      updateSessionSummaryRewrite(
        db,
        sessionId,
        {
          ...emptySummary,
          decision: `[S${sessionId}/T1].`,
          reference: `Also [S${sessionId}/T2].`,
        },
        200,
      );
      writeMemoryEdges(
        db,
        [
          {
            citing: { kind: "session", id: sessionId },
            cited: { kind: "turn", id: turnId },
            relation: "depends-on",
            provenance: "judged",
          },
        ],
        250,
      );
      expect(
        getOutgoingEdges(db, { kind: "session", id: sessionId }),
      ).toHaveLength(2);

      updateSessionSummaryRewrite(
        db,
        sessionId,
        { ...emptySummary, decision: `Only [S${sessionId}/T1] now.` },
        300,
      );

      const surviving = getOutgoingEdges(db, { kind: "session", id: sessionId });
      expect(surviving.map((edge) => edge.cited.id)).toEqual([turnId]);
      expect(surviving[0]?.relation).toBe("depends-on");
      expect(surviving.some((edge) => edge.cited.id === other)).toBe(false);
    });

    test("a rewrite that still cites a pair does not disturb its relation", () => {
      const { sessionId, turnId } = seedSessionAndTurn();
      updateSessionSummaryRewrite(
        db,
        sessionId,
        { ...emptySummary, decision: `[S${sessionId}/T1].` },
        200,
      );
      writeMemoryEdges(
        db,
        [
          {
            citing: { kind: "session", id: sessionId },
            cited: { kind: "turn", id: turnId },
            relation: "evidence-for",
            provenance: "judged",
          },
        ],
        250,
      );

      updateSessionSummaryRewrite(
        db,
        sessionId,
        { ...emptySummary, decision: `Restating [S${sessionId}/T1] once more.` },
        300,
      );

      const surviving = getOutgoingEdges(db, { kind: "session", id: sessionId });
      expect(surviving).toHaveLength(1);
      expect(surviving[0]?.relation).toBe("evidence-for");
    });
  });
});
