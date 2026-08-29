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

// The compatibility shim (staged-settlement ticket 01). These two names now
// resolve to the `topic:` GRAMMAR — the namespace is live again, so the
// question they answer changed from "does anything claim this namespace" to
// "does anything claim it illegally". Their own contract is tested in
// tests/shared/topic-tag.test.ts; what matters here is that the shim carries
// the new semantics to the one importer that still uses the old names
// (`worker/note-settlement-turn-facade.ts`).
describe("findRetiredTopicTag — the shim over the live topic: grammar", () => {
  test("a legal topic word is NOT flagged — the namespace is no longer retired", () => {
    expect(findRetiredTopicTag(["topic:routing"])).toBeNull();
    expect(findRetiredTopicTag(["some-task", "topic:cache-invalidation"])).toBeNull();
  });

  test("a malformed claim on the namespace is flagged, original casing preserved", () => {
    expect(findRetiredTopicTag(["Topic:Routing"])).toBe("Topic:Routing");
    expect(findRetiredTopicTag(["TOPIC:routing"])).toBe("TOPIC:routing");
  });

  test("a phase-bearing topic word is flagged too — the predicate rides the same shim", () => {
    expect(findRetiredTopicTag(["topic:widget-implement"])).toBe("topic:widget-implement");
  });

  test('a bare tag that merely CONTAINS "topic:" mid-string (not as a prefix) is not flagged', () => {
    expect(findRetiredTopicTag(["subtopic:x"])).toBeNull();
  });

  test("no topic-namespace tag present returns null", () => {
    expect(findRetiredTopicTag(["routing", "design"])).toBeNull();
  });
});
