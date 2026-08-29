import { describe, expect, test } from "bun:test";

import {
  TOPIC_PHASE_TOKENS,
  checkTopicTag,
  findIllegalTopicTag,
  isTopicTag,
  topicTagsOf,
} from "../../src/shared/topic-tag";

/**
 * The `topic:` grammar (staged-settlement spec Rev 5, ticket 01). Every test
 * here asserts a VERDICT and the load-bearing part of its wording — the
 * candidate a caller is told to copy, or the token/law a refusal names —
 * because the refusal's content IS the contract: "refused" alone leaves a
 * caller guessing, which is the failure the derivable/non-derivable boundary
 * exists to prevent.
 */
describe("canonical form", () => {
  test("a lowercase hyphenated word is accepted, payload exposed", () => {
    const verdict = checkTopicTag("topic:map-extraction");
    expect(verdict.ok).toBe(true);
    expect(verdict.ok && verdict.payload).toBe("map-extraction");
  });

  test("digits are part of the charset", () => {
    expect(checkTopicTag("topic:sqlite3-wal").ok).toBe(true);
  });

  test("a single word with no hyphen is fine", () => {
    expect(checkTopicTag("topic:routing").ok).toBe(true);
  });
});

describe("refusal boundary — derivable repairs show the candidate", () => {
  // The four repairs the spec names as mechanically derivable AND unique.
  const derivable: ReadonlyArray<readonly [string, string]> = [
    ["topic:Map-Extraction", "topic:map-extraction"],
    ["topic:  routing  ", "topic:routing"],
    ["topic:-routing-", "topic:routing"],
    ["topic:map--extraction", "topic:map-extraction"],
    ["Topic:routing", "topic:routing"],
  ];

  for (const [raw, candidate] of derivable) {
    test(`${JSON.stringify(raw)} is refused showing ${JSON.stringify(candidate)}`, () => {
      const verdict = checkTopicTag(raw);
      expect(verdict.ok).toBe(false);
      expect(verdict.ok === false && verdict.candidate).toBe(candidate);
      expect(verdict.ok === false && verdict.message).toContain(candidate);
    });
  }

  test("NFC is one of the four — a decomposed form is repaired, not rejected outright", () => {
    // "café" decomposed: e + U+0301. Not in the charset either way, so what
    // this pins is that composition happens BEFORE the charset verdict, which
    // is what makes the boundary reproducible rather than order-dependent.
    const verdict = checkTopicTag("topic:café-notes");
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.candidate).toBeNull();
    // The composed character is what the caller is shown, not the raw pair.
    expect(verdict.ok === false && verdict.message).toContain('"é"');
  });
});

describe("refusal boundary — non-derivable input never fabricates a candidate", () => {
  test("CJK shows the pattern and the offending characters", () => {
    const verdict = checkTopicTag("topic:缓存失效");
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.candidate).toBeNull();
    const message = verdict.ok === false ? verdict.message : "";
    expect(message).toContain('"缓"');
    expect(message).toContain("lowercase letters, digits");
    // The whole point: nothing that looks like "write this instead".
    expect(message).not.toContain("instead");
  });

  test("interior whitespace is NOT repaired — space-to-hyphen would be a judgment", () => {
    const verdict = checkTopicTag("topic:visual direction");
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.candidate).toBeNull();
    expect(verdict.ok === false && verdict.message).toContain('" "');
  });

  test("arbitrary symbols are named, de-duplicated, in first-occurrence order", () => {
    const verdict = checkTopicTag("topic:a&b&c/d");
    expect(verdict.ok).toBe(false);
    const message = verdict.ok === false ? verdict.message : "";
    expect(message).toContain('"&", "/"');
  });

  test("an empty payload says so rather than naming characters", () => {
    const verdict = checkTopicTag("topic:");
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.candidate).toBeNull();
    expect(verdict.ok === false && verdict.message).toContain("empty once trimmed");
  });
});

describe("phase-token predicate", () => {
  test("the closed set is the spec's, unchanged in size", () => {
    // A guard on the LIST, not on judgment: the set is a spec artifact, and
    // silently growing or shrinking it is a spec revision wearing an
    // implementation's clothes.
    expect(TOPIC_PHASE_TOKENS.size).toBe(67);
  });

  test("a trailing phase token refuses, naming the token and the law", () => {
    const verdict = checkTopicTag("topic:widget-implement");
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.violation).toBe("phase-token");
    const message = verdict.ok === false ? verdict.message : "";
    expect(message).toContain('"implement"');
    expect(message).toContain("type is the phase axis");
  });

  test("the known false positive is refused too — the cost is accepted, not patched around", () => {
    const verdict = checkTopicTag("topic:visual-design");
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.message).toContain('"design"');
    // And its documented rewrite passes.
    expect(checkTopicTag("topic:visual-direction").ok).toBe(true);
  });

  test("the fixture's canonical refused example", () => {
    expect(checkTopicTag("topic:s11bin-editor-verification").ok).toBe(false);
  });

  test("a subject word that merely CONTAINS a phase token as a substring is accepted", () => {
    // Tokenized on "-", never on substrings: `testament` is not `test`.
    expect(checkTopicTag("topic:testament-parser").ok).toBe(true);
    expect(checkTopicTag("topic:opsec-review-board").ok).toBe(false); // `review` IS its own token
    expect(checkTopicTag("topic:opsec").ok).toBe(true);
  });

  test("deliberately excluded words stay legal subjects", () => {
    for (const word of ["delivery", "release", "audit", "debug"]) {
      expect(checkTopicTag(`topic:${word}-pipeline`).ok).toBe(true);
    }
  });

  test("canonical form is judged BEFORE the phase predicate — one refusal at a time", () => {
    const verdict = checkTopicTag("topic:Widget-Implement");
    expect(verdict.ok).toBe(false);
    // The spelling problem is the one it can repair, so it is the one it says.
    expect(verdict.ok === false && verdict.violation).toBe("non-canonical");
  });
});

describe("namespace detection", () => {
  test("case-insensitive, so a capitalized prefix is a malformed topic word rather than a stray tag", () => {
    expect(isTopicTag("Topic:routing")).toBe(true);
    expect(isTopicTag("subtopic:routing")).toBe(false);
    expect(isTopicTag("routing")).toBe(false);
  });

  test("findIllegalTopicTag returns the first offender and ignores legal words", () => {
    expect(findIllegalTopicTag(["task-a", "topic:routing"])).toBeNull();
    expect(findIllegalTopicTag(["topic:routing", "topic:a b", "topic:c d"])).toBe("topic:a b");
  });

  // Absorbed from the tag-stripping shim's own tests when ticket 08 deleted it:
  // both refusal CLASSES reach this entry point, and a bare tag that merely
  // contains the prefix mid-string is not one of them.
  test("both refusal classes reach findIllegalTopicTag, and a mid-string prefix is not a claim", () => {
    expect(findIllegalTopicTag(["Topic:Routing"])).toBe("Topic:Routing");
    expect(findIllegalTopicTag(["topic:widget-implement"])).toBe("topic:widget-implement");
    expect(findIllegalTopicTag(["subtopic:x"])).toBeNull();
    expect(findIllegalTopicTag(["routing", "design"])).toBeNull();
  });

  test("topicTagsOf keeps input order and drops everything bare", () => {
    expect(topicTagsOf(["topic:b", "task", "topic:a"])).toEqual(["topic:b", "topic:a"]);
  });
});
