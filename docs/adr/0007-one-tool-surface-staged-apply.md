# ADR-0007 — One tool surface; the subagent's writes apply on commit

**Status:** staged-apply half superseded 2026-08-19 by ADR-0008; one-tool-surface half
amended 2026-08-20 twice — the second amendment ([ADR-0009](0009-standalone-edges-and-rearmed-settlement.md))
revokes the scope limit and closes the open gap below (was accepted · 2026-08-17) · source: S15069 T830

> The **staged-apply half** of this decision (the subagent's writes accumulate
> and apply only on a closing `commit`) is **superseded** by
> [ADR-0008](0008-read-write-contract.md): settlement now gates, writes, and
> stamps each `note`/`remember` call directly, in its own transaction,
> immediately — the same admission rule the main agent's writes go through.
> `commit` is reduced to a claim-validity check, a per-run write count, and a
> terminal-status mark; there is no staged buffer left to apply. The
> **one-tool-surface half** (the settlement subagent uses the same
> note/remember/timeline/recall quartet as the main agent, not a dedicated
> facade set) is untouched and stands.

> **Amendment 2026-08-20 (write-mode-edit-semantics, ticket 07): the surface converged;
> the difference set is `{commit}`.** "Not a dedicated facade set" is now an equation
> rather than a resemblance. Settlement's registered tool set is the main agent's **plus
> exactly `commit`**, nothing else in either direction, and the shapes the two share are
> the same objects — the write-mode map, `type`/`tags`, and all seven relation fields are
> pinned by object identity at the registration seam
> (`tests/worker/note-settlement-parity.test.ts`), where a prose claim of sameness cannot
> reach. The last differential behaviour went with it: the session field's implicit
> whole-overwrite is a declared `write` now, resolved through the same string-field path as
> every other field, and "no append" wording is deleted from the SDK descriptions and the
> settlement prompt. ~~What still differs is scope, not contract — settlement addresses a
> `session` and refuses turn prose (title/content/insight stay the main agent's alone).~~
> **Retired 2026-08-20 by [ADR-0009](0009-standalone-edges-and-rearmed-settlement.md):** the
> prose refusal is revoked. Settlement writes `title`/`content`/`insight` on any turn its
> prompt rendered, through this same mode vocabulary and the same gate; the surviving scope
> limits are the rendered window and the gate itself, not a field class.
> (The mode ENGINE currently lives twice — `mcp/note.ts`'s module-private copy and
> `mcp/field-mode.ts`'s verbatim port, held character-identical by a parity test, with the
> fold-back recipe in that file's header. Implementation state, not a contract difference.)
>
> **Open gap — CLOSED 2026-08-20 by [ADR-0009](0009-standalone-edges-and-rearmed-settlement.md).**
> Settlement's context render now records per-field completeness, so its writes pass rung 5 like
> the main agent's: a whole-field `write` over another writer's text is refused when this
> prompt showed that field only truncated, and the edit form is the way through. The paragraph
> below is kept as the record of what was owed and what paid it. One residue survives, narrowed
> to two fields: settlement's render carries no metadata line, so `type`/`tags` still earn no
> completeness and are gated on rungs 1–4 only — see ADR-0009's open items.
>
> **The gap as it stood, 2026-08-19 to 2026-08-20 (historical, no longer true):** settlement
> does **not** opt into
> [ADR-0008](0008-read-write-contract.md)'s complete-read requirement (rung 5). Its own
> context render records no per-field completeness, so demanding one today would reject
> every correction of a non-empty field — the requirement would fire on evidence that
> surface cannot yet produce. Settlement's writes therefore pass rungs 1–4 only, and a
> settlement `write` can land over a field its render showed truncated. Wiring completeness
> into the settlement render — or ruling that it stays exempt — is an open decision, not
> part of this convergence.

The settlement subagent uses the same injection and the same tool quartet as the
main agent — note, remember, timeline, recall — not a dedicated facade set. The
difference is application semantics: the main agent's writes apply immediately;
the subagent's stage and apply only on `commit` (which replaces the retired
`check` as the closing act). The staged-commit machinery already exists from the
0.11.x settlement rebuild; this decision widens it from a settlement-only facade
into the general subagent write contract. Rejected alternative: parallel
settlement-specific tools, which drift from the main surface and double every
contract change.
