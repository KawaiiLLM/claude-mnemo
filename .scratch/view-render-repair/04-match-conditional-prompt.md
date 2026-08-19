# 04 — A prompt-text hit renders that row's prompt line

**What to build:** in the search shape, a turn whose match landed in its
PROMPT text renders a `- prompt:` field line for that row — bolded match,
neighborhood excerpt, same as content — while rows whose prompts carry no
match render none. Prompt stays OUT of the default field set; it surfaces
per row as the evidence that ranked the row ([S15069/T1045] ruling; closes
ticket 01's flagged gap "a prompt-only FTS hit surfaces the row without the
matched words").

**Blocked by:** 03 (same function territory — `renderGroupedSearchResults`
and the search branch).

**Status:** ready-after-03

## Pinned decisions

- Matched-field detection reuses the SAME term set the bolding already
  computes — a per-row word-boundary containment probe over the field text;
  no FTS column-attribution machinery.
- The mechanism is written general (a set of match-conditional fields);
  ruled ON for `prompt` only. An explicit `filter.fields` including `prompt`
  keeps unconditional rendering (caller override beats the conditional).
- The conditional line obeys the same `turn` item budget and neighborhood
  excerpt rules as every field line.

## Acceptance criteria

- [ ] Query matching only a turn's prompt: that row shows `- prompt:` with
      the bolded neighborhood; sibling rows without prompt matches show none.
- [ ] Query matching content only: no prompt lines appear anywhere.
- [ ] `filter: {fields: ["prompt", ...]}` still renders prompt on every row.
- [ ] Golden-sample fixtures and browse tests stay green unedited.
- [ ] typecheck clean; full suite green except the standing stale-bundle guard.

## Ground rules

Same as tickets 01–03: no git write commands (report the file list); never
touch ~/.claude-mnemo, plugin/scripts, versions, src/worker; transient reds
outside your files → re-run narrowly, never revert.
