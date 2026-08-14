import { describe, expect, test } from "bun:test";

import {
  draftTurnFactsFromTitle,
  draftTypeFromTitle,
  withDraftedTopicTag,
} from "../../src/shared/type-vocabulary";

/**
 * Ticket 02 (spec D7/D8) — the insert-time derivation. Pure, title-only tests:
 * no database, no model. `draftTurnFactsFromTitle` is the sibling that yields
 * BOTH halves; it must always answer the type half through the unmodified
 * `draftTypeFromTitle` so the two never disagree about what a title means.
 */
describe("draftTurnFactsFromTitle", () => {
  test("a recognised activity word resolves the type, and the topic half becomes the tag as written", () => {
    expect(draftTurnFactsFromTitle("fix+worker-retry-race: the retry loop double-fires")).toEqual({
      type: "fix",
      tag: "topic:worker-retry-race",
    });
    expect(draftTurnFactsFromTitle("measure+note-routing: fallback share 32%→4%")).toEqual({
      type: "measure",
      tag: "topic:note-routing",
    });
    expect(draftTurnFactsFromTitle("发版+0.9.0: 迁移完成")).toEqual({
      type: "ops",
      tag: "topic:0.9.0",
    });
  });

  test("an activity word outside the closed vocabulary leaves type empty, but the topic half still lands", () => {
    // The title's SHAPE is well-formed (a "+" then a ":" are both present), so
    // the topic is readable on its own — only the activity word fails to
    // resolve, and D8 says an unrecognised word must never be written.
    expect(draftTurnFactsFromTitle("addendum+the-plan: appended a clause")).toEqual({
      type: null,
      tag: "topic:the-plan",
    });
    expect(draftTurnFactsFromTitle("rolled-back+mutex-change: reverted (settlement-only word)")).toEqual({
      // `rolled-back` is in the vocabulary but has no alias reachable from the
      // mechanical draft path (settlement-only, spec D5) — draftTypeFromTitle
      // itself already returns UNKNOWN for it, and this sibling must agree.
      type: null,
      tag: "topic:mutex-change",
    });
  });

  test("a title not matching the <activity>+<topic>: shape yields neither, and is not an error", () => {
    const malformed = [
      "just a plain title with no delimiters",
      "fix the bug without the shape",
      "fix: no plus sign at all",
      "fix+no colon in this title",
      "+topic-only: missing the activity",
      "fix+: missing the topic",
      "",
      null,
      undefined,
    ] as const;

    for (const title of malformed) {
      expect(draftTurnFactsFromTitle(title)).toEqual({ type: null, tag: null });
    }
  });

  test("is stricter than draftTypeFromTitle alone on a shapeless title", () => {
    // draftTypeFromTitle keeps its looser whole-title prefix scan for the
    // settlement context's rendering (a hint a reviewing model reads); this
    // sibling requires the full <activity>+<topic>: shape before it will
    // write anything to a database column (D8).
    expect(draftTypeFromTitle("review the extraction spec")).toBe("review");
    expect(draftTurnFactsFromTitle("review the extraction spec")).toEqual({
      type: null,
      tag: null,
    });
  });

  test("agrees with draftTypeFromTitle on the type half whenever the shape matches", () => {
    const titles = [
      "implement+shadow-store: notes land in their own table",
      "review+extraction-spec: three candidates compared",
      "design+api-shape: three candidates compared",
    ];
    for (const title of titles) {
      const { type } = draftTurnFactsFromTitle(title);
      const rawDraft = draftTypeFromTitle(title);
      expect(type).toBe(rawDraft === "unknown" ? null : rawDraft);
    }
  });

  test("re-deriving from a corrected title answers fresh, never the stale value — the function is pure", () => {
    const first = draftTurnFactsFromTitle("implement+login-flow: first pass");
    const corrected = draftTurnFactsFromTitle("fix+login-flow: corrected after review");

    expect(first).toEqual({ type: "implement", tag: "topic:login-flow" });
    expect(corrected).toEqual({ type: "fix", tag: "topic:login-flow" });
    expect(corrected.type).not.toBe(first.type);
  });

  test("the drafted topic replaces only its own namespace", () => {
    // A turn's tags are namespaced: `topic:` is the topic facet, a bare word
    // is the session-arc role, and `compact:` / `invalidated:` carry their own
    // machinery. Merging leaves a turn claiming two topics once its title is
    // corrected; replacing the whole list takes the role and the machinery
    // with it. Neither is what a single-valued facet means.
    const existing = [
      "topic:login-flow",
      "rolled-back",
      "compact:trigger=manual",
    ];

    expect(withDraftedTopicTag(existing, "topic:auth-race")).toEqual([
      "rolled-back",
      "compact:trigger=manual",
      "topic:auth-race",
    ]);
    expect(withDraftedTopicTag([], "topic:auth-race")).toEqual([
      "topic:auth-race",
    ]);
  });

  test("null clears the topic facet without setting a replacement (ticket 05)", () => {
    // A corrected title that no longer matches the <activity>+<topic>: shape
    // drafts neither a type nor a tag — the topic facet must not survive that
    // correction any more than the type should. `null` is how a caller says
    // "no topic", distinct from omitting the call entirely.
    const existing = [
      "topic:login-flow",
      "rolled-back",
      "compact:trigger=manual",
    ];
    expect(withDraftedTopicTag(existing, null)).toEqual([
      "rolled-back",
      "compact:trigger=manual",
    ]);
    expect(withDraftedTopicTag([], null)).toEqual([]);
  });
});
