# 01 — The completion floor never auto-skips a turn carrying an actual response

**What to build:** an unnoted finished turn floors to `skipped` ONLY when it
carries no actual response (`assistant_response` empty/whitespace — no-reply
slash commands and empty notification spins are the type cases; the response
test subsumes `isNoReplySlashCommandPrompt` by construction). With an actual
response it floors to `extracted` — the already-recognized noteless-extracted
state (`getStrandedTurns`' second branch, capture-repair writes it too) — so
the turn stays LIVE (`isLiveTurn` is a denylist), citable, searchable, and
STILL OWED: the note debt stays pending, backlog relief keeps asking the main
agent, settlement backfill keeps owing it. The model judgment the user ruled
for arrives through that existing machinery — no new status, no status-audit
campaign, no settlement forcing.

User ruling (S15069/T1477): 「我只是不要自动skip有实际response的turn，即只
自动skip非skill斜杠命令」.

Both floor sites change identically: `completionFloorStatus` (shared by
`settleCompletedTurn` and the worker liveness pass) and `orphan-turns.ts`'s
inline title/content fork. The pre-era `failed` branch is unchanged. No stock
migration: the existing skipped rows stay; settlement backfill already treats
them as owed.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] Floor fork pinned at both sites: response-carrying unnoted → `extracted`;
      empty-response unnoted → `skipped`; noted → `extracted`; pre-era →
      `failed` unchanged
- [ ] A floored-extracted noteless turn: `isLiveTurn` true, listed by
      `getStrandedTurns`, still listed by the owed-note debt predicates
- [ ] Late note on a floored-extracted turn lands as a plain write
      (`promoteTurnFromNote` extracted→extracted, no special casing)
- [ ] A no-reply slash command turn and an empty-response notification turn
      both still floor to `skipped`
- [ ] Territory: src/db/turn-completion.ts, src/db/orphan-turns.ts, their
      tests. NOT src/mcp/format.ts or the settlement prompt (ticket 02's)
- [ ] Load-bearing properties declared for mutation acceptance
