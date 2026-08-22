import { describe, expect, test } from "bun:test";

import {
  findRetiredTopicTag,
  stripClaudeMnemoContextTags,
  stripPrivateTags,
} from "../../src/shared/tag-stripping";

describe("tag stripping", () => {
  test("removes private and claude-mnemo-context tags", () => {
    const input =
      'before<private secret="1">hidden</private>middle<claude-mnemo-context>memory</claude-mnemo-context>after';

    expect(stripPrivateTags(input)).toBe(
      "beforemiddle<claude-mnemo-context>memory</claude-mnemo-context>after",
    );
    expect(stripClaudeMnemoContextTags(input)).toBe("before<private secret=\"1\">hidden</private>middleafter");
  });

  test("limits stripping work by maximum tag count", () => {
    const tooManyPrivateTags = `${"<private>x</private>".repeat(101)}tail`;

    expect(stripPrivateTags(tooManyPrivateTags)).toBe(tooManyPrivateTags);
  });
});

describe("findRetiredTopicTag (round-5 review #16a)", () => {
  test("catches the retired topic: namespace case-insensitively", () => {
    expect(findRetiredTopicTag(["Topic:routing"])).toBe("Topic:routing");
    expect(findRetiredTopicTag(["TOPIC:routing"])).toBe("TOPIC:routing");
    expect(findRetiredTopicTag(["ToPiC:routing"])).toBe("ToPiC:routing");
    // Lowercase (the already-covered case) still works.
    expect(findRetiredTopicTag(["topic:routing"])).toBe("topic:routing");
  });

  test("returns the tag with its ORIGINAL casing preserved, not lowercased", () => {
    const found = findRetiredTopicTag(["Topic:Routing"]);
    expect(found).toBe("Topic:Routing");
  });

  test("a bare tag that merely CONTAINS \"topic:\" mid-string (not as a prefix) is not flagged", () => {
    expect(findRetiredTopicTag(["subtopic:x"])).toBeNull();
  });

  test("no retired-namespace tag present returns null", () => {
    expect(findRetiredTopicTag(["routing", "design"])).toBeNull();
  });
});
