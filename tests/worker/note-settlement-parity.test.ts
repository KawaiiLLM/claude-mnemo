import { describe, expect, mock, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import {
  claimNextNoteSettlementJob,
  enqueueNoteSettlementWindows,
} from "../../src/db/note-settlement";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import {
  RELATION_FIELD_ENTRIES,
  RETRACTION_FIELD_ENTRIES,
} from "../../src/db/citations";
import { MNEMO_TOOL_DESCRIPTIONS, noteInputShape } from "../../src/mcp/definitions";
import { registerMainMcpTools } from "../../src/mcp/server";
import { createNoteSettlementSdkQuery } from "../../src/worker/note-settlement-sdk-query";
import { SETTLEMENT_ERA_CUTOFF_EPOCH } from "../support/settlement-config";

/**
 * TICKET 07 (write-mode-edit-semantics spec D12, [S15069/T1056]): "结算子代理
 * 的工具和主 agent 一致,不需要特殊对待,只多了一个 commit 工具".
 *
 * RUBRIC-V10 TICKET 06 widens the allowed difference by one: `lane_check`
 * (`note-settlement-sdk-query.ts`) is a second settlement-only tool, the
 * read-only four-report checker the main agent has no equivalent surface
 * for (its own reach is `recall`/`timeline`, neither of which derives lane
 * semantics). `EXPECTED_SETTLEMENT_ONLY_TOOLS` below is updated
 * deliberately, not silently widened — the underlying claim this file
 * checks (every OTHER tool name matches exactly) still holds.
 *
 * The pinned decision that produced this file: the claim has to be asserted at
 * the TOOL-REGISTRATION boundary, not by comparing two prose descriptions.
 * Both surfaces are captured here through their OWN registration seam — the
 * main agent's `registerMainMcpTools` (mcp/server.ts, the real MCP process's
 * only registration path) and the settlement subagent's per-request SDK server
 * (worker/note-settlement-sdk-query.ts) — and the set difference between them
 * is computed, not eyeballed. A tool that appears on one side and not the other
 * fails this test by construction, whatever any description claims.
 */

const NOW = 1_800_000_000;

/** The two differences the ruling allows. */
const EXPECTED_SETTLEMENT_ONLY_TOOLS = ["commit", "lane_check"];

/**
 * SETTLEMENT-GATE-TAXONOMY TICKET 06: the difference now runs BOTH ways, and
 * this is the second direction. `remember` retired from the EDGE pass with
 * `justify` — the lane registry was already stage 1's, so `justify` was the
 * tool's one action and it went with the commit gate it discharged (user
 * ruling S15069/T2278). The main agent keeps its own `remember`; this pass has
 * none.
 *
 * Ticket 07's ruling ("the main agent's surface plus exactly `commit`") is
 * therefore no longer literally true of this dispatch, and the test says so
 * rather than being deleted: what it still pins is that neither side gains or
 * loses a tool by accident. A tool appearing on one side must be named in one
 * of these two lists to pass.
 */
const EXPECTED_MAIN_ONLY_TOOLS = ["remember"];

function registeredMainToolNames(): string[] {
  const names: string[] = [];
  const stub = () => ({ content: [{ type: "text" as const, text: "stub" }] });
  registerMainMcpTools(
    {
      registerTool: (name: string) => {
        names.push(name);
        return undefined;
      },
    } as never,
    { recall: stub, timeline: stub, note: stub, remember: stub } as never,
  );
  return names;
}

async function captureSettlementRegistration(db: Database): Promise<{
  names: string[];
  shapes: Map<string, unknown>;
  descriptions: Map<string, string>;
}> {
  const sessionDbId = upsertSession(db, {
    contentSessionId: "settlement-parity-session",
    project: "/tmp/project-settlement-parity",
    title: "settlement parity fixture",
    content: null,
    insight: null,
    createdAtEpoch: NOW - 10_000,
    updatedAtEpoch: NOW - 10_000,
    completedAtEpoch: null,
  }).id;
  const t1 = db
    .query<{ id: number }, [number, number, string, string, number]>(
      `INSERT INTO turns (
         session_id, prompt_number, status, user_prompt, assistant_response,
         tool_call_count, created_at_epoch
       ) VALUES (?, ?, 'active', ?, ?, 3, ?)
       RETURNING id`,
    )
    .get(sessionDbId, 1, "prompt 1", "response 1", NOW - 900)!.id;
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

  const names: string[] = [];
  const shapes = new Map<string, unknown>();
  const descriptions = new Map<string, string>();
  const toolImpl = mock((name: string, description: string, shape: unknown) => {
    names.push(name);
    shapes.set(name, shape);
    descriptions.set(name, description);
    return { name };
  });
  const queryImpl = mock(() =>
    (async function* () {
      yield { type: "result", subtype: "success", is_error: false, result: "done" };
    })(),
  );

  await createNoteSettlementSdkQuery({
    db,
    dataRoot: "/tmp/claude-mnemo-settlement-parity",
    queryImpl: queryImpl as never,
    createSdkMcpServerImpl: ((definition: unknown) => definition) as never,
    toolImpl: toolImpl as never,
    now: () => NOW,
  })({
    prompt: "settle",
    systemPrompt: "system",
    model: "claude-sonnet-5",
    jobId: job.id,
    claimGeneration: job.claimGeneration,
    sessionId: sessionDbId,
    writableTurnIds: new Set([t1]),
    contextBuiltAtEpoch: NOW,
    windowStart: 1,
    windowEnd: 1,
  });

  return { names, shapes, descriptions };
}

describe("settlement's tool surface differs from the main agent's by a named set, in both directions (ticket 07, spec D12)", () => {
  test("the registered-tool difference computes to {commit, lane_check} one way and {remember} the other", async () => {
    let db: Database | undefined;
    try {
      db = createDatabase(":memory:");
      initializeSchema(db);

      const mainNames = registeredMainToolNames();
      const { names: settlementNames } = await captureSettlementRegistration(db);

      const settlementOnly = settlementNames
        .filter((name) => !mainNames.includes(name))
        .sort();
      const mainOnly = mainNames.filter((name) => !settlementNames.includes(name)).sort();

      // The ruling, as an equation — two extra tools on settlement's side,
      // and (ticket 06) exactly one the main agent has that this pass does
      // not.
      expect(settlementOnly).toEqual(EXPECTED_SETTLEMENT_ONLY_TOOLS);
      expect(mainOnly).toEqual(EXPECTED_MAIN_ONLY_TOOLS);
      expect([...settlementNames].sort()).toEqual(
        [
          ...mainNames.filter((name) => !EXPECTED_MAIN_ONLY_TOOLS.includes(name)),
          ...EXPECTED_SETTLEMENT_ONLY_TOOLS,
        ].sort(),
      );
    } finally {
      db?.close();
    }
  });

  test("the `note` tool registered on both sides carries the SAME mode object, not a look-alike", async () => {
    let db: Database | undefined;
    try {
      db = createDatabase(":memory:");
      initializeSchema(db);

      const { shapes } = await captureSettlementRegistration(db);
      const registered = shapes.get("note") as Record<string, unknown>;

      // `noteInputShape.mode` is what `noteInputSchema` — the object
      // `registerMainMcpTools` hands the MCP server — is built from, so object
      // identity here IS "the same vocabulary reaches both models", including
      // the byte-identical description each one reads.
      expect(registered.mode).toBe(noteInputShape.mode);
      // The other genuinely shared fields, same reasoning (ticket 07 of the
      // semantic-container spec established this; D12 only adds `mode`).
      // Ticket 04 (edge-mechanism-revision D3/D6) EXTENDS the enumeration
      // rather than relaxing it: `insight` and the seven retraction mirrors
      // are shared objects too now — settlement writes turn prose again and
      // retracts edges through the same primitive, so every field of that
      // widened surface has to be the main agent's own object, not a
      // look-alike. The tool-DIFFERENCE assertion above is untouched and
      // still computes to exactly {commit}.
      // Ticket 14 (lane-model-v12 spec D3b: "主 agent 与结算两侧的 `.describe()`
      // 分别写"): `tags` LEAVES this enumeration. The RULE is one function
      // (`db/turn-tag-gate.ts`, called from both surfaces), but the two
      // writers are told different things about it — the main agent is told
      // where to READ the vocabulary, settlement is told it is the side that
      // can EXTEND it. Divergent describes on a shared rule is the ticket's
      // own decision; the check that keeps them honest is
      // `tests/mcp/definitions.test.ts`, which asserts they differ AND that
      // both state the same closed vocabulary.
      expect(registered.tags).not.toBe(noteInputShape.tags);
      // main-agent-edge-capability ticket 01 (ruling [S15069/T1651]): the edge
      // fields REJOIN this enumeration — RESTORED to `noteInputShape` as the
      // owning declaration, exactly like `insight`/`type` above, reversing
      // lane-model-v12 ticket 08's one-release inversion (declared on
      // settlement's own shape, main agent had none).
      for (const field of ["insight", "type"] as const) {
        expect(registered[field]).toBe(noteInputShape[field]);
      }
      for (const [key] of [...RELATION_FIELD_ENTRIES, ...RETRACTION_FIELD_ENTRIES]) {
        expect(registered[key], key).toBeDefined();
        expect(registered[key], key).toBe((noteInputShape as Record<string, unknown>)[key]);
        expect(key in noteInputShape, key).toBe(true);
      }
    } finally {
      db?.close();
    }
  });

  test("the read tools are registered from the same description constant on both sides", async () => {
    let db: Database | undefined;
    try {
      db = createDatabase(":memory:");
      initializeSchema(db);

      const { descriptions } = await captureSettlementRegistration(db);

      // recall/timeline are the same text, character for character — the main
      // agent's registration reads the same constant (mcp/server.ts). The two
      // WRITE tools deliberately keep their own call-contract text: settlement
      // addresses a session and refuses turn prose, which is a scope
      // difference the ruling does not retire — what it retired is the MODE
      // vocabulary differing, which the test above pins.
      expect(descriptions.get("recall")).toBe(MNEMO_TOOL_DESCRIPTIONS.recall);
      expect(descriptions.get("timeline")).toBe(MNEMO_TOOL_DESCRIPTIONS.timeline);
    } finally {
      db?.close();
    }
  });

  test("neither write description teaches a difference that no longer exists", async () => {
    let db: Database | undefined;
    try {
      db = createDatabase(":memory:");
      initializeSchema(db);

      const { descriptions } = await captureSettlementRegistration(db);

      // Spec D12: "SDK 与提示词里「no append」一类的差异化措辞删除——它描述的
      // 差异已不存在."
      for (const toolName of ["note", "remember", "commit"]) {
        const description = descriptions.get(toolName) ?? "";
        expect(description.toLowerCase()).not.toContain("no append");
        expect(description.toLowerCase()).not.toContain("there is no append");
      }
    } finally {
      db?.close();
    }
  });
});
