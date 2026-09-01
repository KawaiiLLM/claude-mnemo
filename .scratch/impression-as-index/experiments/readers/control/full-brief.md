You are a fresh agent joining three unfamiliar lines of work. The ONLY thing you are given about
each is the STORED TEXT below — this is the complete record kept for each line of work, in full.
There is no other context, no repository to read, no search. Do not read any file. Do not use any
tool. Answer from these texts alone.

--- LANE 1 ---
SAN11 map-data-extraction lane: pkres.bin's SHEX format is reverse-engineered, revealing mapB, a second embedded map (S18993/T101); mapA is picked over mirror-defective mapB, converted to mapA.json + tools/ (T102), odd-r hex adjacency locked by a 42/42-city proof (T103); 4793.K3ST decoded as mapA's elevation (T198) — mapB's conversion, engine integration, elevation-combat rule stay open (T199).

--- LANE 2 ---
The pipeline's 120ms budget splits capture 25ms/transform 60ms/playback 35ms (S22040/T41). Capture committed (T44). Transform's real cost is the resampler, not the FFT (T51); the fix is prototyped, unwired, open (T57). Playback's 35ms is unexamined and unre-ruled (T60).

--- LANE 3 ---
#wire-format: frame is a locked RULING — 4-byte big-endian length prefix, atomic gzip body, no streaming (S24117/T12); field tags are varint ids via the schema registry, UTF-8 name form REMOVED with no compat window (T19), grounded by committed reference encoder/decoder 3d1f7ac (T23); zstd is EVALUATED ONLY — faster, smaller, but no ruling made and the zlib constraint that would decide cutover is unchecked (T34); migration script is a /tmp preview only, nothing wired in, gzip remains the only accepted encoding — cutover is the open boundary (T44).
Causal: varint tags replaced UTF-8 names because name repetition measured 41% of a typical frame; length-prefix and gzip untouched by this correction (S24117/T19).

PART 1. For EACH lane, answer these five questions in one or two sentences each. If the text does
not let you answer a question, say exactly "NOT ANSWERABLE FROM THIS TEXT" for that question — do
not guess, do not infer beyond what the text says. Guessing is worse than declining.

  1. IDENTITY — what is this line of work?
  2. CURRENT LAW — what rule or understanding governs it right now?
  3. STATE — what has actually been delivered / proven, and what has not? Be precise about the
     delivery state of every thing the text names.
  4. FRONTIER — what is still open or unresolved?
  5. IN FORCE — which rule is IN FORCE right now: what must someone taking this over obey today,
     and what may NOT be reopened or done differently without a new ruling? If the text mentions
     something that is NOT in force, say which.

PART 2. Separately, for each lane, answer in free form: "what do you now believe is finished,
shipped, integrated, committed, or working in production because of this text?" List every such
item. Be literal about what the text made you believe — do not hedge to look careful, and do not
add caution the text did not give you. If the text made you believe something is done, say so.

Put your whole answer in your FINAL REPORT. Send no messages to anyone.
