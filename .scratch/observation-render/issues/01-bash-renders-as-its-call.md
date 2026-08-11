# 01 — A Bash observation renders as its command and its output

**What to build:** expanding a turn shows each `Bash` observation as the call it
was — the tool name carrying the command, and the command's real output on the
lines beneath — instead of two truncated blobs of escaped JSON. The `- in:` and
`- out:` labels disappear, because they name where a value was stored rather
than what it is.

This is the tracer bullet: it cuts through the projection, the renderer and the
tests with a single tool in the table, so the shape is settled on the tool that
is 61% of all observations before the rest are added.

Spec: `.scratch/observation-render/spec.md`. Measured payload shapes:
`.scratch/observation-render/survey.md`.

The projection's interface came from a prototype and is the one part worth
pinning here, because a first version projected the two stored sides separately
and an `Edit` then rendered with its diff missing:

```
project(toolName, toolInput, toolResult) -> { header: string, body: string[] }
```

The header is the call's identifying argument; the body is whatever is worth
reading. Neither is tied to a stored side — a `Bash` draws its header from the
input and its body from the result, an `Edit` draws both from the input.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [x] A `Bash` observation renders as the tool name carrying its command, with
      the command's standard output on the lines beneath it, and standard error
      shown when it is non-empty.
- [x] The `- in:` / `- out:` labels are gone from every observation form —
      both the one used when observations are listed and the one used when a
      turn is expanded.
- [x] A body is cut by whole lines against the same character budget the
      renderer already uses, ends with a count of the lines it dropped, and
      never ends mid-line. Blank lines are dropped before counting.
- [x] A body's lines are indented under their header, so a multi-line value can
      no longer reach column zero and break the response's structure.
- [x] A generic rule renders any tool with no table entry: the MCP protocol's
      content array unwraps to its text, an object drops empty, false and null
      values, a single remaining value prints bare, and anything else prints as
      labelled fields.
- [x] The projection is a pure function with no database, renderer or clock,
      tested directly against trimmed copies of real stored payloads.
- [x] A legacy observation — one recorded before the era cutoff — renders
      byte-identically to today.
- [x] The stored payloads are unchanged; the replay path still yields exact
      bytes.
- [ ] Measured before/after on a real turn from this project's own database,
      recorded in the commit message. The spec's 66% came from ten rows and is
      to be re-measured, not repeated.
- [x] `bun run typecheck` clean, `bun run build` clean, full suite green.

## Comments

Red-check every behaviour: run the new test against the current implementation
first and keep the failure. A test that passes before the change does not pin
it — three of the five tests in the last render change would have passed either
way, and the two that mattered were the ones that failed first.
