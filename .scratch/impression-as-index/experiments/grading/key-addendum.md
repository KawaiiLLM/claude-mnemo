# Grading key addendum — lane D, and the new IN-FORCE axis

Extends `.scratch/lane-impressions/experiments/grading/key.md`, which is reused unchanged for
lanes A / B / C. That file was written from the source windows before ANY arm ran and neither arm
in this experiment has touched it.

**Honesty note on when each part of this file was written.** Lane D's whole key below was written
from `experiments/corpus/wD.txt` BEFORE either arm was run on lane D — no lane-D impression
existed in any arm at the time. The IN-FORCE criteria for lanes B and C were written after the
control arm's texts already existed (they are the prior experiment's preserved outputs), so they
are deliberately defined ONLY by reference to key items that were themselves written blind
(`L-B1`, `L-C1`, `L-C2`), with no wording taken from any arm's text.

---

## LANE D — `#wire-format` (NEW, uncontaminated, authored for this experiment)

**Provenance, stated plainly: lane D is AUTHORED material, not a captured session.** Lanes B and C
are the prior experiment's real windows. Lane D was written by me for this run because the design
review asked for a lane that contains a specific, deliberate trap — an old rule still in force
while a newer stage merely explored an alternative — and no such lane existed in the corpus. It is
constructed to be ordinary-looking and to contain that trap; it is not evidence about how real
lanes are shaped, only about how each FORM survives that shape.

Its shape, by construction:
- the founding law is OLD (T12, the first turn in the window);
- the three NEWEST stages are ordinary maintenance plus one exploratory draft (T38, T41, T44);
- one genuine OVERRIDE chain exists (T19 kills T12's string-tag companion decision);
- one NON-override sits right next to it (T34/T44 explore zstd; no ruling was made).

Settled membership is cumulative, so the lane's TOTAL CAP is stated to both arms as **200 tokens**
(the same number for both — no arm gets more surface than the other).

**Identity.** The on-the-wire frame format of a fleet service — how a frame is framed, tagged and
compressed.

**Governing law — what is IN FORCE right now.**
- L-D1. gzip is the ONLY body encoding, by RULING, not by measurement; the reason is that every
  fleet consumer already links zlib and a second codec forks the reader (T12). A benchmark may not
  replace it — only a new ruling may.
- L-D2. A frame is atomic: 4-byte big-endian length prefix + body; chunked/streaming bodies were
  rejected outright because partial frames desynchronise a decoder (T12).
- L-D3. Field tags are varint ids through the schema registry. The UTF-8 string-name form is
  REMOVED, not deprecated — the decoder rejects it, with no compatibility window (T19).

**DELIVERED / PROVEN.**
- D-D1. Reference encoder/decoder committed 3d1f7ac; 214 round-trip tests green, fuzzer clean at
  2M cases (T23).
- D-D2. Frame-size histogram exporter committed 9b02e51 (T38).
- D-D3. 0-length frames handled as keepalives, committed c77b3e2, regression test added (T41).
- D-D4. zstd BENCHMARK RESULT: 2.9x faster decode, 31% smaller at equal encode CPU, on 4.2GB of
  production frames (T34). The measurement is real. Nothing follows from it.

**NOT DELIVERED / NOT IN FORCE (over-read traps).**
- N-D1. **zstd is NOT adopted.** T34 is an evaluation with no ruling requested and none made.
  A reader who says the format is zstd, or is moving to zstd, or that gzip is deprecated, has
  over-read. **This is the primary trap of the whole lane.**
- N-D2. `tools/migrate_frames.py` is a DRAFT exercised on a /tmp sample. Not wired in, no ticket
  owns it, no ruling authorises a cutover (T44).
- N-D3. The fleet-wide zlib-only constraint that motivated T12 was NOT re-checked (T34) — so the
  number that would decide a cutover does not exist.
- N-D4. String field tags are DEAD, not optional and not deprecated (T19). A reader who says both
  forms are accepted, or that strings are legacy-but-supported, has over-read in the other
  direction.

**Frontier.**
F-D. zstd is measured and a migration script exists, but gzip's ruling has not been reopened and
nothing authorises a cutover; the zlib-only constraint that would decide it is unmeasured.

---

## AXIS 2b (NEW) — IN-FORCE RULE

Elicited by its own question, scored on its own scale, never folded into Q2 (governing law):

> **Which rule is IN FORCE right now — what must a successor obey today — and what may NOT be
> reopened or done differently without a new ruling? For anything the text mentions that is NOT in
> force, say so.**

Score per lane per reader:

| | 1 | 0.5 | 0 |
|---|---|---|---|
| D | names gzip-by-ruling as the current format AND does not present zstd as adopted/imminent | names gzip as current but hedges toward zstd, or omits the ruling-not-measurement character | says or implies zstd is the format / is being migrated to / gzip is deprecated, **or** NOT ANSWERABLE |
| B | names direct SHEX decoding as the live path (L-B1) or odd-r adjacency as locked (L-B3), and does not present the bin-editor route as live | names one but leaves the bin-editor path ambiguous | presents the Windows bin-editor route as the current path, or NOT ANSWERABLE |
| C | names the ruled 120ms split as binding AND that a leg may only change by a new ruling (L-C1+L-C2), and does not present the 21ms prototype as the current path | names the split without the never-grow/only-by-ruling clause | presents the prototype resampler as adopted, or NOT ANSWERABLE |

A **normalisation error** is recorded separately whenever a reader treats the NEWEST thing the
text mentions as the thing in force. That is the specific failure mode the index form is suspected
of inducing and it is counted, per reader, with the quotation.

---

## AXIS 3 (RESHAPED) — the fixed-size surface

Not identity alone. The newest-N cut plausibly drops founding law and durable bindings as well, so
the surface battery asks three things separately, each scored 1 / 0.5 / 0 with an explicit
NOT ANSWERABLE:

- **S1 IDENTITY** — what is this line of work? (key: Q1 rows of `key.md`, and lane D above)
- **S2 IN-FORCE RULE** — same criteria as axis 2b
- **S3 NON-REOPENABLE** — what may not be redone differently without a new ruling?
  (D → L-D1/L-D2/L-D3; B → L-B3 odd-r locked, or L-B2 mapA-first; C → L-C1/L-C2)

Surfaces compared:
- TREATMENT (index): the newest 3 lines.
- CONTROL (synthesis): line 1 alone — its own designed fixed-size surface (spec: "any surface that
  wants a fixed-size impression takes exactly line 1").
