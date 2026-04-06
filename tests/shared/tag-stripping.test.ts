import { describe, expect, test } from "bun:test";

import {
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
