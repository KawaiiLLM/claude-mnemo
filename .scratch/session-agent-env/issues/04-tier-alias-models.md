# 04 — Tier-alias models (extraction + dream)

**What to build:** mnemo requests `opus` / `sonnet` (tier aliases) instead of literal version IDs (`claude-opus-4-8` / `claude-sonnet-5`), so a new model release needs no mnemo code bump and each session's alias resolves through its own env (`ANTHROPIC_DEFAULT_*_MODEL`). Extraction requests `sonnet`; the dream requests `opus`. Literal version IDs remain valid for users who want to pin.

See `../spec.md` → "Tier-alias models" for the full rationale (including why context-window handling needs no work — it is inherited from the CC subprocess's own auto-compaction).

**Blocked by:** 02 (per-session env) AND 03 (dream env). Aliases land LAST: without per-session env AND the dream env, `opus`/`sonnet` would resolve through the worker's one frozen session — the dream in particular would still resolve `opus` through the frozen worker env.

**Status:** ready-for-agent

- [ ] Extraction requests the `sonnet` alias (replacing the hardcoded `claude-sonnet-5`); the dream requests the `opus` alias (replacing the `claude-opus-4-8` default).
- [ ] The config model allowlist accepts `opus` / `sonnet` / `haiku` as valid values; literal version IDs remain valid (opt-in pinning); the alias is the default.
- [ ] A session's alias resolves through that session's captured `ANTHROPIC_DEFAULT_*_MODEL` (verified end-to-end with per-session env from ticket 02): a claudex session's `opus` resolves to its `gpt-5.6-sol`, an official session's `opus` resolves to real opus.
- [ ] No model-window / compaction changes are made — context-window handling is inherited from the subprocess (documented, not re-implemented).
- [ ] Tests: alias values pass the config allowlist; a literal-ID pin still works; extraction spawns with `--model sonnet` and dream with `--model opus`; an inherited `ANTHROPIC_MODEL` does not override the explicit alias.
- [ ] `bunx tsc --noEmit` passes; `bun test` does not regress vs baseline (the single stale-bundle-guard failure is the expected baseline).

## Constraints

- Do NOT run any git command; only edit files.
- Do NOT bump the version or rebuild `plugin/scripts/*.cjs`.
- Do NOT touch live data under `~/.claude-mnemo`.
