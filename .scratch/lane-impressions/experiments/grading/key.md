# Grading key — written from the source windows BEFORE any arm was run

Derived only from `corpus/w1..w4.txt` and `run-arm1/delivery/window.txt`. No arm output was
read while writing this file. Lane letters match the arm-1 blind-reader brief so all three arms
are graded on one scale.

Terminal state = the state after the LAST window each lane appears in (w4 for A and B, the
single delivery window for C).

---

## LANE A — `#visual-style` (CONTAMINATED CANARY — the shipped golden sample IS this lane;
## never in the headline result)

**Identity.** SAN11 map/terrain visual fidelity — how the strategic map is projected, tiled and
rendered.

**Governing law.**
- L-A1. 2:1 isometric, drawn as diagonal-brick diamonds (T124, T125).
- L-A2. The "reads top-down" defect is GEOMETRY not style: axis-aligned gridlines (camera yaw)
  cause it, not 2:1 foreshortening (T124).
- L-A3. Visible stagger is mandatory or the asset is void — user ruling (T119).
- L-A4. Tile form locked on the current collage tiles; native tile regen unscheduled (T133).

**DELIVERED / PROVEN (a reader may believe these are done).**
- D-A1. Diagonal-brick geometry verified: 25600/25600 px covered once, shared-edge counts
  both parities (T125).
- D-A2. Ticket 004's rendering spec written; its six acceptance criteria hand-verified,
  111 pytest green, commit set staged (T135, T149).
- D-A3. Road art regenerated as WHOLE connected road tiles and COMMITTED — a32588c, 74 files
  (T160, T164, T168). This is a genuine delivery.
- D-A4. Client window size fixed and COMMITTED — 5c97488, viewport 1920×1080 (T179).
- D-A5. 32×16 blur fixed by nearest+mipmap + integer zoom ladder, landed in IsoMapView.gd
  (T196).
- D-A6. 4793.K3ST decoded as mapA's elevation, 4×4 heights per cell (T198) — DECODED ONLY.

**NOT DELIVERED (a reader believing any of these is done has made an over-read).**
- N-A1. The K3ST hillshade is an OFFLINE / preview render shown to the user. Zero art, zero
  architecture change, nothing in the client (T199).
- N-A2. Elevation's client integration — open, unowned (T199).
- N-A3. Any elevation-vs-combat rule — an explicitly pinned EVIDENCE GAP (T199).
- N-A4. Officer stats and portraits from the 萌战 package: a SOURCING RULING that became a
  ticket-003 requirement (T133). Nothing extracted, nothing built. **This is the primary
  over-read trap** — it is the sibling that inherits a delivery predicate in the shipped sample.
- N-A5. The CC BY 4.0 scrabling pack (T104) is a LICENCE CLEARANCE + asset source, not a
  delivered feature.
- N-A6. Native tile regeneration — explicitly unscheduled (T133).
- N-A7. Ticket 001 and ticket 003 were open as of T135; only the ART track closed.

**Frontier (the open boundary a reader must be able to name).**
F-A. Elevation is decoded but neither integrated into the client nor given combat meaning; the
hillshade is a preview only.

---

## LANE B — `#map-data-extraction` (UNCONTAMINATED — headline lane)

**Identity.** Getting SAN11's map data out of the shipped game package and into an
engine-usable form.

**Governing law.**
- L-B1. The SHEX binary format is decoded DIRECTLY — 200×200 cells × 11 bytes, byte[0]=terrain
  (20 values, render-verified), byte[1]=region ownership (93 values) (T101). This SUPERSEDED
  the Windows-only bin-editor transfer-and-handoff path (T95–T99), which is now a spent
  one-time source.
- L-B2. mapA (the mod fantasy continent) is the working map; mapB is mirror/flip-defective and
  will reuse mapA's converter later (T102).
- L-B3. Adjacency is odd-r offset hex, locked with proof — 42/42 city flowers vs 0/42 for the
  alternative; the flip-by-row-parity can only come from an adjacency rule, not art (T103).

**DELIVERED / PROVEN.**
- D-B1. SHEX format cracked and render-verified (T101).
- D-B2. Two SHEX maps found inside the 963MB san11pkres.bin (T101).
- D-B3. mapA converted to engine JSON (mapA.json) + notes + reusable tools/ scripts (T103).
- D-B4. 42/42 city hex flowers, 35 ports, 10 passes all road-adjacent — verified (T103).
- D-B5. The package and the bin editor were byte-verified onto the Win box (T98, T99) —
  true, but now historically SPENT, not the live path.
- D-B6. 4793.K3ST DECODED as mapA's elevation: header K3ST0006, 8-byte records, two 1025×1024
  vertex blocks, height 0–249 in 62 quantized steps, alignment peak exactly 4.0 lattice px per
  cell, r=0.668 (T198). Decoded-only evidence.

**NOT DELIVERED (over-read traps).**
- N-B1. mapB is NOT converted — it waits on mapA's converter (T102).
- N-B2. The K3ST hillshade is an OFFLINE PREVIEW; nothing wired into the client (T199).
- N-B3. Elevation's client integration — open (T199).
- N-B4. Elevation-vs-combat meaning — explicitly pinned as an evidence gap (T199).
- N-B5. The remaining cell bytes (sparse trap/bandit/flood flags) are only sketched (T101).
- N-B6. The bin-editor EXPORT was never completed — the path was abandoned, not finished
  (T95–T99 → T101). A reader believing "the editor export was delivered" has over-read.

**Frontier.**
F-B. K3ST elevation is decoded and previewable but not integrated and has no gameplay meaning;
mapB is still unconverted.

---

## LANE C — `#latency-budget` (UNCONTAMINATED — headline lane, the DELIVERY case)

**Identity.** The end-to-end latency budget of an audio pipeline, key-down to first audible
sample.

**Governing law.**
- L-C1. 120ms total wall clock, RULED (not measured) split: capture 25 / transform 60 /
  playback 35 (T41).
- L-C2. A leg that wants more must TAKE it from another leg by a new ruling; the total never
  grows (T41).
- L-C3. Rejected alternative: per-leg budgets with no total — "three independently-defended
  legs are how a budget dies" (T41).
- L-C4. The transform leg's cost centre is the polyphase resampler's per-block
  window-coefficient recompute (48ms of 74ms), NOT the FFT (11ms). This overturns a standing
  napkin-estimate assumption (T51).

**DELIVERED / PROVEN.**
- D-C1. The capture leg: lock-free ring buffer replacing the callback-allocating path,
  COMMITTED as 7f21ac9 on main after review (T44). **The one real delivery in this lane.**
- D-C2. Capture measured p50 9ms / p99 18ms over 10k key-downs — inside its 25ms leg (T44).
- D-C3. The transform leg profiled with perf over a 3-minute capture: 74ms total (T51).
  NOTE: 74ms is OVER its ruled 60ms leg — the budget is currently violated.

**NOT DELIVERED (over-read traps).**
- N-C1. The precomputed-coefficient resampler is a PROTOTYPE at /tmp/resamp_proto.c. NOTHING
  IS WIRED IN; the production path is untouched; no ticket owns the integration (T57).
  **Primary over-read trap for this lane.**
- N-C2. The 74ms → 21ms improvement is an OFFLINE comparison render, not a shipped speedup
  (T57).
- N-C3. The coefficient table's memory cost at 8 simultaneous rates is UNMEASURED (T57).
- N-C4. The playback leg's 35ms is DEFERRED and unexamined — an inheritance from T41's ruling,
  explicitly recorded so silence is not read as endorsement (T60). Not accepted, not measured,
  not delivered.

**Frontier.**
F-C. The transform leg is over budget at 74ms; the fix exists only as a /tmp prototype with no
owner, its memory cost unmeasured; playback's leg is deferred until transform is finished.

---

## AXIS 1 — Frontier coverage (per lane, per reader)

Four sub-questions. Each scores **1 (answered correctly, without guessing)**, **0.5 (partial /
vague but not wrong)**, **0 (NOT ANSWERABLE, or wrong)**. `NOT ANSWERABLE` and a wrong answer
both score 0 but are recorded separately — the first is honest, the second is harmful.

| # | Question | A passes if | B passes if | C passes if |
|---|---|---|---|---|
| Q1 | IDENTITY | names SAN11 map/terrain visual fidelity | names SAN11 map-data extraction/decoding | names an end-to-end latency budget for a pipeline |
| Q2 | GOVERNING LAW | any of L-A1..L-A4 | any of L-B1..L-B3 | L-C1 **and** L-C2 (the total-never-grows rule is the law; the split alone is only half) |
| Q3 | CURRENT STATE | separates ≥1 delivered item from ≥1 undelivered item without error | same | same |
| Q4 | FRONTIER | names F-A (or a component of it) | names F-B (or a component) | names F-C (or a component) |

## AXIS 2 — State precision (per lane, per reader)

From the free-form "what do you now believe is finished / shipped / working in production?"
answer, count **over-reads**: every distinct item the reader lists as finished that the key
puts in a NOT-DELIVERED bucket (N-*), or any delivered item the reader inflates past its
proven state (e.g. calling a preview an integration).

Also count **under-reads** separately: a genuinely delivered item (D-*) the reader explicitly
disclaims. Under-reads cost frontier coverage, not state precision — recorded so an arm cannot
win axis 2 by saying nothing is done.

## AXIS 3 — Depth loss (per arm, over the FULL stored text)

Two sub-scores, graded against the key over the WHOLE stored impression, not line 1:

- **Causal model retained** — does the full text carry the *why* that still governs? Check
  list: A→L-A2 (gridlines not foreshortening); B→L-B1 (decoding beat the Windows-only reader) +
  L-B2 (mapB mirror-defective); C→L-C4 (resampler not FFT) + L-C3 (why a total, not per-leg).
- **Bindings retained** — what is locked and may not be reopened without a ruling. Check list:
  A→L-A3, L-A4, "whole road tiles never procedural stripes"; B→L-B3 (odd-r locked with proof),
  L-B2 (mapA first); C→L-C1/L-C2 (the ruled split and the never-grow rule), N-C4 (playback
  deferred, not accepted).

Each check item scores present / absent. Report the ABSENT list explicitly, with the text that
would have carried it. This is arm 3's bill.
