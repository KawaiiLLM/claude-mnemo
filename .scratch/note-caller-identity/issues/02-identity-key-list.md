# 02 — Caller identity survives a resumed session

**What to build:** `note` refuses a write aimed at another session's turn in a
resumed session, naming the cross-session problem, and `crossSession: true`
still gets past it. Today that refusal never happens: the hook records the
session under one environment key and the MCP server looks it up under another,
so identity resolves as unknown and unknown admits.

Both sides stop naming an environment variable directly. One shared derivation
turns an environment into an ordered list of namespaced candidate keys — the
messaging-socket key first (measured to hold the identical string in both
processes), the session-var key as the fallback. The hook records the session
under every key it can derive; the reader tries them in order and takes the
first hit. Deriving nothing, or missing on all of them, still resolves as
unknown and still admits.

Spec: `.scratch/note-caller-identity/spec.md`.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [x] A round-trip test drives the real session-init hook handler to record the
      mapping, then calls the real resolver with an environment that agrees on
      the socket variable and **disagrees** on the session variable, and gets
      back the same mnemo session. Red-checked against the current
      implementation before the fix lands.
- [x] The fresh shape (both variables agree) still resolves — today's behaviour
      is not lost.
- [x] Socket variable absent on both sides, session variable agreeing →
      resolves via the fallback.
- [x] Socket variable absent on both sides, session variable disagreeing →
      unknown, not an error and not a wrong match.
- [x] No recognised variable at all → unknown.
- [x] Through `note`: under a resumed-shape environment, a foreign session's
      turn is refused with the cross-session message, and `crossSession: true`
      gets past it.
- [x] Keys are namespaced by source, so a socket path and a session id cannot
      collide in the map's primary key. No schema change.
- [x] Handler sets built without a resolver — every worker tool channel, every
      test default — still resolve identity as unknown.
- [x] Full suite green.

## Comments

Pid reuse deliberately gets no expiry column: `note` only runs inside a turn,
and the hook claims the key at UserPromptSubmit before that turn's tool calls,
so the upsert has already overwritten a dead session's row by the time any
reader resolves. Recorded here because the absence of an expiry is a decision,
not an oversight.
