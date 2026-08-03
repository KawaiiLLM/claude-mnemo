import { describe, expect, test } from "bun:test";
import {
  buildCorrectiveResend,
  classifyWorkUnitResponse,
  deriveRequiredTargetIds,
  type WorkUnitSignals,
} from "../../src/worker/derailment";

const base: WorkUnitSignals = {
  requiredIds: new Set<number>(),
  rememberedIds: new Set<number>(),
  rememberedSessionIds: new Set<number>(),
  sessionDbId: 1,
  hadSubstantiveText: false,
  hadIllegalTool: false,
};

describe("classifyWorkUnitResponse", () => {
  test("resolved when every required id is remembered (prose ignored)", () => {
    expect(
      classifyWorkUnitResponse({
        ...base,
        requiredIds: new Set([7]),
        rememberedIds: new Set([7]),
        hadSubstantiveText: true,
      }),
    ).toBe("resolved");
  });

  test("strike when a required id is missing even though another was remembered (S4589 shape)", () => {
    expect(
      classifyWorkUnitResponse({
        ...base,
        requiredIds: new Set([7]),
        rememberedIds: new Set([6]),
        hadSubstantiveText: true,
      }),
    ).toBe("strike");
  });

  test("strike on merged partial: T_a remembered, T_b missing", () => {
    expect(
      classifyWorkUnitResponse({
        ...base,
        requiredIds: new Set([1, 2]),
        rememberedIds: new Set([1]),
      }),
    ).toBe("strike");
  });

  test("recall-then-prose-without-remember strikes (recall is not completion)", () => {
    expect(
      classifyWorkUnitResponse({
        ...base,
        requiredIds: new Set([3]),
        rememberedIds: new Set(),
        hadSubstantiveText: true,
      }),
    ).toBe("strike");
  });

  test("standalone summary (required empty): empty/thinking-only is not a strike", () => {
    expect(classifyWorkUnitResponse({ ...base })).toBe("resolved");
  });

  test("standalone summary (required empty): prose with no remember strikes", () => {
    expect(
      classifyWorkUnitResponse({ ...base, hadSubstantiveText: true }),
    ).toBe("strike");
  });

  test("illegal tool always strikes (defense-in-depth)", () => {
    expect(
      classifyWorkUnitResponse({ ...base, hadIllegalTool: true }),
    ).toBe("strike");
  });

  test("pure-empty on a required-id unit strikes (missed extraction)", () => {
    expect(
      classifyWorkUnitResponse({ ...base, requiredIds: new Set([9]) }),
    ).toBe("strike");
  });

  test("standalone summary: prose with a stray turn remember (no session remember) strikes", () => {
    expect(
      classifyWorkUnitResponse({
        ...base,
        hadSubstantiveText: true,
        rememberedIds: new Set([99]),
      }),
    ).toBe("strike");
  });

  test("standalone summary: remember(S=current) with explanatory text is resolved", () => {
    expect(
      classifyWorkUnitResponse({
        ...base,
        rememberedSessionIds: new Set([1]), // matches base sessionDbId: 1
        hadSubstantiveText: true,
      }),
    ).toBe("resolved");
  });

  test("standalone summary: remember of a DIFFERENT session + prose still strikes", () => {
    expect(
      classifyWorkUnitResponse({
        ...base,
        rememberedSessionIds: new Set([999]), // 999 ≠ sessionDbId 1
        hadSubstantiveText: true,
      }),
    ).toBe("strike");
  });

  test("standalone summary: empty/thinking-only (no session remember, no prose) is resolved", () => {
    expect(classifyWorkUnitResponse({ ...base })).toBe("resolved");
  });
});

describe("deriveRequiredTargetIds", () => {
  test("merged batch requires every mini-turn's id", () => {
    const ids = deriveRequiredTargetIds({
      kind: "merged",
      miniTurns: [{ turnId: 11 }, { turnId: 12 }],
    });
    expect([...ids].sort()).toEqual([11, 12]);
  });

  test("every slice requires its turn id (mid or final — every mini-turn remembers)", () => {
    expect([...deriveRequiredTargetIds({ kind: "slice", miniTurn: { turnId: 5 } })]).toEqual([5]);
  });

  test("standalone session summary requires nothing", () => {
    expect(deriveRequiredTargetIds({ kind: "session-summary" }).size).toBe(0);
  });
});

describe("buildCorrectiveResend", () => {
  test("prefixes a <reminder> and preserves the original block", () => {
    const original = `<turn id="T42">\n  prompt: do X\n</turn>`;
    const out = buildCorrectiveResend(original);
    expect(out.startsWith("<reminder>")).toBe(true);
    expect(out).toContain("did not extract it");
    expect(out).toContain("DATA");
    expect(out).toContain("</reminder>");
    expect(out).toContain(original); // original message resent verbatim
  });

  test('default/"turn" variant pins the id-bearing skip form (a bare skip is rejected by the remember route)', () => {
    const original = `<turn id="T42">\n  prompt: do X\n</turn>`;
    const def = buildCorrectiveResend(original);
    const turn = buildCorrectiveResend(original, "turn");
    for (const out of [def, turn]) {
      // Must match the system prompt's skip contract verbatim: an id-less
      // remember() is rejected (src/mcp/remember.ts) and the work unit only
      // resolves once the CURRENT turn id is remembered (deriveRequiredTargetIds).
      expect(out).toContain(
        'remember({ id: "T<n>", status: "skipped", grade: 0, title })',
      );
      expect(out).toContain("that turn's own id");
      expect(out).toContain("without an id is rejected");
      expect(out).not.toContain('remember({status:"skipped"})');
    }
  });

  test("session-summary variant points the agent at the session route, not status:skipped", () => {
    const original = `<session id="S7">\n  summary draft\n</session>`;
    const out = buildCorrectiveResend(original, "session-summary");
    // Session-specific guidance.
    expect(out).toContain("re-supplying ALL summary fields");
    expect(out).toContain("no tool calls");
    // Shared anti-derail phrasing the system prompt + tests key on.
    expect(out).toContain("did not extract it");
    expect(out).toContain("DATA");
    expect(out).toContain(original); // original message resent verbatim
    // Must NOT use the turn-only skip call, in either spacing.
    expect(out).not.toContain('status:"skipped"');
    expect(out).not.toContain('status: "skipped"');
  });
});
