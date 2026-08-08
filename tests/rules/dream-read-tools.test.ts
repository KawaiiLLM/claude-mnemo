import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { createRuleStore, type CreateRuleInput } from "../../src/db/rules";
import { initializeSchema } from "../../src/db/schema";
import {
  createDreamRuleReadTools,
  READ_TURN_DETAIL_DEFAULT_CAP,
  READ_TURN_DETAIL_MAX_TEXT_CAP,
} from "../../src/rules/dream-read-tools";

function ruleInput(overrides: Partial<CreateRuleInput> = {}): CreateRuleInput {
  return {
    name: "bash-timeout",
    claim: "运行长耗时 Bash 命令前必须设置 timeout。",
    rationale: "避免命令无界等待。",
    scope: "global",
    triggerKind: "tool",
    triggerSpec: {
      kind: "tool",
      tool: "Bash",
      param_absent: "timeout",
    },
    status: "provisional",
    createdAtEpoch: 100,
    ...overrides,
  };
}

describe("dream rule read tools", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
  });

  afterEach(() => db.close());

  test("lists only pending-review hits for one content-day with their rules and resolution", () => {
    const store = createRuleStore(db);
    const resolvedRule = store.create(ruleInput());
    const unresolvedRule = store.create(ruleInput({
      name: "inspect-failure",
      claim: "工具失败时先检查原始结果。",
    }));
    // Default content-day 2026-07-10 spans 2026-07-09T20:00Z through
    // 2026-07-10T20:00Z (Asia/Shanghai, 04:00 boundary).
    const resolved = store.createEvent({
      eventUid: "hit-resolved",
      ruleId: resolvedRule.id,
      eventKind: "hit",
      turnRef: "S12/T3",
      adjustment: { resolution: "resolved", hit: { event_type: "PreToolUse" } },
      createdAtEpoch: Date.parse("2026-07-10T12:00:00Z") / 1_000,
    });
    store.createEvent({
      eventUid: "hit-unresolved",
      ruleId: unresolvedRule.id,
      eventKind: "hit",
      turnRef: null,
      adjustment: { resolution: "unresolved", hit: { event_type: "PostToolUse" } },
      createdAtEpoch: Date.parse("2026-07-10T19:59:59Z") / 1_000,
    });
    const reviewed = store.createEvent({
      eventUid: "hit-reviewed",
      ruleId: resolvedRule.id,
      eventKind: "hit",
      turnRef: "S12/T4",
      adjustment: { resolution: "resolved" },
      createdAtEpoch: Date.parse("2026-07-10T13:00:00Z") / 1_000,
    });
    store.createEvent({
      eventUid: "judgment-reviewed",
      ruleId: resolvedRule.id,
      eventKind: "judgment",
      sourceEventId: reviewed.id,
      label: "helpful",
      rationale: "产生了正面作用。",
      createdAtEpoch: Date.parse("2026-07-11T12:00:00Z") / 1_000,
    });
    store.createEvent({
      eventUid: "hit-next-day",
      ruleId: resolvedRule.id,
      eventKind: "hit",
      turnRef: "S12/T5",
      adjustment: { resolution: "resolved" },
      createdAtEpoch: Date.parse("2026-07-10T20:00:00Z") / 1_000,
    });

    const tools = createDreamRuleReadTools({ db });
    expect(tools.listRuleHits("2026-07-10")).toMatchObject({
      date: "2026-07-10",
      hits: [
        {
          event_id: resolved.id,
          hit_id: "hit-resolved",
          rule: { id: resolvedRule.id, name: "bash-timeout" },
          turn_ref: "S12/T3",
          resolution: "resolved",
          unresolved: false,
        },
        {
          hit_id: "hit-unresolved",
          rule: { id: unresolvedRule.id, name: "inspect-failure" },
          turn_ref: null,
          resolution: "unresolved",
          unresolved: true,
        },
      ],
    });
    expect(tools.listRuleHits("2026-07-08")).toEqual({
      date: "2026-07-08",
      hits: [],
    });
  });

  test("returns three turn segments and observation sequence with true lengths before truncated values", () => {
    const session = db.query<{ id: number }, []>(
      "INSERT INTO sessions (content_session_id, project, created_at_epoch) VALUES ('detail', '/project', 1) RETURNING id",
    ).get()!;
    const hugePrompt = "问".repeat(150_000);
    const hugeResponse = "答".repeat(160_000);
    const hugeTranscript = "思".repeat(170_000);
    const turn = db.query<{ id: number }, [number, string, string, string]>(
      `INSERT INTO turns (
         session_id, prompt_number, status, user_prompt, assistant_response,
         assistant_transcript, created_at_epoch
       ) VALUES (?, 7, 'extracted', ?, ?, ?, 2)
       RETURNING id`,
    ).get(session.id, hugePrompt, hugeResponse, hugeTranscript)!;
    const hugeInput = "输".repeat(180_000);
    const hugeResult = "出".repeat(220_000);
    db.query(
      `INSERT INTO observations (
         turn_id, tool_name, tool_input, tool_result, status, created_at_epoch
       ) VALUES (?, 'Bash', ?, ?, 'extracted', 3)`,
    ).run(turn.id, hugeInput, hugeResult);

    const detail = createDreamRuleReadTools({ db }).readTurnDetail("S1/T7");

    expect(detail.turn).toEqual({
      id: turn.id,
      session_id: session.id,
      prompt_number: 7,
      user_prompt_len: 150_000,
      assistant_response_len: 160_000,
      assistant_transcript_len: 170_000,
      user_prompt_truncated: true,
      assistant_response_truncated: true,
      assistant_transcript_truncated: true,
      user_prompt: "问".repeat(READ_TURN_DETAIL_DEFAULT_CAP),
      assistant_response: "答".repeat(READ_TURN_DETAIL_DEFAULT_CAP),
      assistant_transcript: "思".repeat(READ_TURN_DETAIL_DEFAULT_CAP),
    });
    expect(detail.observations).toHaveLength(1);
    expect(detail.observations![0]).toMatchObject({
      tool_name: "Bash",
      input_len: 180_000,
      result_len: 220_000,
      tool_input: "输".repeat(READ_TURN_DETAIL_DEFAULT_CAP),
      tool_result: "出".repeat(READ_TURN_DETAIL_DEFAULT_CAP),
    });
    expect(Object.keys(detail.observations![0]!)).toEqual([
      "id",
      "tool_name",
      "status",
      "input_len",
      "result_len",
      "tool_input",
      "tool_result",
    ]);
    expect(JSON.stringify(detail).length).toBeLessThan(20_000);

    const expanded = createDreamRuleReadTools({ db }).readTurnDetail("S1/T7", {
      full: true,
      include_observations: false,
    });
    expect(expanded.turn).toMatchObject({
      user_prompt: hugePrompt,
      assistant_response: hugeResponse,
      assistant_transcript: hugeTranscript,
      user_prompt_truncated: false,
      assistant_response_truncated: false,
      assistant_transcript_truncated: false,
    });

    const reconstructed = {
      user_prompt: "",
      assistant_response: "",
      assistant_transcript: "",
    };
    for (
      let textOffset = 0;
      textOffset < hugeTranscript.length;
      textOffset += READ_TURN_DETAIL_MAX_TEXT_CAP
    ) {
      const page = createDreamRuleReadTools({ db }).readTurnDetail("S1/T7", {
        text_cap: READ_TURN_DETAIL_MAX_TEXT_CAP,
        text_offset: textOffset,
        include_observations: false,
      });
      expect(JSON.stringify(page).length).toBeLessThan(80_000);
      reconstructed.user_prompt += page.turn.user_prompt ?? "";
      reconstructed.assistant_response += page.turn.assistant_response ?? "";
      reconstructed.assistant_transcript += page.turn.assistant_transcript ?? "";
    }
    expect(reconstructed).toEqual({
      user_prompt: hugePrompt,
      assistant_response: hugeResponse,
      assistant_transcript: hugeTranscript,
    });
  });

  test("supports an explicit cap, full observation text, omission, and tool filtering", () => {
    const session = db.query<{ id: number }, []>(
      "INSERT INTO sessions (content_session_id, project, created_at_epoch) VALUES ('opts', '/project', 1) RETURNING id",
    ).get()!;
    const turn = db.query<{ id: number }, [number]>(
      "INSERT INTO turns (session_id, prompt_number, status, created_at_epoch) VALUES (?, 2, 'extracted', 2) RETURNING id",
    ).get(session.id)!;
    db.query(
      "INSERT INTO observations (turn_id, tool_name, tool_input, tool_result, created_at_epoch) VALUES (?, 'Bash', 'abcdef', 'uvwxyz', 3)",
    ).run(turn.id);
    db.query(
      "INSERT INTO observations (turn_id, tool_name, tool_input, tool_result, created_at_epoch) VALUES (?, 'Read', 'other', 'other', 4)",
    ).run(turn.id);
    const tools = createDreamRuleReadTools({ db });

    db.query(
      "UPDATE turns SET user_prompt = 'abcdef', assistant_response = 'uvwxyz', assistant_transcript = '123456' WHERE id = ?",
    ).run(turn.id);

    expect(tools.readTurnDetail("S1/T2", { cap: 3, tool: "Bash" }).observations)
      .toMatchObject([{ input_len: 6, result_len: 6, tool_input: "abc", tool_result: "uvw" }]);
    expect(tools.readTurnDetail("S1/T2", { text_cap: 3 }).turn).toMatchObject({
      user_prompt: "abc",
      assistant_response: "uvw",
      assistant_transcript: "123",
      user_prompt_truncated: true,
      assistant_response_truncated: true,
      assistant_transcript_truncated: true,
    });
    expect(tools.readTurnDetail("S1/T2", { full: true, tool: "Bash" }).observations)
      .toMatchObject([{ tool_input: "abcdef", tool_result: "uvwxyz" }]);
    expect(tools.readTurnDetail("S1/T2", { include_observations: false }))
      .not.toHaveProperty("observations");
  });

  test("withholds a note call's observation, payload and identity alike", () => {
    const session = db.query<{ id: number }, []>(
      "INSERT INTO sessions (content_session_id, project, created_at_epoch) VALUES ('excluded', '/project', 1) RETURNING id",
    ).get()!;
    const turn = db.query<{ id: number }, [number]>(
      "INSERT INTO turns (session_id, prompt_number, status, created_at_epoch) VALUES (?, 1, 'extracted', 2) RETURNING id",
    ).get(session.id)!;
    db.query(
      "INSERT INTO observations (turn_id, tool_name, tool_input, tool_result, created_at_epoch) VALUES (?, 'Bash', 'work', 'output', 3)",
    ).run(turn.id);
    db.query(
      `INSERT INTO observations (
         turn_id, tool_name, tool_input, tool_result,
         excluded_from_extraction, created_at_epoch
       ) VALUES (?, 'mcp__mnemo__note', '{"title":"secretnotetitle"}', 'Noted.', 1, 4)`,
    ).run(turn.id);

    // `full: true` is the dream agent's own reading mode — the one that would
    // return the note text verbatim without the exclusion filter.
    const detail = createDreamRuleReadTools({ db }).readTurnDetail("S1/T1", {
      full: true,
    });

    expect(detail.observations).toHaveLength(1);
    expect(detail.observations![0]).toMatchObject({ tool_name: "Bash" });
    expect(JSON.stringify(detail)).not.toContain("secretnotetitle");
  });

  test("errors for a missing or malformed turn_ref and conflicting truncation options", () => {
    const tools = createDreamRuleReadTools({ db });
    expect(() => tools.readTurnDetail("S999/T1")).toThrow("turn not found: S999/T1");
    expect(() => tools.readTurnDetail("not-a-turn")).toThrow();
    expect(() => tools.readTurnDetail("S1/T1", { cap: 20, full: true })).toThrow(
      "cap/text_cap/text_offset and full conflict",
    );
    expect(() => tools.readTurnDetail("S1/T1", { text_cap: 20, full: true })).toThrow(
      "cap/text_cap/text_offset and full conflict",
    );
    expect(() => tools.readTurnDetail("S1/T1", { text_offset: 20, full: true })).toThrow(
      "cap/text_cap/text_offset and full conflict",
    );
  });
});
