# 02 — Resolution, lane readers, and the heuristic election

**What to build:** spec D2. One pure `resolveEdgeSide` (declared / derived / ambiguous / none / invalid, qualified lanes) over `loadEndpointLaneFacts`; every LANE reader switched from "stored side" to "incident to a member + resolve"; NODE readers made side-blind (phase BFS drops its both-sides filter); the tiered election replaced by the scored heuristic; every raw-word reader dispositioned (R9-4, R10-3, R10-4) while the `relation` column still exists — this ticket must not read it anywhere afterwards.

**Blocked by:** None.

**Status:** ready-for-agent

- [ ] `resolveEdgeSide` + `loadEndpointLaneFacts`; lane readers (lane route, frontier digest, SessionStart roster, coupling, lane impressions' member edges, `emptyLaneTags`) on resolution; node readers (election, in-degree, time order, citedness, phase BFS) side-blind; tests per reader incl. an undeclared unique-endpoint edge appearing in its lane view and carrying the BFS.
- [ ] Election: pool = each route's fitter unit set; `S(n) = w_out·outDeg + Σ w_class(e) + w_rec·(1 − rank_age/|pool|) + w_type·maxType` with the spec's default weights in ONE table; zero-based `rank_age`; edge universe includes live edges to external endpoints; cross-session order `createdAtEpoch` first; ties score desc / event order desc / id desc; K = what the route's fitter admits; the S-route over-budget fallback kept as an explicit exception or changed (R10-4). The tiered election, its word tables, `edge-signals.ts`, the too-fine-index warning and the interim word fill are DELETED; v13 05a's parameter table goes with them.
- [ ] Every raw-word consumer dispositioned per spec D2 and R10-3 (impressions' override/narrows anchor test → correct/full; shape numbers; membership strandings; closure readers; console vocabulary; shared layer); an explicit allowlist for historical migration literals; a test that greps the seven words over `src/` and fails on anything outside the allowlist.
- [ ] Lane lifecycle verbs mutate attribution only (`clearLane` no longer deletes rows or restores bare ones); structural verbs persist old+new qualified lane touches; the expected-delta manifest of the election on the clone reported.

## Constraints

- `~/.claude-mnemo/` is production data and STRICTLY READ-ONLY; measure on a `cp -c` clone of the scratchpad copy.
- NEVER `git stash` / `checkout` / `checkout-index` / `restore` / `reset` / `clean`. Restore from your own `cp` copies, md5-verified.
- Explicit pathspecs on every `git add`. No raw control bytes. `grep -c anthropic-ai plugin/scripts/worker.cjs` stays `0`.
- Every teaching sentence added or removed is pinned by a test a mutation drives red. ≥3 mutation probes of your own, RED, md5-restored — and a probe whose mutation did not apply is not a probe.
- Dispose of every applicable line of `../acceptance-matrix.md` in your report.
- [ ] `npx tsc --noEmit` clean (excludes `tests/`; typecheck new tests separately); full `bun test` once with every delta accounted; `npm run build`; stale-bundle and release-artifacts guards green; `git diff --check` clean. No version bump, no push.

**Pinned (T2432, P2/P4):** write the ONE post-normalisation seam `normalizeIncidentAttribution(db, turnIds, ctx)` in `src/db/` (re-resolve incident sides; clear declarations at cardinality < 2 and invalid ones; update the side index; stamp each changed citer's relations revision; persist old/new qualified lane touches; `ctx.onAmbiguous(edge)` defaulting to DELETE + receipt) and make every lane lifecycle verb and the membership primitive call it in their own transaction. Own the impression anchor invalidation reader (`computeAnchorInvalidations`, `note-settlement-impressions.ts` ~388–431): PRESERVE its two-list partition — `correct/full` → `overridden` (hard `retain` refusal at ~848/~1132), `correct/partial` → `narrowed` (advisory warning at ~622–629); never a single either-coverage predicate. One scan of the class/coverage columns partitioned in memory is fine.
