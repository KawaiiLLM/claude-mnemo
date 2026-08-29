import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * THE STALE-TEACHING SENTINEL (peer review A6).
 *
 * Three separate tickets of the lane-model-v12 batch shipped a mechanism change
 * whose PUBLIC TEACHING TEXT still described the mechanism it replaced — the
 * tool describes, the settlement prompt, the plugin docs. Each was caught by a
 * human reading the diff, which is exactly the check that does not scale: the
 * text lives nowhere near the code it describes, so nothing fails when they
 * diverge.
 *
 * This test is the missing coupling. It sweeps every surface a model reads as
 * INSTRUCTION and fails on the vocabulary of retired mechanisms.
 *
 * ## Why two rule classes
 *
 * A retirement notice has to be able to NAME what it retires — "`phases` has
 * retired" is the sentence a caller needs, and a flat ban on the word would
 * force it to be written in riddles. So:
 *
 * - `RETIRED_OUTRIGHT` — phrasings with no legitimate use at all. Nothing needs
 *   to say "closed-valid": the state does not exist and never has to be
 *   mentioned to explain what replaced it.
 * - `RETIREMENT_CONTEXT_ONLY` — words a retirement notice legitimately uses.
 *   These are allowed only within `CONTEXT_RADIUS` characters of a retirement
 *   marker ("retired", "no longer", "legacy", "never", …). A bare occurrence —
 *   the shape of live teaching — fails.
 *
 * The second class is the load-bearing one: it is what catches a describe that
 * still SAYS `depth="expanded"` as an instruction while another paragraph
 * elsewhere in the same file correctly reports the switch as retired.
 */

/**
 * Every surface a model reads as instruction, enumerated rather than globbed —
 * a glob would silently stop covering a surface that moves, and this test's
 * whole value is that the list is complete. `surfaceCoverage` below fails if
 * any entry stops existing.
 *
 * NOT swept: source comments and spec/ticket markdown under `.scratch/`
 * (nobody is instructed by them), and the memory rubric's own concept text,
 * which IS swept — it is injected into both agents verbatim.
 */
const TEACHING_SURFACES: readonly string[] = [
  // MCP tool + parameter descriptions — what the main agent reads before every call.
  "src/mcp/definitions.ts",
  // The settlement agent's own prompt and its settlement-only tool descriptions.
  "src/worker/note-settlement-prompt.ts",
  "src/worker/note-settlement-sdk-query.ts",
  // The injected Memory Rubric (concepts + main-agent actions), byte-identical on both sides.
  "src/shared/memory-rubric.ts",
  // Rendered into every UserPromptSubmit.
  "src/hooks/note-reminder.ts",
  // Everything the plugin ships as prose.
  "plugin/CLAUDE.md",
  "plugin/commands/attach.md",
  "plugin/skills/mnemo-recall/SKILL.md",
  "plugin/skills/mnemo-replay/SKILL.md",
  "plugin/skills/mnemo-timeline/SKILL.md",
];

interface StaleTerm {
  /** Names the retired mechanism, so a failure reads as a diagnosis rather than a regex dump. */
  name: string;
  pattern: RegExp;
  /** What replaced it — the sentence the fixer needs. */
  replacement: string;
}

const RETIRED_OUTRIGHT: readonly StaleTerm[] = [
  {
    name: "closed-valid lane",
    pattern: /closed-valid/gi,
    replacement:
      "lane-model-v12 has no lane quality verdict: a lane is closed when its newest member is an index terminus, open otherwise.",
  },
  {
    name: "an open lane's last declarer",
    pattern: /last declarer|latest declarer|most recent declaring turn/gi,
    replacement:
      "milestone tier ② seats a CLOSED lane's terminus and nothing else — ticket 04 deleted the open-lane seat.",
  },
  {
    name: "lane reopening",
    pattern: /reopen/gi,
    replacement:
      "only `index` moves a lane between open and closed; no relation reopens one, so no teaching surface should name the idea.",
  },
  {
    name: "`remember` as the single write path",
    pattern: /single write path/gi,
    replacement:
      "`note` writes a turn's own note and `remember` maintains a segment and its lanes — two tools, and edges belong to settlement.",
  },
  {
    // Found by mutating this ticket's own repair (M7): the topic describe's
    // retired-registry sentence opens with "Retired", so the whole sentence
    // sits inside a retirement marker's radius — and a WRONG REPLACEMENT
    // instruction hidden in its second half sails through the context rule
    // below. Proximity cannot separate "X is retired" from "X is retired, do Y
    // instead" when Y is also wrong, so the wrong replacement gets its own
    // outright rule, matched on the INSTRUCTION rather than on the retired word.
    name: "a `tags` value invented outside the two closed vocabularies",
    pattern: /theme as a[^.;]{0,40}tag|tag (the segment's|its) member turns/gi,
    replacement:
      "a turn's tags hold its segment's ONE tag and lanes declared in that segment; the write gate refuses every other word, so no teaching surface may offer a third source.",
  },
  {
    name: "the segment card listing lanes",
    pattern: /card lists them|segment card lists|lanes? on the (segment )?card/gi,
    replacement:
      "ticket 18 moved the lane vocabulary onto the SessionStart roster row (and, mid-session, onto the attach receipt); the card lists none.",
  },
];

const RETIREMENT_CONTEXT_ONLY: readonly StaleTerm[] = [
  {
    // NARROWED, staged-settlement spec Rev 5 ticket 01: this rule used to ban
    // the bare word `topic`/`topics` outright, because BOTH senses were
    // retired at once — the registry that named a container, and the `topic:`
    // tag namespace. The namespace is live again (one free subject word per
    // turn), so a bare-word ban now fires on every legitimate live sentence,
    // and worse, it would push a writer to phrase live instruction next to the
    // word "never" or "refuses" just to buy the marker escape. What is still
    // retired is the REGISTRY, and it is matched by its own shapes.
    name: "the topic REGISTRY (the container a `topics` table once named)",
    pattern: /topic registry|\btopic_id\b|remember\(topic/gi,
    replacement:
      "a task is named by its ONE tag, and the retired registry parameter has no replacement. The `topic:` NAMESPACE is a different thing and is LIVE — one free subject word per turn, exempt from the two closed vocabularies.",
  },
  {
    name: "the `phases` timeline view",
    pattern: /\bphases\b/gi,
    replacement: "`view` accepts `turns` and `milestones`; `phases` retired with arc-spine ticket 04.",
  },
  {
    name: "the collapsed/expanded `depth` switch",
    pattern: /\bdepth\b/gi,
    replacement:
      "`filter.fields` selects fields and `turn`/`pageBudget` bound size; `depth` retired and now rejects.",
  },
];

/**
 * A word that marks its neighbourhood as a retirement notice rather than live
 * instruction. Deliberately broad — a false NEGATIVE here costs one stale
 * sentence, while a false positive costs a green suite that cannot describe its
 * own history.
 */
const RETIREMENT_MARKER = /retire|no longer|no more|legacy|never|refus|reject|replaces|replaced|used to/i;

/** Characters either side of a hit that count as its neighbourhood. Wide enough to span one sentence of the surrounding clause. */
const CONTEXT_RADIUS = 140;

/**
 * Collapse line breaks and comment leaders (`//`, ` * `) into single spaces
 * BEFORE matching. Without this, a retirement marker that a prettier-wrapped
 * comment split across two lines ("no\n  // more depth-dependent default")
 * reads as bare and the sweep fires on its own documentation.
 */
function normalizeSurface(text: string): string {
  return text.replace(/\n\s*(\/\/|\*)?/g, "\n").replace(/\s+/g, " ");
}

function excerpt(text: string, start: number, end: number): string {
  return text.slice(Math.max(0, start - 60), end + 60).trim();
}

interface Violation {
  surface: string;
  term: string;
  excerpt: string;
  replacement: string;
}

function sweep(surface: string, text: string): Violation[] {
  const violations: Violation[] = [];
  for (const term of RETIRED_OUTRIGHT) {
    for (const match of text.matchAll(term.pattern)) {
      violations.push({
        surface,
        term: term.name,
        excerpt: excerpt(text, match.index, match.index + match[0].length),
        replacement: term.replacement,
      });
    }
  }
  for (const term of RETIREMENT_CONTEXT_ONLY) {
    for (const match of text.matchAll(term.pattern)) {
      const neighbourhood = text.slice(
        Math.max(0, match.index - CONTEXT_RADIUS),
        match.index + match[0].length + CONTEXT_RADIUS,
      );
      if (RETIREMENT_MARKER.test(neighbourhood)) {
        continue;
      }
      violations.push({
        surface,
        term: term.name,
        excerpt: excerpt(text, match.index, match.index + match[0].length),
        replacement: term.replacement,
      });
    }
  }
  return violations;
}

function formatViolations(violations: readonly Violation[]): string {
  return violations
    .map(
      (violation) =>
        `${violation.surface} teaches "${violation.term}"\n    …${violation.excerpt}…\n    → ${violation.replacement}`,
    )
    .join("\n\n");
}

describe("public teaching surfaces carry no retired lane-model-v12 vocabulary", () => {
  test("every enumerated surface still exists and carries text", () => {
    for (const surface of TEACHING_SURFACES) {
      const text = readFileSync(surface, "utf8");
      expect(text.trim().length).toBeGreaterThan(0);
    }
  });

  test.each(TEACHING_SURFACES)("%s", (surface) => {
    const violations = sweep(surface, normalizeSurface(readFileSync(surface, "utf8")));
    expect(formatViolations(violations)).toBe("");
  });

  /**
   * The sweep's own liveness check. Every rule above is a regex over prose, and
   * a regex that stops matching fails silently and forever — a green sentinel
   * and an absent one look identical. These synthetic surfaces are the shape of
   * the three real defects this ticket repaired, so a rule that rots stops
   * being able to catch its own founding case.
   */
  test("the rules still fire — each class caught on a synthetic surface", () => {
    const outright = sweep(
      "synthetic",
      normalizeSurface("Elected: closed-valid lane termini and open lanes' last declarer."),
    );
    expect(outright.map((violation) => violation.term)).toEqual([
      "closed-valid lane",
      "an open lane's last declarer",
    ]);

    const bare = sweep(
      "synthetic",
      normalizeSurface('Pick a view: `timeline(id="S1", view="phases")` for the phase overview.'),
    );
    expect(bare).toHaveLength(1);
    expect(bare[0]!.term).toBe("the `phases` timeline view");

    // …and the SAME word inside a retirement notice does not fire.
    expect(sweep("synthetic", normalizeSurface("`phases` has retired."))).toEqual([]);
  });
});
