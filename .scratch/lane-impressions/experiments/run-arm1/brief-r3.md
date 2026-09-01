You are the settlement run for a memory system. You are the SOLE writer of "lane impressions".
Your ONLY inputs are the writing law below and the settlement window you are given.
You have no other knowledge of this project and must not use any. Do not read any other file
in the repository, do not search the web, do not ask questions.

Read these two files first:

1. /tmp/imp-gate/teaching.txt  — THE WRITING LAW. It governs absolutely.
2. /tmp/impression-gen/w3.txt                 — the settlement window you are settling now.

CONTAINER COORDINATES (these are the facts the law refers to as "told to you per lane"):

- `E1/#visual-style`: baseRevision 1, TOTAL CAP 280 tokens, not stale, no overridden anchors.
  Its CURRENT stored impression is exactly these lines:
  ```
  SAN11 visual-fidelity lane: style is locked as retro pixel art in 3/4 top-down, formalized in SPEC v4 (S18993/T89, T93) over the earlier oblique/vector lock (T85).
  Causal law: pixel plus oblique aliases, so art choice fixes projection (S18993/T89); composition proceduralizes as placement rules, not drawing (T88).
  ```
- `E1/#map-data-extraction`: baseRevision 1, TOTAL CAP 100 tokens, not stale, no overridden anchors.
  Its CURRENT stored impression is exactly these lines:
  ```
  SAN11 map-data lane: tile data must be pulled from the game package's san11pkres.bin by a Windows-only editor; package and editor are byte-verified on the Win box (S18993/T98, T99), export still pending.
  Causal law: the reader is Windows-only, so this line is transfer-and-handoff, not decoding; the extraction recipe is written (S18993/T95).
  ```

  (The fenced block is a display wrapper only: the stored text is the lines inside it, with the two
  leading indent spaces removed. Do NOT copy the fences or the indent into your answer.)

ANCHOR ADDRESSES: every turn in the window belongs to session 18993. A turn printed as `T199`
in the window has the full address `S18993/T199`. Turn ids appearing inside a turn's own
`content` in square brackets (e.g. `[T11011]`) are RAW ids from a different numbering and are
NOT valid anchors — never write them.

WHAT YOU PRODUCE. For each lane, decide `retain` or `replace`, exactly as the law describes.
Write your answer to files, one file per lane:

- `E1/#visual-style` -> /tmp/imp-gate/r3/visual-style.txt
- `E1/#map-data-extraction` -> /tmp/imp-gate/r3/map-data-extraction.txt

Each file must contain EITHER the single word `RETAIN` on one line, OR the literal word
`REPLACE` on line 1 followed by the WHOLE new impression text starting on line 2. Nothing else
— no commentary, no code fences, no trailing blank line.

Then reply with one short sentence per lane saying what you decided and why. Nothing more.
