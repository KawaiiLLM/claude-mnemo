# Spec — an observation renders as the call it was, not as the JSON it was stored in

**Status:** ready-for-agent

Companion to `survey.md` in this directory, which holds the measured payload
shapes this spec is built on.

## Problem Statement

Expanding a turn is the main way to find out what actually happened in it, and
what comes back is unreadable. Each of the turn's observations prints its raw
stored payload — the tool's input JSON and its result JSON, each cut at 200
characters — so a reader gets escaped newlines, structural keys, and, for the
file-editing tools, a verbatim copy of the input followed by the beginning of
the whole pre-edit file.

Measured on this project's own database, on the 449 observations recorded since
the era cutover:

- A `Bash` observation shows `{"command":"git diff --stat && echo \"=== …` and
  `{"stdout":" plugin/scripts/hook-command.cjs         | 235 ++++…`. The command
  and its output are both in there, wrapped in quoting the reader has to undo.
- An `Edit` observation's result repeats its input exactly — `oldString` equals
  `old_string` in 62 of 62 rows — and adds `originalFile`, the entire pre-edit
  file, at a median of 23,494 characters against `old_string`'s median of 172.
  Nothing in the result is information the input did not already carry.
- Every `mcp__*` result is a JSON array, so it renders as `[{"type":"text",…`
  rather than as the text.

The cost lands twice. A reader pays for characters that carry no meaning, and
the meaning they came for is pushed past the truncation window. Expanding one
turn of this session costs roughly ten times what collapsing it does, and most
of that multiple is quoting.

## Solution

An observation renders as the call it was. The tool name carries an
identifying argument in parentheses, and whatever is worth reading appears
beneath it — the same shape Claude Code itself uses for a tool call in the
transcript, and the same shape this renderer already uses for a file tree.

```
    - [O72016] Bash(git diff --stat && echo "=== 测试 ===" && bun test 2>&1 | grep -E "…")
         plugin/scripts/hook-command.cjs         | 235 ++++++++++------------
         plugin/scripts/mcp-server.cjs           | 337 ++++++++++++++++--------
        … +18 lines
    - [O72019] Edit(recall.ts)
        -     title: observation.title ?? observation.toolName ?? `Observation ${observation.id}`,
        -     content: observation.content,
        +     title: observation.title ?? observation.toolName ?? null,
        … +20 lines
```

The `- in:` / `- out:` labels are gone. They named the storage, not the
content, and the two sides do not correspond to what a reader wants: an
`Edit`'s meaning is entirely in its input, a `Read`'s is entirely in its
result, and a `Bash` draws its header from one side and its body from the
other.

Measured on ten real observations from this session, the block shrinks from
3,953 characters to 2,600 — 66% — while showing four lines of real output where
it used to show one line of quoting.

## User Stories

1. As a reader expanding a turn, I want an observation's command to appear as
   the command, so that I can read what was run without mentally unescaping it.
2. As a reader, I want a tool's output to appear as output lines, so that a
   grep result or a test summary reads the way it did when it was produced.
3. As a reader, I want an `Edit` to show me what changed, so that I do not have
   to open the replay skill to learn whether a line was added or removed.
4. As a reader, I want an `Edit`'s result to take no space at all, since it
   repeats its input and appends the whole file.
5. As a reader, I want a `Read` to tell me the file and how much of it was
   read, rather than replaying the file's contents into my context.
6. As a reader, I want a `Write` to show the path and the beginning of what was
   written, so that I can tell a stub from a finished document.
7. As a reader, I want an `mcp__*` call to show its text result rather than the
   protocol envelope that carries it.
8. As a reader, I want a dispatched background agent to say that its report is
   not stored with the call, so that an empty body does not read as "it
   returned nothing".
9. As a reader, I want a file path in a header shortened to its basename, since
   the same prefix repeats on every line of a render whose session header
   already names the project.
10. As a reader, I want a body that was cut to say how many lines it dropped, so
    that I can judge whether to go and read the rest.
11. As a reader, I want the cut to land on a whole line, so that the last thing
    I see is not half a token.
12. As a reader, I want a multi-line value's continuation lines indented under
    their field, so that the response's structure still says which observation
    they belong to.
13. As a reader, I want blank lines inside a value dropped, so that the budget
    buys content rather than vertical space.
14. As a reader, I want the same rendering whichever read surface I came
    through, so that a session does not read differently in `recall` than in
    `timeline`.
15. As a maintainer, I want an unknown tool to render acceptably without anyone
    having added it to a table, so that a new tool in Claude Code degrades
    rather than breaks.
16. As a maintainer, I want a projection whose expected key is missing to fall
    through to the generic rule, so that a payload-shape change upstream can
    never render an empty body that silently claims a call did nothing.
17. As a maintainer, I want the raw payloads left in the database untouched, so
    that the replay skill still reproduces exact bytes.
18. As a maintainer, I want legacy observations to keep rendering as they do
    today, so that this changes what a NEW row looks like and not what the
    archive says.
19. As a maintainer, I want the projection to be a pure function of the stored
    payload, so that it can be tested against real captured payloads without a
    database or a renderer.
20. As a maintainer, I want every tool name present in the era to be either
    projected or provably handled by the fallback, so that "we covered the
    common ones" is a checked claim rather than an impression.

## Implementation Decisions

**The projection returns a header and a body, not an input and an output.**
This is the decision the prototype forced. A first version projected each side
separately and, once the labels were removed, an `Edit` collapsed to
`Edit(path …+2)` with its diff gone: the meaningful content of an edit lives in
its *input*, so a body drawn from the result had nothing to show. The interface
is therefore

```
project(toolName, toolInput, toolResult) -> { header: string, body: string[] }
```

with the header being the call's identifying argument and the body being
whatever is worth reading, from whichever side holds it.

**Projection rules are scoped to (tool, side, key), never to a key name
alone.** The survey settles this with counts: `content` is a whole file to be
dropped in `Write`'s input, the note's text to be kept in `note`'s input, and
meaningful only when `status` is `completed` in `Agent`'s result. `description`
restates the command in `Bash` and is the task's title in `Agent`. `type` is a
useful create/update flag in `Write`'s result and a constant in `Read`'s. A
global denylist was tried in the prototype and silently removed `Agent`'s
title.

**A projection table covers the tools that occur, and a generic rule catches
the rest.** Ten tool names exist in the era; `Bash` alone is 61% and the top six
are 98.2%. The table is not an attempt at completeness — it is the set for which
the generic rule demonstrably produces something worse.

**Known result payloads that carry nothing render no body at all.** `Edit` and
`Write` results are duplicates of their inputs plus bulk; they contribute a
success marker at most. This is the single largest saving in the change.

**A dispatched background agent is a documented hole, not an empty body.** In 11
of 13 sampled rows an `Agent` result is a launch stub whose `status` is
`async_launched`, pointing at an ephemeral temporary path; the completion report
arrives later as a turn-level notification and never becomes a second
observation. The body must say the report is not stored with the call. Rendering
nothing would assert something false.

**MCP results are unwrapped unconditionally.** All 41 era rows and every legacy
MCP row are the protocol's content array; taking its text is safe to bake into
the generic rule rather than into per-tool entries.

**Bodies are cut by whole lines against the same character budget**, ending in
`… +N lines`. This generalises `truncateFileTree`, which already does exactly
this for one field, rather than introducing a second budgeting concept. Blank
lines are dropped before counting. Continuation lines are indented under the
header.

**A file path in a header is its basename.** The full path repeats on every line
of a render whose session header already states the project root.

**Era-gated, like every other observation field.** A legacy row's record is its
extractor's summary and must keep rendering as it does; the projection applies
only to rows at or after the era cutoff, which are the rows that carry raw tool
fields at all.

**Nothing about storage changes.** The payloads stay as they are; the replay
skill remains the way to get exact bytes.

## Testing Decisions

A good test here asserts what a reader sees for a given stored payload, and
never how the projection is organised internally. The projection is the natural
seam: a pure function from `(toolName, toolInput, toolResult)` to a header and
body, with no database, no renderer, and no clock. It is the only new seam this
spec asks for.

- **Projection tests, against real captured payloads.** Fixtures are trimmed
  copies of actual rows — one per projected tool, plus one MCP array, plus one
  unknown tool — kept small by eliding long values. Invented payloads would test
  the shapes we imagined; the whole point of the survey was that several of them
  are not what we imagined.
- **Coverage test.** Every tool name the survey found in the era either has a
  table entry or produces a non-empty header through the generic rule. This is
  what makes "98.2% covered" a checked property rather than a claim in a
  document.
- **Degradation tests.** A projected key removed from a payload must fall
  through to the generic rule, not yield an empty body. A result that is a bare
  string, an array of mixed shapes (the survey found one such tool), or `null`
  must not throw.
- **Renderer tests at the existing seam** (`renderNode` / the expanded
  observation form) for the header-and-body layout, the line-aware cut, the
  `… +N lines` marker, the indentation of continuation lines, and the absence of
  the `- in:` / `- out:` labels. Prior art: the truncation-boundary block in
  `tests/mcp/format.test.ts` and the era-gated observation assertions in
  `tests/mcp/recall.segments.test.ts`.
- **Era test.** A legacy observation renders byte-identically to today.
- **A measured before/after** on a real turn, recorded in the ticket when it
  lands. The 66% figure in this spec came from ten real rows and should be
  re-measured rather than repeated.

## Out of Scope

- **A third depth between collapsed and expanded.** Expanding a turn currently
  costs about ten times collapsing it, and most of that multiple is the five
  observations it expands. A "turn's own fields, without its observations" rung
  is the obvious answer, but this spec removes most of the cost that motivates
  it — the question should be re-asked with the new numbers rather than answered
  now.
- **Indexing the projected text instead of the raw payload.** Search currently
  indexes the first 500 characters of each raw payload; projecting first would
  index more meaning per character. It is a change to search behaviour and
  belongs to its own spec.
- **The timeline's token-level trimmer.** It fits a rendered line to a token
  budget after the field truncator has run, and it is not a field cut.
- **`- desc:` and the session-level fields**, which are prose rather than
  payloads and are already line-oriented where it matters.
- **Changing what is stored.** No migration, no schema change.

## Further Notes

The survey that grounds this spec found three things worth carrying into the
implementation, each with row counts behind it: an `Edit` result is a verbatim
duplicate of its input in every sampled row; a `Write` result's `originalFile`
is `null` for creates (24 of 30) so any diff-shaped projection must branch on
`type` before reaching for it; and one tool's result array mixes bare strings
with objects, so the generic rule's array branch needs a shape guard or it
throws.

The projection encodes knowledge of Claude Code's tool payloads, which is an
external contract that will move. The generic fallback is not a convenience —
it is what makes that acceptable, and the degradation tests are what keep it
honest.
