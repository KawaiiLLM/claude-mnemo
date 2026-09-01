You are a fresh agent joining three unfamiliar lines of work. The ONLY thing you are given about
each is the STORED TEXT below — this is the complete record kept for each line of work, in full.
There is no other context, no repository to read, no search. Do not read any file. Do not use any
tool. Answer from these texts alone.

--- LANE A ---
The SAN11 visual-style lane: 2:1 isometric, diagonal-brick diamond stagger (S18993/T124). Road cells are now whole tiles, not the 004-era mid-tile stripe SPEC v7 left unscheduled — user ruled it ugly; retile landed a32588c, pixel-verified (T159, T160, T164, T168). Viewport and render-blur bugs fixed at the client (T179, T196). mapA elevation (K3ST) is decoded, an offline hillshade preview rendered — unblocking 3D-relief, previously ruled out for lack of data — but client integration and combat meaning stay open (T198, T199).

--- LANE B ---
The SAN11 map-data-extraction lane: san11pkres.bin decoded as SHEX — 200x200 cells, terrain+region per cell, two embedded maps (S18993/T101). mapA is the build target over mirror-defective mapB (T102). Hex adjacency is odd-r, proven via city-flower parity (T103). mapA.json plus tooling delivered, verified 42/42 cities; mapB conversion remains open (T103). Elevation is now decoded too: 4793.K3ST, 1025x1024 vertex blocks in 62 quantized height steps, aligned at exactly 4.0 lattice px per cell (T198).

--- LANE C ---
120ms end-to-end (capture 25/transform 60/playback 35) is a ruling not a measurement — legs reallocate only via new ruling (S22040/T41). Capture landed (T44). Transform's cost was misdiagnosed as the FFT; profiling found the resampler's per-block coefficient recompute costs 48 of 74ms, overriding T41 (T51). A precomputed-coefficient prototype cuts transform to 21ms, bit-identical, but is UNWIRED — /tmp only, memory cost unmeasured (T57). Playback's 35ms is unexamined, deferred not accepted (T60).

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
