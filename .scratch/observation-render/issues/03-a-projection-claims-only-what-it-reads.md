# 03 — A projection claims only what it can read

**What to build:** a rendered observation never says something the stored
payload does not support. Today's projection claims a payload on a partial
signal — one expected key exists, an array has one item with `text`, an MCP
tool's basename matches — and then discards everything it did not match. Five
of the eight defects a Codex review of `d4e85aa` found are that single error,
and all five were reproduced by calling the projection directly.

The governing rule this ticket establishes: **a projection may claim a payload
only if it fully recognises it. Anything it does not recognise falls through to
the generic rule, and the generic rule never drops content it cannot
classify.** An empty body must mean "this call produced nothing", never "the
projection did not understand the result".

Spec: `.scratch/observation-render/spec.md`. Measured payload shapes:
`.scratch/observation-render/survey.md`.

**Blocked by:** 01, 02 — both landed in `d4e85aa`; this repairs them.

**Status:** ready-for-agent

## Renders something untrue

Each was reproduced against the current build; the payload and the wrong output
are given so the fix can be red-checked with the same input.

- [x] A dispatched agent's body claims a later report only when the stored
      result actually is a launch stub. `{"status":"completed","error":"crashed"}`
      currently renders `report not stored with this call — it arrives later as
      a turn-level notification`, promising a report that will never come.
- [x] A `Bash` result whose shape is not the recognised one falls through to the
      generic rule rather than rendering an empty body.
      `{"output":"permission denied"}` and `{"stdout":42}` both currently render
      `body: []`, discarding the only information the call produced.
- [x] An array is treated as the MCP content envelope only when every item is
      that shape. `["warning",{"text":"ok"},{"error":"failed"}]` currently
      renders `["ok"]`, silently dropping two of three items.
- [x] A multi-line command's header cannot read as a different valid command.
      `echo one\necho two` — two commands — currently renders
      `Bash(echo one echo two)`, which reads as one `echo` call with four
      arguments. Losing the boundary is acceptable; inventing a plausible
      different command is not. A visible marker is one way; joining with `; `
      is not, because the corpus has newlines inside quoted heredoc and SQL
      strings where a semicolon would corrupt the command.
- [x] An MCP tool is projected only when its full name identifies the server
      whose payload shape the rule was written from. A hypothetical
      `mcp__other_server__note` currently receives mnemo's projection and loses
      its `content`, which is the same "keyed on a name rather than on the tool"
      error ticket 02 forbids.

## Budget arithmetic

- [x] The line budget does not charge a separator after the final line. With a
      limit of 3, `["a","b"]` renders as three characters and must keep both
      lines rather than dropping one and reporting `… +1 lines`.
- [x] The truncation signal is set when and only when something was actually
      dropped — the case above currently sets it wrongly.
- [x] A header cut small enough to reach the tool name degrades to something
      that still identifies the call. At a limit of 1, `Bash(ls)` currently
      becomes `B…)`. It now spends the budget on the argument and keeps the name
      whole, degrading to the bare `Bash`; that the name may then exceed the
      budget is deliberate, since a name is a few dozen characters and a header
      identifying nothing costs more than the characters it saves.
- [x] A single line longer than the whole budget is **cut inside itself, not
      dropped**, and the two cuts stay apart in the output: a line cut inside
      ends in the truncation mark, whole lines that were dropped are counted by
      the trailing `… +N lines`. The behaviour is what the code already did; the
      contract is what was wrong, and it now reads "the budget is spent by whole
      lines, and a line that alone exceeds it is cut inside, on a word boundary
      where one is near". The alternative — never cutting inside a line — must
      either print the line whole, blowing the budget by up to a hundredfold, or
      drop it, and a body whose first line is the long one then renders as
      `… +N lines` and nothing else: a call reported as having produced output
      with none of it shown, which is the same untruth an empty body tells. It
      is not a rare shape — 22 of the 304 era `Bash` rows carrying output have a
      line longer than the default 200-character budget, and one of those rows'
      whole output is a single such line, so it would render with no content at
      all.

## Tests that pin the defect

- [x] The mixed-array test no longer asserts that data loss is expected
      behaviour.
- [x] The long-line test asserts the contract this ticket settles, not whatever
      the implementation happens to do.
- [x] Both are re-derived from the ticket's wording rather than from the code's
      output. Both passed their red check and still locked in a defect, which is
      what a red check cannot catch: it proves new behaviour differs from old,
      never that it is right.

- [x] `bun run typecheck` clean, `bun run build` clean, full suite green (1586
      pass, up from 1578).

## Comments

Every "renders something untrue" item is worse than an ugly render: a reader —
human or model — has no way to tell a confident wrong answer from a correct
one, and recall exists to be trusted. Prefer a fallback that looks clumsy over
a projection that looks clean and is wrong.

### On the long-line rule, and one measurement this ticket got wrong

The figure that motivated the question — a single `stdout` line of 20,802
characters — is the longest whole `stdout` *field* in the era, not a single
line: it is a many-line output, and the survey's `max 20802` counts the field.
Re-measured read-only against the same database, the longest single era line is
1,973 characters, 22 of the 304 era `Bash` rows carrying output have a line
over the 200-character default, and exactly one row's entire output is a single
over-long line. The corrected numbers do not change the answer — they are what
the "never cut inside a line" rule would have to render as `… +1 lines` and
nothing else — and the ceiling is real rather than hypothetical: legacy `Bash`
rows, which this renderer never sees, hold a 30,000-character single line, so
printing an over-long line whole is unbounded in practice.

The two rules also differ in what the reader can tell afterwards. Cutting inside
a line leaves the mark on the line it cut, and `truncateText` retreats to a word
boundary, so the last thing read is a whole word — the spec's user story 11
concern, which is about ending mid-token and not about the count of lines.
Dropping the line leaves a count with nothing to count against.

The consequence for the red check is worth stating plainly: this is the one item
of the four under "Budget arithmetic" where the code does not move. The defect
was in the contract — the comment and this ticket said "whole lines" while the
code cut inside one — so the test now pins the stated rule (a long line is shown
cut, and is therefore *not* also counted among the dropped lines) rather than
failing first against the old build.

### One thing this ticket did not ask for

The era has grown two tool names since the survey — `SendMessage` and `WebFetch`
— so ticket 02's coverage list, which asserted ten, no longer covered the era it
claims to. Both were added as trimmed fixtures, and both reach a reader through
the generic rule alone, which is the rule everything this ticket touched now
falls through to. Re-run read-only over all 591 era rows, the projection leaves
an empty body on 11 of them, all `Bash`, and every one of those really did print
nothing.

Also measured on those 591 rows: 136 headers carry the new line mark, 124 of
them `Bash`. That is 38% of era `Bash` calls whose header, until now, read as a
single command that was never run.
