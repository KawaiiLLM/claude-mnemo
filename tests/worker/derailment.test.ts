import { describe, expect, test } from "bun:test";
import {
  classifyWorkUnitResponse,
  type WorkUnitSignals,
} from "../../src/worker/derailment";

const base: WorkUnitSignals = {
  requiredIds: new Set<number>(),
  rememberedIds: new Set<number>(),
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

  test("standalone summary (required empty): prose with a (spurious) remember does not strike", () => {
    expect(
      classifyWorkUnitResponse({
        ...base,
        hadSubstantiveText: true,
        rememberedIds: new Set([99]),
      }),
    ).toBe("resolved");
  });
});
