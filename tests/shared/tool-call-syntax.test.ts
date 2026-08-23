import { beforeEach, describe, expect, test } from "bun:test";

import {
  clearToolCallSyntaxRejections,
  containsToolCallSyntax,
  parseGluedToolCall,
  recordToolCallSyntaxRejection,
  resetToolCallSyntaxRejectionsForTests,
  toolCallSyntaxLoopMessage,
  toolCallSyntaxMessage,
} from "../../src/shared/tool-call-syntax";

/**
 * Every markup fragment below is ASSEMBLED, never written whole. Two reasons,
 * one of them learned the hard way while writing this file: a literal
 * `antml:`-prefixed closing tag in a source file is itself parsed as the end
 * of a tool call by the harness that writes the file, so the file cannot be
 * written; and a test file is source too — a complete well-formed call sitting
 * in it is one more exemplar for anything that later reads this repo.
 */
const LT = "<";
const OPEN = (name: string): string => `${LT}parameter name="${name}">`;
const CLOSE = `${LT}/parameter>`;
const NS_OPEN = (name: string): string => `${LT}antml:parameter name="${name}">`;
const NS_CLOSE = `${LT}/antml:parameter>`;
const CALL_END = `\n${LT}/invoke>\n${LT}/function_calls>`;
const fieldNamedClosing = (name: string): string => `${LT}/${name}>`;

/** The production shape: one fake closing, one parameter glued, tail unclosed. */
const SINGLE_GLUE = `Kept prose.${fieldNamedClosing("content")}\n${OPEN("insight")}Reusable lesson.`;

/** The drift repeating: every parameter closed by its own field name. */
const MULTI_GLUE =
  `Kept prose.${fieldNamedClosing("content")}\n` +
  `${OPEN("insight")}Lesson.${fieldNamedClosing("insight")}\n` +
  `${OPEN("type")}design${fieldNamedClosing("type")}\n` +
  `${OPEN("tags")}mnemo${CLOSE}${CALL_END}`;

describe("containsToolCallSyntax", () => {
  test("fires on parameter, invoke, function_calls and antml-prefixed markup", () => {
    expect(containsToolCallSyntax(`x ${OPEN("insight")}`)).toBe(true);
    expect(containsToolCallSyntax(`x ${CLOSE}`)).toBe(true);
    expect(containsToolCallSyntax(`x ${NS_OPEN("insight")}`)).toBe(true);
    expect(containsToolCallSyntax(`x ${NS_CLOSE}`)).toBe(true);
    expect(containsToolCallSyntax(`x ${LT}invoke name="note">`)).toBe(true);
    expect(containsToolCallSyntax(`x ${LT}/function_calls>`)).toBe(true);
  });

  test("does not fire on ordinary prose, or on a field-named tag alone", () => {
    // A closing tag named after the field is NOT itself the tripwire — it is
    // only ever seen because a real parameter tag rode in behind it.
    expect(containsToolCallSyntax(`Kept prose.${fieldNamedClosing("content")}`)).toBe(false);
    expect(containsToolCallSyntax("a < b and c > d, 3<4")).toBe(false);
    expect(containsToolCallSyntax("the parameter closing tag")).toBe(false);
  });
});

describe("parseGluedToolCall — strict recovery parse", () => {
  test("reads the single-glue production shape: field-named closing, one parameter carried in", () => {
    expect(parseGluedToolCall("content", SINGLE_GLUE)).toEqual({
      closingTagName: "content",
      gluedParameters: ["insight"],
    });
  });

  test("reads a repeated drift: every parameter after the first closing, in order", () => {
    expect(parseGluedToolCall("content", MULTI_GLUE)).toEqual({
      closingTagName: "content",
      gluedParameters: ["insight", "type", "tags"],
    });
  });

  test("accepts the antml-prefixed spelling of the same shape, call end included", () => {
    const text =
      `Kept prose.${fieldNamedClosing("content")}\n` +
      `${NS_OPEN("insight")}Lesson.${NS_CLOSE}` +
      `\n${LT}/antml:invoke>\n${LT}/antml:function_calls>`;
    expect(parseGluedToolCall("content", text)).toEqual({
      closingTagName: "content",
      gluedParameters: ["insight"],
    });
  });

  test("splits at the FIRST field-named closing, so a later one is part of a glued value", () => {
    const text =
      `Prose.${fieldNamedClosing("content")}\n${OPEN("insight")}` +
      `a mention of ${fieldNamedClosing("content")} inside the glued value${CLOSE}`;
    // The value's own boundary is the real parameter close; the second
    // field-named tag is just text the model wrote.
    expect(parseGluedToolCall("content", text)).toEqual({
      closingTagName: "content",
      gluedParameters: ["insight"],
    });
  });

  test("takes the last dotted segment for a nested field label", () => {
    const text = `Prose.${fieldNamedClosing("newString")}\n${OPEN("insight")}x`;
    expect(parseGluedToolCall("mode.content.newString", text)).toEqual({
      closingTagName: "newString",
      gluedParameters: ["insight"],
    });
  });

  // The strictness criterion: anything that does not parse as field blocks
  // plus an optional call end returns null, and the caller falls back to the
  // generic message. A misattributed echo ("your insight did not land" when it
  // did) would send the caller to rewrite a field that was never the problem.
  test("returns null when there is no field-named closing tag at all", () => {
    expect(parseGluedToolCall("content", `Prose with a stray ${OPEN("insight")}tail`)).toBeNull();
  });

  test("returns null when prose follows the parsed blocks", () => {
    const text =
      `Prose.${fieldNamedClosing("content")}\n${OPEN("insight")}Lesson.${CLOSE}\n` +
      "and then the model kept writing ordinary sentences.";
    expect(parseGluedToolCall("content", text)).toBeNull();
  });

  test("returns null when the tail carries markup that is not a parameter block", () => {
    const text = `Prose.${fieldNamedClosing("content")}\n${LT}invoke name="note">`;
    expect(parseGluedToolCall("content", text)).toBeNull();
  });

  test("returns null when the tail opens a parameter without a name attribute", () => {
    const text = `Prose.${fieldNamedClosing("content")}\n${LT}parameter>value${CLOSE}`;
    expect(parseGluedToolCall("content", text)).toBeNull();
  });

  test("returns null when the field-named closing is the whole tail (nothing rode in)", () => {
    expect(parseGluedToolCall("content", `Prose.${fieldNamedClosing("content")}`)).toBeNull();
  });

  // The only text from the offending field that can reach the message is a
  // parameter NAME, and the name charset excludes every character markup is
  // built from. That is what keeps the no-markup red line safe against a
  // hostile or merely strange payload, rather than trust in the fixtures.
  test("a parameter name carrying markup characters does not parse, so it can never reach the message", () => {
    const hostile = `Prose.${fieldNamedClosing("content")}\n${OPEN(`x${LT}invoke y`)}v`;
    expect(parseGluedToolCall("content", hostile)).toBeNull();
    const message = toolCallSyntaxMessage("content", hostile);
    expect(message).toBe(toolCallSyntaxMessage("content"));
    expect(containsToolCallSyntax(message)).toBe(false);
  });
});

describe("toolCallSyntaxMessage", () => {
  test("the generic message names the field and says nothing was stored", () => {
    const message = toolCallSyntaxMessage("content");
    expect(message).toContain("content");
    expect(message).toContain("tool-call syntax");
    expect(message).toContain("Nothing was stored");
  });

  test("with the offending text it names, in prose, the fake closing and the parameter that rode in", () => {
    const message = toolCallSyntaxMessage("content", SINGLE_GLUE);
    expect(message).toContain("content");
    expect(message).toContain("insight");
    expect(message).toContain("literal text");
    expect(message).toContain("Nothing was stored");
    // Prose, not markup: the reader is told WHAT was written, never shown it.
    expect(message).not.toContain(LT);
  });

  test("names every glued parameter, comma-listed, when the drift repeated", () => {
    const message = toolCallSyntaxMessage("content", MULTI_GLUE);
    expect(message).toContain("insight, type and tags");
    expect(message).toContain("were");
    expect(message).not.toContain(LT);
  });

  test("falls back to the generic message on a tail the strict parse rejects", () => {
    const nonConforming =
      `Prose.${fieldNamedClosing("content")}\n${OPEN("insight")}Lesson.${CLOSE}\n` +
      "and then ordinary sentences.";
    expect(toolCallSyntaxMessage("content", nonConforming)).toBe(
      toolCallSyntaxMessage("content"),
    );
  });

  // The self-referential guarantee: the rejection returns straight into the
  // caller's context, so a message that quoted the markup would plant the very
  // exemplar the guard exists to break. Asserted with the guard itself.
  test("no message this module produces would trip the guard it belongs to", () => {
    const messages = [
      toolCallSyntaxMessage("content"),
      toolCallSyntaxMessage("content", SINGLE_GLUE),
      toolCallSyntaxMessage("content", MULTI_GLUE),
      toolCallSyntaxMessage("mode.content.newString", MULTI_GLUE),
      toolCallSyntaxLoopMessage("S1/T2", 2),
      toolCallSyntaxLoopMessage("S1/T2", 7),
      `${toolCallSyntaxMessage("content", MULTI_GLUE)} ${toolCallSyntaxLoopMessage("S1/T2", 2)}`,
    ];
    for (const message of messages) {
      expect(containsToolCallSyntax(message)).toBe(false);
    }
  });
});

describe("consecutive-rejection counter", () => {
  beforeEach(() => {
    resetToolCallSyntaxRejectionsForTests();
  });

  test("counts a run per address and returns the run length", () => {
    expect(recordToolCallSyntaxRejection("S1/T2")).toBe(1);
    expect(recordToolCallSyntaxRejection("S1/T2")).toBe(2);
    expect(recordToolCallSyntaxRejection("S1/T2")).toBe(3);
  });

  test("addresses are independent — one loop does not implicate another turn", () => {
    recordToolCallSyntaxRejection("S1/T2");
    recordToolCallSyntaxRejection("S1/T2");
    expect(recordToolCallSyntaxRejection("S1/T3")).toBe(1);
    expect(recordToolCallSyntaxRejection("S1/T2")).toBe(3);
  });

  test("clearing one address restarts only that run", () => {
    recordToolCallSyntaxRejection("S1/T2");
    recordToolCallSyntaxRejection("S1/T3");
    clearToolCallSyntaxRejections("S1/T2");
    expect(recordToolCallSyntaxRejection("S1/T2")).toBe(1);
    expect(recordToolCallSyntaxRejection("S1/T3")).toBe(2);
  });

  test("the loop message names the address and the run length, and says what to do instead", () => {
    const message = toolCallSyntaxLoopMessage("S1/T2", 3);
    expect(message).toContain("S1/T2");
    expect(message).toContain("3");
    expect(message.toLowerCase()).toContain("settlement");
    expect(message.toLowerCase()).toContain("compact");
  });
});
