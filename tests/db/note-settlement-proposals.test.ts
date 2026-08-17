import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import {
  claimNextNoteSettlementJob,
  enqueueNoteSettlementWindows,
} from "../../src/db/note-settlement";
import {
  listRecentSettlementProposals,
  recordNoteSettlementProposal,
} from "../../src/db/note-settlement-proposals";
import { initializeSchema } from "../../src/db/schema";
import { getSegmentMemberTurnIds } from "../../src/db/segments";
import { upsertSession } from "../../src/db/sessions";
import { rememberTool } from "../../src/mcp/remember";
import { SETTLEMENT_ERA_CUTOFF_EPOCH } from "../support/settlement-config";

/**
 * Ticket 08 — storage and read path for homeless-cluster proposals (spec
 * "Proposal"). "You store + expose a reader; ticket 10 renders" (this
 * ticket's own scope note) — this file proves the storage/read half plus
 * the acceptance criterion that ties it to ticket 02's existing adoption
 * path: `remember(create)`'s `members` field already accepts seed turn
 * addresses, so a stored proposal's `addresses` must be usable there
 * VERBATIM, with no reformatting step this ticket would otherwise owe.
 */

const NOW = 1_800_000_000;

let db: Database;

beforeEach(() => {
  db = createDatabase(":memory:");
  initializeSchema(db);
});

afterEach(() => {
  db.close();
});

function seedSession(contentSessionId = "settlement-proposals-session"): number {
  return upsertSession(db, {
    contentSessionId,
    project: "/tmp/project-settlement-proposals",
    title: "settlement proposals fixture",
    content: null,
    insight: null,
    createdAtEpoch: NOW - 10_000,
    updatedAtEpoch: NOW - 10_000,
    completedAtEpoch: null,
  }).id;
}

function seedTurn(sessionDbId: number, promptNumber: number): number {
  return db
    .query<{ id: number }, [number, number, string, string, number]>(
      `INSERT INTO turns (
         session_id, prompt_number, status, user_prompt, assistant_response,
         tool_call_count, created_at_epoch
       ) VALUES (?, ?, 'active', ?, ?, 3, ?)
       RETURNING id`,
    )
    .get(
      sessionDbId,
      promptNumber,
      `prompt ${promptNumber}`,
      `response ${promptNumber}`,
      NOW - 1_000 + promptNumber,
    )!.id;
}

function claimJobId(sessionDbId: number): number {
  enqueueNoteSettlementWindows(
    db,
    [{ sessionId: sessionDbId, windowStart: 1, windowEnd: 1, triggerType: "consecutive" }],
    NOW,
    SETTLEMENT_ERA_CUTOFF_EPOCH,
  );
  const job = claimNextNoteSettlementJob(db, sessionDbId, NOW, NOW * 1000);
  if (!job) {
    throw new Error("fixture failed to claim a settlement job");
  }
  return job.id;
}

describe("recordNoteSettlementProposal / listRecentSettlementProposals", () => {
  test("stores exactly title + addresses, and reads them back", () => {
    const sessionDbId = seedSession();
    seedTurn(sessionDbId, 1);
    seedTurn(sessionDbId, 2);
    const jobId = claimJobId(sessionDbId);

    const stored = recordNoteSettlementProposal(db, {
      jobId,
      sessionId: sessionDbId,
      title: "the lease-fencing cluster",
      addresses: [`S${sessionDbId}/T1`, `S${sessionDbId}/T2`],
      nowEpoch: NOW,
    });

    expect(stored.title).toBe("the lease-fencing cluster");
    expect(stored.addresses).toEqual([`S${sessionDbId}/T1`, `S${sessionDbId}/T2`]);

    const [proposal] = listRecentSettlementProposals(db, 3);
    expect(proposal).toEqual(stored);
  });

  test("renders at most N, newest first", () => {
    const sessionDbId = seedSession();
    const jobId = claimJobId(sessionDbId);
    for (let index = 0; index < 5; index += 1) {
      seedTurn(sessionDbId, index + 1);
    }
    for (let index = 0; index < 5; index += 1) {
      recordNoteSettlementProposal(db, {
        jobId,
        sessionId: sessionDbId,
        title: `cluster ${index}`,
        addresses: [`S${sessionDbId}/T1`, `S${sessionDbId}/T2`],
        nowEpoch: NOW + index,
      });
    }

    const top3 = listRecentSettlementProposals(db, 3);
    expect(top3.map((entry) => entry.title)).toEqual(["cluster 4", "cluster 3", "cluster 2"]);
  });

  test("a limit of 0 renders nothing", () => {
    const sessionDbId = seedSession();
    seedTurn(sessionDbId, 1);
    seedTurn(sessionDbId, 2);
    const jobId = claimJobId(sessionDbId);
    recordNoteSettlementProposal(db, {
      jobId,
      sessionId: sessionDbId,
      title: "a cluster",
      addresses: [`S${sessionDbId}/T1`, `S${sessionDbId}/T2`],
      nowEpoch: NOW,
    });

    expect(listRecentSettlementProposals(db, 0)).toEqual([]);
  });

  test("proposals from DIFFERENT sessions are listed together, globally — the roster surfaces to whichever session starts next", () => {
    const sessionA = seedSession("settlement-proposals-session-a");
    seedTurn(sessionA, 1);
    seedTurn(sessionA, 2);
    const jobA = claimJobId(sessionA);
    recordNoteSettlementProposal(db, {
      jobId: jobA,
      sessionId: sessionA,
      title: "from session A",
      addresses: [`S${sessionA}/T1`, `S${sessionA}/T2`],
      nowEpoch: NOW,
    });

    const sessionB = seedSession("settlement-proposals-session-b");
    seedTurn(sessionB, 1);
    seedTurn(sessionB, 2);
    const jobB = claimJobId(sessionB);
    recordNoteSettlementProposal(db, {
      jobId: jobB,
      sessionId: sessionB,
      title: "from session B",
      addresses: [`S${sessionB}/T1`, `S${sessionB}/T2`],
      nowEpoch: NOW + 1,
    });

    expect(listRecentSettlementProposals(db, 3).map((entry) => entry.title)).toEqual([
      "from session B",
      "from session A",
    ]);
  });
});

describe("acceptance criterion — remember(create) seeds exactly a proposal's addresses (ticket 02's adoption path)", () => {
  test("a stored proposal's addresses, handed to remember(create).members verbatim, seed exactly those members", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const t2 = seedTurn(sessionDbId, 2);
    const jobId = claimJobId(sessionDbId);

    const stored = recordNoteSettlementProposal(db, {
      jobId,
      sessionId: sessionDbId,
      title: "the lease-fencing cluster",
      addresses: [`S${sessionDbId}/T1`, `S${sessionDbId}/T2`],
      nowEpoch: NOW,
    });
    const [proposal] = listRecentSettlementProposals(db, 3);
    expect(proposal!.id).toBe(stored.id);

    // The user approves it: the main agent calls remember(create) with the
    // proposal's OWN title and addresses, unmodified — no reformatting step.
    const result = rememberTool(db, {
      verb: "create",
      title: proposal!.title,
      topic: "lease fencing",
      members: proposal!.addresses,
    });

    expect(result.content[0]!.text).toContain("Created");
    expect(result.content[0]!.text).toContain("2 member(s) seeded");
    const segmentId = Number(/Created E(\d+)/.exec(result.content[0]!.text)![1]);
    expect(getSegmentMemberTurnIds(db, segmentId).sort()).toEqual([t1, t2].sort());
  });
});
