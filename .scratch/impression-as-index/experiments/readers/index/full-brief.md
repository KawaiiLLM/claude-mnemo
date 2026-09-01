You are a fresh agent joining three unfamiliar lines of work. The ONLY thing you are given about
each is the STORED TEXT below — this is the complete record kept for each line of work, in full.
There is no other context, no repository to read, no search. Do not read any file. Do not use any
tool. Answer from these texts alone.

--- LANE 1 ---
S18993/T198..T199: 4793.K3ST cracked as mapA's height field, alignment cross-correlated to the map grid (r=0.668), confirmed by an offline hillshade
S18993/T93..T103: bin-editor link decoded and export recipe written, decoded-only with nothing extracted; SHEX map format then cracked, mapA picked over mirrored mapB, odd-r hex adjacency locked 42/42 vs 0

--- LANE 2 ---
#latency-budget
S22040/T60: playback's 35ms deferred, unruled, from T41
S22040/T51..T57: transform cost is the resampler not the FFT; prototype cuts 74ms to 21ms, /tmp only, unwired
S22040/T41..T44: 120ms ruled 25/60/35ms, legs borrow only by new ruling, never the total; capture leg shipped

--- LANE 3 ---
S24117/T44: drafted a zstd migration script, tested on a sample in tmp; nothing wired in, gzip remains the only accepted encoding
S24117/T41: decoder crash on empty frames fixed and committed, now treated as keepalive; no format change
S24117/T38: frame size histogram exporter added and committed; no format change
S24117/T34: zstd benchmarked against gzip as an evaluation only, faster and smaller — no ruling made; T12's ruling still governs, the zlib constraint was never rechecked
S24117/T23: reference gzip and varint tag encoder and decoder landed after review, tests and fuzzer clean; every deployed reader built from this
S24117/T12..T19: frame ruled length prefixed gzip, atomic, no streaming; T19 overrode only the field name — tags now varint ids, string form removed, no compat window; length prefix and gzip stand

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
