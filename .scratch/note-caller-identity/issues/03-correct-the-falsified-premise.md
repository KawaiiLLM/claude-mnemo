# 03 — Correct the falsified premise in the identity map's documentation

**What to build:** a reader of the identity map's code is told the mechanism
that was measured, not its opposite. The module doc currently asserts that the
process env var "mints a fresh value each time" while the payload id is stable,
and the hook's write site repeats it ("resume/compact mint a new process id
mid-session"). Both are backwards: the hook holds the stable conversation id,
and it is the long-lived MCP server that holds a snapshot frozen at spawn.

This is what let the bug ship — the comments described a world in which the
single-key join worked, so nobody looked for the case where it could not.

Spec: `.scratch/note-caller-identity/spec.md`, Implementation Decisions
("Documentation correction").

**Blocked by:** 02 — the corrected text has to describe the shape that ticket
lands, not the one it replaces.

**Status:** ready-for-agent

- [x] The identity map module's doc states the measured mechanism: every child
      snapshots the environment at spawn, so a long-lived child holds whatever
      was current when it started while a per-invocation child holds the
      current value.
- [x] The hook write site's comment no longer claims the process id changes
      mid-session, and says instead why every derivable key is written.
- [x] Any test comment repeating the old premise is corrected with it.
- [x] No behaviour change in this ticket; the suite stays green.
