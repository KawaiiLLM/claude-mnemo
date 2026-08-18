import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import {
  claimNextNoteSettlementJob,
  enqueueNoteSettlementWindows,
  type NoteSettlementJob,
} from "../../src/db/note-settlement";
import { listRecentSettlementProposals } from "../../src/db/note-settlement-proposals";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import {
  evaluateSettlementMembershipWrite,
  renderSettlementMembershipWriteReceipt,
  settlementMembershipWriteInputSchema,
  type SettlementMembershipWriteInput,
} from "../../src/worker/note-settlement-membership-facade";
import type { SettlementTurnFacadeContext } from "../../src/worker/note-settlement-turn-facade";
import { SETTLEMENT_ERA_CUTOFF_EPOCH } from "../support/settlement-config";

/**
 * The settlement membership facade's DECISION function,
 * `evaluateSettlementMembershipWrite`.
 *
 * TICKET 05 (ownership-and-note-cadence spec, "settlement demolition"):
 * `assign` retired outright — every describe block that exercised it
 * (required fields, the attached-set boundary, landing/idempotence, the
 * `homeless stays legal` negative space, the tag-facet exclusion proved
 * through the assign path) is gone, because the ACTION is gone, not because
 * the facade grew stricter about it. `propose` is the sole survivor, and its
 * floor drops from 2 addresses to 1 (spec: "最小簇 1，修订现行 ≥2 ——孤立 turn
 * 独自开启新任务是合法情形"). It is also no longer a completion condition —
 * `recordNoteSettlementMembershipActivity` and the table it wrote to
 * (`note_settlement_membership_activity`) are gone with the membership gate
 * (see `db/note-settlement-completion.ts`'s module doc comment).
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

function seedSession(): number {
  return upsertSession(db, {
    contentSessionId: "settlement-membership-facade-session",
    project: "/tmp/project-settlement-membership-facade",
    title: "settlement membership facade fixture",
    content: null,
    insight: null,
    createdAtEpoch: NOW - 10_000,
    updatedAtEpoch: NOW - 10_000,
    completedAtEpoch: null,
  }).id;
}

function seedTurn(
  sessionDbId: number,
  promptNumber: number,
  facets: { type?: string[]; tags?: string[] } = {},
): number {
  return db
    .query<{ id: number }, [number, number, string, string, number, string, string]>(
      `INSERT INTO turns (
         session_id, prompt_number, status, user_prompt, assistant_response,
         tool_call_count, created_at_epoch, type, tags
       ) VALUES (?, ?, 'active', ?, ?, 3, ?, ?, ?)
       RETURNING id`,
    )
    .get(
      sessionDbId,
      promptNumber,
      `prompt ${promptNumber}`,
      `response ${promptNumber}`,
      NOW - 1_000 + promptNumber,
      JSON.stringify(facets.type ?? []),
      JSON.stringify(facets.tags ?? []),
    )!.id;
}

function claimWindow(sessionDbId: number, windowStart: number, windowEnd: number): NoteSettlementJob {
  enqueueNoteSettlementWindows(
    db,
    [{ sessionId: sessionDbId, windowStart, windowEnd, triggerType: "consecutive" }],
    NOW,
    SETTLEMENT_ERA_CUTOFF_EPOCH,
  );
  const job = claimNextNoteSettlementJob(db, sessionDbId, NOW, NOW * 1000);
  if (!job) {
    throw new Error("fixture failed to claim a settlement job");
  }
  return job;
}

function baseContext(
  job: NoteSettlementJob,
  overrides: Partial<SettlementTurnFacadeContext> = {},
): SettlementTurnFacadeContext {
  return {
    jobId: job.id,
    claimGeneration: job.claimGeneration,
    sessionId: job.sessionId,
    reviewableTurnIds: new Set(),
    contextBuiltAtEpoch: NOW,
    eligibleRelationPairKeys: new Set(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Input shape
// ---------------------------------------------------------------------------

describe("settlementMembershipWriteInputSchema", () => {
  test("accepts a minimal propose", () => {
    expect(
      settlementMembershipWriteInputSchema.safeParse({
        action: "propose",
        addresses: ["S1/T1"],
        title: "a cluster",
      }).success,
    ).toBe(true);
  });

  test("rejects action=\"assign\" — the value itself is gone from the enum, not merely refused downstream", () => {
    expect(
      settlementMembershipWriteInputSchema.safeParse({
        action: "assign",
        addresses: ["S1/T1"],
        title: "x",
      }).success,
    ).toBe(false);
  });

  test("rejects an unknown field (strict schema)", () => {
    expect(
      settlementMembershipWriteInputSchema.safeParse({
        action: "propose",
        addresses: ["S1/T1"],
        title: "a cluster",
        segmentId: 1,
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// propose
// ---------------------------------------------------------------------------

describe("propose — required fields and address resolution", () => {
  test("refuses a missing title", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const result = evaluateSettlementMembershipWrite(
      db,
      baseContext(job, { reviewableTurnIds: new Set([t1]) }),
      { action: "propose", addresses: [`S${sessionDbId}/T1`] },
      NOW,
      { apply: true },
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain("title");
  });

  test("refuses zero addresses", () => {
    const sessionDbId = seedSession();
    const job = claimWindow(sessionDbId, 1, 1);
    const result = evaluateSettlementMembershipWrite(
      db,
      baseContext(job),
      { action: "propose", addresses: [], title: "empty cluster" },
      NOW,
      { apply: true },
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain("at least one");
  });

  test("a malformed address rejects the WHOLE call — nothing is stored for a partially bad list", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const result = evaluateSettlementMembershipWrite(
      db,
      baseContext(job, { reviewableTurnIds: new Set([t1]) }),
      {
        action: "propose",
        addresses: [`S${sessionDbId}/T1`, "not-an-address"],
        title: "a cluster",
      },
      NOW,
      { apply: true },
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain("not-an-address");
    expect(listRecentSettlementProposals(db, 3)).toEqual([]);
  });

  test("an address outside this dispatch's reviewable window rejects the whole call", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const t2 = seedTurn(sessionDbId, 2);
    const job = claimWindow(sessionDbId, 1, 2);
    const result = evaluateSettlementMembershipWrite(
      db,
      // t2 deliberately outside reviewableTurnIds.
      baseContext(job, { reviewableTurnIds: new Set([t1]) }),
      {
        action: "propose",
        addresses: [`S${sessionDbId}/T1`, `S${sessionDbId}/T2`],
        title: "a cluster",
      },
      NOW,
      { apply: true },
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain("reviewable window");
  });
});

describe("propose — a single homeless turn may open its own proposal (ticket 05: floor drops from 2 to 1)", () => {
  test("a lone address is accepted and stored as a one-turn proposal", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);

    const result = evaluateSettlementMembershipWrite(
      db,
      baseContext(job, { reviewableTurnIds: new Set([t1]) }),
      { action: "propose", addresses: [`S${sessionDbId}/T1`], title: "a lone turn's own task" },
      NOW,
      { apply: true },
    );

    expect(result.ok).toBe(true);
    expect(result.ok && result.outcome.addressesResolved).toBe(1);
    const proposals = listRecentSettlementProposals(db, 3);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.addresses).toEqual([`S${sessionDbId}/T1`]);
  });

  test("a multi-turn cluster is still legal", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const t2 = seedTurn(sessionDbId, 2);
    const job = claimWindow(sessionDbId, 1, 2);

    const result = evaluateSettlementMembershipWrite(
      db,
      baseContext(job, { reviewableTurnIds: new Set([t1, t2]) }),
      {
        action: "propose",
        addresses: [`S${sessionDbId}/T1`, `S${sessionDbId}/T2`],
        title: "a two-turn cluster",
      },
      NOW,
      { apply: true },
    );

    expect(result.ok).toBe(true);
    expect(result.ok && result.outcome.addressesResolved).toBe(2);
  });
});

describe("propose — never creates a segment row, and is no longer a completion condition (ticket 05)", () => {
  test("a landed propose adds zero rows to segments, whatever the address count", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const t2 = seedTurn(sessionDbId, 2);
    const t3 = seedTurn(sessionDbId, 3);
    const job = claimWindow(sessionDbId, 1, 3);
    const before = db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM segments").get()!.count;

    const result = evaluateSettlementMembershipWrite(
      db,
      baseContext(job, { reviewableTurnIds: new Set([t1, t2, t3]) }),
      {
        action: "propose",
        addresses: [`S${sessionDbId}/T1`, `S${sessionDbId}/T2`, `S${sessionDbId}/T3`],
        title: "a three-turn cluster",
      },
      NOW,
      { apply: true },
    );

    expect(result.ok).toBe(true);
    expect(
      db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM segments").get()!.count,
    ).toBe(before);
    const proposals = listRecentSettlementProposals(db, 3);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.title).toBe("a three-turn cluster");
  });

  test("apply:false stores nothing and creates no segment", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const t2 = seedTurn(sessionDbId, 2);
    const job = claimWindow(sessionDbId, 1, 2);

    const result = evaluateSettlementMembershipWrite(
      db,
      baseContext(job, { reviewableTurnIds: new Set([t1, t2]) }),
      {
        action: "propose",
        addresses: [`S${sessionDbId}/T1`, `S${sessionDbId}/T2`],
        title: "a cluster",
      },
      NOW,
      { apply: false },
    );

    expect(result.ok).toBe(true);
    expect(result.ok && result.outcome.proposalId).toBeNull();
    expect(listRecentSettlementProposals(db, 3)).toEqual([]);
    expect(
      db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM segments").get()!.count,
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Receipt rendering
// ---------------------------------------------------------------------------

describe("renderSettlementMembershipWriteReceipt", () => {
  test("states the address count and that it creates no segment", () => {
    const text = renderSettlementMembershipWriteReceipt(
      { proposalId: 3, addressesResolved: 2 },
      { staged: true },
    );
    expect(text).toContain("2 address(es)");
    expect(text).toContain("creates no segment");
    expect(text).toContain("pending commit");
  });

  test("a proposal id of null (a dry run) still renders a receipt", () => {
    const text = renderSettlementMembershipWriteReceipt(
      { proposalId: null, addressesResolved: 1 },
      { staged: true },
    );
    expect(text).toContain("1 address(es)");
    expect(text).not.toContain("as proposal #");
  });
});
