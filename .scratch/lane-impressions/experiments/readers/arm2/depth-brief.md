You are a fresh agent joining three unfamiliar lines of work. The ONLY thing you are given about
each is the STORED TEXT below — this is the complete record kept for each line of work, in full.
There is no other context, no repository to read, no search. Do not read any file. Do not use any
tool. Answer from these texts alone.

--- LANE A ---
SAN11 visual-style lane: diagonal-brick diamond projection is the locked geometry, superseding 3/4 top-down (S18993/T105 overrides T89), isometric, and brick-rect in turn — verified (S18993/T125), ticket 004 acceptance-verified (S18993/T149); road cells now render as whole regenerated road tiles, replacing the rejected mid-tile path stripe, committed a32588c (S18993/T168); client viewport and render blur are also fixed (S18993/T179, T196) — an elevation-derived hillshade is a preview only, client integration and the elevation-combat link stay open (S18993/T199).
Causal law: "top-down" comes from axis-aligned, not diagonal, gridlines, not flat shading; a yawed diagonal grid, not decoration, gives the real stagger (S18993/T124).
Binding: road cells must be whole road tiles, never a procedural mid-tile stripe (S18993/T160); the retile — 62 tiles, 31 combos/1444 cells — is pixel-verified, committed as current (S18993/T164, T168).
Frontier: ticket 004 hand-verified — tests, digest, screenshots (S18993/T149); Autumn Forest's projection fit (S18993/T109) and a flagged cliff-render gap (S18993/T107) remain open.
Elevation: 4793.K3ST is decoded as mapA's elevation, overturning "no elevation data" (S18993/T198); a hillshade preview from it is offline only — client integration and any elevation-combat rule stay open (S18993/T199).

--- LANE B ---
SAN11 map-data-extraction lane: pkres.bin's SHEX format is reverse-engineered, revealing mapB, a second embedded map (S18993/T101); mapA is picked over mirror-defective mapB, converted to mapA.json + tools/ (T102), odd-r hex adjacency locked by a 42/42-city proof (T103); 4793.K3ST decoded as mapA's elevation (T198) — mapB's conversion, engine integration, elevation-combat rule stay open (T199).

--- LANE C ---
The pipeline's 120ms budget splits capture 25ms/transform 60ms/playback 35ms (S22040/T41). Capture committed (T44). Transform's real cost is the resampler, not the FFT (T51); the fix is prototyped, unwired, open (T57). Playback's 35ms is unexamined and unre-ruled (T60).

For EACH lane, answer these two questions. If the text does not let you answer, say exactly
"NOT ANSWERABLE FROM THIS TEXT" — do not guess and do not infer beyond what the text says.

  Q1. CAUSAL MODEL — WHY did this line of work come out the way it did? State the reasoning that
      still governs the decisions, not the sequence of events that happened. If the text tells you
      that some earlier belief was WRONG and what replaced it, say what and why.

  Q2. BINDINGS — What is LOCKED here: what may NOT be reopened or redone differently without a new
      ruling? For each binding, say what the rule forbids.

Then, for each lane, one final question:

  Q3. If you had to take over this line of work tomorrow, what would you NOT know that you would
      need to ask someone about? Name the specific gaps this text leaves you with.

Put your whole answer in your FINAL REPORT. Send no messages to anyone.
