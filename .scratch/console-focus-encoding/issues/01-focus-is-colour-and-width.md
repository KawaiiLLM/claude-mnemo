# 01 — Focus is what colour and width mean in the graph

**What to build:** looking at the console graph, the focused subgraph reads
instantly — its edges are coloured and thick, everything else is grey and thin. No
edge is thin for a reason unrelated to focus.

**Blocked by:** `.scratch/lane-state-retirement/issues/01-lane-state-is-deleted.md` —
same file (`src/worker/console-shell.html`), and that ticket is mid-flight. Do not
start while it is unlanded.

**Status:** ready-for-agent

## Why

Today the graph spends its three strongest visual channels on three different axes,
and only the weakest one carries focus:

```css
path.edge          { stroke-width:2.2; opacity:.78; }
path.edge.converge { stroke-width:1.1; }        /* `indexes` alone is thin */
path.edge.gray:not(.hot) { opacity:.28; }
path.edge.hot      { opacity:.95; }
```

with the file's own comment: *"hot = focus emphasis: opacity only — stroke WIDTH is
semantic"*. So width says "this is the convergence fan", colour says which of the
seven words, dash says whether the edge stayed inside one lane, and focus — the thing
a reader is actually steering by — gets opacity and nothing else.

Ruled: focus takes colour AND width. `indexes` does not need a thin line; its own
hue (`--indexes`) already distinguishes it.

## Decisions (settled — implement as given)

1. **Outside the focused subgraph: grey and thin. Inside: coloured and thick.** The
   two channels agree rather than dividing the work; a reader steering by either one
   gets the same answer.
2. **`path.edge.converge` retires.** `indexes` renders at the same width as every
   other relation.
3. **Dash keeps its current meaning** — whether the edge stayed inside one lane.
   Untouched by this ticket.
4. **Grey's reservation is deliberately reassigned.** The file records
   *"[S15069/T1760] GREY IS RESERVED. It says one thing — this edge has no lane
   attribution yet — so nothing else may claim it"*, and `consume` was moved off grey
   to protect that. The reservation is released because **the tenant never moved in**:
   an unattributed edge does not render in the graph at all, which is the observation
   that prompted this ticket. Update that comment rather than leaving it contradicting
   the code — and record the consequence, that grey is now spoken for if draft edges
   ever start rendering.

## Acceptance criteria

- [ ] With a focus active, edges inside the focused subgraph are coloured and thick;
      every other edge is grey and thin. Assert both halves — a test that only checks
      the focused side passes on a graph that greys nothing.
- [ ] With NO focus active, the graph is not uniformly grey. State what the unfocused
      default is and pin it.
- [ ] No edge is thin for any reason other than being unfocused — `converge` is gone
      from both the stylesheet and the class-assignment site.
- [ ] An `indexes` edge inside the focus is visually indistinguishable in width from
      an `extends` edge inside the focus.
- [ ] Dash behaviour is unchanged, asserted.
- [ ] The `GREY IS RESERVED` comment is rewritten to state the current rule and why
      the reservation was released. A comment left contradicting the code is a defect
      in this codebase, not a cosmetic issue.
- [ ] The legend matches the new encoding — it currently states the rule the code is
      about to stop following.
- [ ] `src/worker/console-shell.ts` regenerated with
      `bun scripts/generate-console-shell.ts` (a stale-shell guard pins them
      byte-identical) and the inline scripts still compile — the shell shipped a
      whole-console outage from one unprefixed comment line, and the compile guard
      exists because of it.
- [ ] `npx tsc --noEmit` clean, `bun test` green; report the number.

## Out of scope

Rendering draft edges in the graph, and any change to which edges the graph API
returns. This ticket restyles what is already drawn.

## Notes

Do not start while the lane-state-retirement worker holds this file. Check
`git status --porcelain` first.
