# Unify Turn Identifiers Design

## Goal

Make turn references use a single public identifier system across `recall` and `replay`: `(session_id, promptNumber)`.

Today, `recall` uses the database turn primary key while `replay` uses transcript `promptNumber`. This leaks two different identities for the same logical QA turn. The new design makes `promptNumber` the only user-facing turn identifier and keeps the database row id internal.

## Scope

This design changes only public turn lookup semantics and output formatting for MCP read tools.

In scope:
- `recall` turn lookup
- turn labels in `recall` output
- cross-session turn formatting
- request validation for `recall`
- tests, docs, and skill text that describe turn references

Out of scope:
- observation identifiers
- replay transcript parsing rules
- database schema changes
- hook lifecycle
- Mnemosyne extraction logic

## Current Problem

The project currently exposes two different turn identifiers:

- `recall(turn=37)` uses DB turn id
- `replay(session=142, turn=3)` uses session-local `promptNumber`

This causes three problems:

1. Users cannot reliably move from structured memory to transcript replay without translating identifiers.
2. Skill docs need awkward caveats about `[T3]` versus `#2`.
3. DB implementation details leak into the user-facing API.

## Chosen Direction

Use `promptNumber` as the only public turn identifier.

Turn references must always be session-scoped:

- `recall(session=142, turn=3)`
- `replay(session=142, turn=3)`

The database `turn.id` remains an internal primary key used only for joins, persistence, and indexing.

## API Semantics

### recall

Supported forms:

- `recall()`
- `recall(query="...")`
- `recall(session=142)`
- `recall(session=142, turn=3)`
- `recall(observation=7)`
- existing session search/filter forms

Rejected form:

- `recall(turn=3)` without `session`

If `turn` is provided without `session`, return a clear parameter error:

`turn requires session; use recall(session=142, turn=3)`

Lookup rule:

- `recall(session=142, turn=3)` resolves the turn by `(session_id=142, prompt_number=3)`

### replay

No semantic change.

`replay(session=142, turn=3)` already uses `promptNumber` and becomes the reference behavior for turn lookup.

### observation

No change.

Observations continue to use DB ids because the transcript has no stable observation objects or natural per-session numbering.

## Output Formatting

### Session drill-down

When listing turns inside a session, display only session-scoped turn identifiers:

```text
[S142] auth middleware refactor
  [T1] Diagnose 401 errors | 3 obs
  [T2] Fix token refresh race | 4 obs
```

Do not expose DB turn ids in normal user-facing output.

### Turn detail

Turn detail remains session-scoped:

```text
[T2] Fix token refresh race | 4 obs
  prompt: "Fix the race condition in auth..."
```

### Cross-session search results

When a turn result appears outside a session-scoped view, include both session and turn context:

```text
[S142][T2] Fix token refresh race | 4 obs
```

This keeps turn references unambiguous without reintroducing DB ids.

### Observation output

Observation ids remain globally addressable:

```text
[O7] bugfix: mutex added
```

## Validation Rules

`recall` must enforce these rules:

- `observation` is exclusive with all other selectors
- `turn` requires `session`
- `expand_turns` requires `session`
- `session` without `turn` remains valid

If both `observation` and `session`/`turn` are supplied, return the existing parameter error style rather than guessing precedence.

## Database Access Pattern

No schema change is needed.

Add a session-scoped lookup helper:

- `getTurnByPromptNumber(db, sessionId, promptNumber)`

This replaces public use of `getTurnById()` inside `recall` turn lookup paths. `getTurnById()` remains valid for internal joins and observation ownership.

## Compatibility Strategy

This is a deliberate API cleanup, not a dual-mode compatibility layer.

Chosen behavior:

- Stop supporting public `recall(turn=<db_id>)`
- Require `session` whenever `turn` is used
- Update all docs, tests, and skill guidance to the new contract

Reasoning:

- Dual support would keep the ambiguity alive.
- The project is still early enough that a clean break is cheaper than long-term mixed semantics.

## Implementation Outline

1. Add session-scoped turn lookup in the DB layer.
2. Change `recall` validation to require `session` with `turn`.
3. Change `recall` turn-detail lookup to use `(session_id, prompt_number)`.
4. Remove DB turn ids from user-facing turn formatting.
5. Update search-result formatting for turns to use `[Sx][Ty]`.
6. Update tests, docs, and `plugin/skills/mnemo/SKILL.md`.

## Testing Strategy

Required behavioral tests:

1. `recall(session=1, turn=2)` returns the correct turn observations.
2. `recall(turn=2)` returns a parameter error.
3. `recall(session=1)` renders `[T1]`, `[T2]` without DB turn ids.
4. Turn hits in `recall(query="...")` render with `[Sx][Ty]`.
5. `recall(session=1, turn=2)` and `replay(session=1, turn=2)` refer to the same logical turn.
6. Undo scenarios still preserve shared `promptNumber` semantics across both tools.

Regression checks:

- observation lookup by `[O7]` still works
- replay output is unchanged except where docs now align with it

## Risks

### Breaking existing manual usage

Anyone currently calling `recall(turn=<db_id>)` will need to switch to `recall(session=<id>, turn=<promptNumber>)`.

Mitigation:

- return a direct error message with the exact replacement form
- update skill docs and examples in the same change

### Ambiguous cross-session turn references

Using `[T2]` outside a session-scoped block can be ambiguous.

Mitigation:

- cross-session views must render `[Sx][Ty]`
- session drill-down views may use `[Ty]` alone

## Non-Goals

- Do not invent session-scoped observation numbering.
- Do not persist transcript offsets or external replay ids.
- Do not add a compatibility alias such as `turn_id`.
