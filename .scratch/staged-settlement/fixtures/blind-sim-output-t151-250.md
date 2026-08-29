# Blind stage-1 simulation output — T151-250, Sonnet, 2026-08-29

Protocol: input = fixtures/blind-sim-input-t151-250.md (84 turns' title/content/type only;
no raw text, no legacy tags, no lane roster). Criteria taught (vertical line, backward
walk, no phase groupings, kebab topic names); my answer table, existing lane names and the
user's diagnosis withheld. Model claude-sonnet-5 to match production settlement tier.
Confound (acknowledged): teaching wording, context position, and decoy absence all differ
from production at once.

## Work lines (agent output, verbatim)

**combat-formula-calibration** — closing out the muster/troop-restoration and damage-formula tickets (006, 007) that COMBAT-M4 depends on — T152-154 — starts mid-flight verifying ticket 006, fixes codex findings (573e9c6), lands verifying ticket 007's damage-formula calibration.

**ui-interaction-restoration** — recovering SAN11's original click-object interaction paradigm (vs. the M2 menu-first flow) and shipping it as tickets 008/009/010 — T158-159, 161-163, 166-167, 170, 172-175, 177-178, 180-191 — starts at the live demo revealing an unrenderable muster family and a wrong interaction model, drives a five-round video/manual 考据 campaign plus garrison/disband mechanics rulings, converges into SPEC-UI v1 (T181), cuts and lands tickets 008→010→009 (each delegate→verify→codex→commit), lands at the batch-closed commit 7c1b98f (T191).

**road-tile-art** — replacing the procedural mid-tile path stripe with whole road tiles per the user's aesthetic ruling — T160, 164, 168 — starts with the worker launch (paired with the interaction-research worker at the same turn), verified pixel-exact, lands committed a32588c with the id()-cache bug called out.

**map-render-resolution** — fixing the demo's blurry rendering (native 32×16 art + Linear filtering + non-integer zoom) — T196, 210 — starts and resolves inside one turn (NEAREST+mipmaps, zoom ladder), lands committed as 8034945 in the split commit.

**elevation-data-attribution** — decoding and hardening the K3ST height channel as mapA/mapC's elevation source — T198, 231-235, 238-240 — starts with the cross-correlation decode pinning K3ST as elevation, resumes as ticket 013 (positive control switched to mapA since mapC's terrain was unattributed), corrected twice via peer + editor evidence (odd-r stagger, header length), lands with ticket 013 closed at a0487c1.

**3d-terrain-render-direction** — deciding whether/how to move the client to 3D terrain rendering — T197, 199, 201-205 — starts assessing a 3D relief demo, builds hillshade and lift previews, resolves the mechanics-vs-art-fidelity question, lands on Godot 3D over three.js based on asset survival (T205), a design decision (no ticket cut yet in view).

**mapc-pipeline-setup** — discovering 血色衣冠's China map (mapC), speccing it, and generalizing the parser to serve it without touching mapA's output — T206-209, 211-212 — starts with the mapC discovery and SPEC-MAPC, cuts tickets 011-013, delegates and lands ticket 011 (parameterized pipeline, codex findings settled, byte-identity gate held).

**mapc-terrain-attribution** — assigning semantic roles to mapC's terrain byte values — T213-216, 245, 248-250 — starts with ticket 012 (clean negative: every mapA criterion fails on mapC by an order of magnitude), corrects mapA-notes off that work, reopens as ticket 016 once value-reuse is found, lands on a first solid positive result (sea/wasteland swap) with the ground-texture search still open (WFTX ruled out as sky).

**s11bin-editor-verification** — standing up the S11Bin map editor as an independent ground-truth oracle — T217-218, 223-225 — starts transferring/unpacking the editor and confirming its exports against hand-carved data, pins the file↔editor coordinate convention, decodes the OBJS building table, lands naming byte4/byte9 and finding sites hidden in the region layer.

**mapc-sites-recovery** — recovering mapC's cities/ports/passes from the region layer and OBJS models — T226-228, 230 — starts planning ticket 014 off the editor-verification findings, delegates and delivers (region ids ≠ site numbering), lands peer-reviewed and committed 967f5b7.

**mapc-water-attribution** — determining which mapC terrain values are water — T241-244, 246-247 — starts as ticket 015 (height+port evidence, clean negative), overturned by in-game flyover video (value 9 is water), hardened for reproducibility (resolution bug fixed), lands peer-adjudicated with four overreaches struck and figures pinned to a frame snapshot.

## Unassigned

- T156 — compact (session-boundary artifact, no content)
- T179 — one-off (viewport-size fix, unrelated to any active thread)
- T194 — compact
- T229 — compact
- T236 — meta (reporting-style feedback from user, not project work)

## Ambiguous calls

- **T159** (diagnose+san11-demo-feedback) splits evenly between `ui-interaction-restoration` and `road-tile-art` — it traces both the road-art complaint and the interaction complaint to their owning decisions. Assigned to `ui-interaction-restoration` since that's the larger, more novel arc it directly launches; the road-art half is picked up cleanly by T160/164/168 instead.
- **T160** (delegate+demo-feedback-fixes) launches both the road-tile worker and the interaction-考据 worker in one turn. Assigned to `road-tile-art` since its concrete, self-contained deliverable (pixel-verified retile) closes there; `ui-interaction-restoration`'s own research start is well covered by T166-167 regardless.
- **T210** (ops+commit-hygiene) commits two unrelated bodies of work in one turn — the render-resolution fix (8034945) and SPEC-MAPC+tickets (9af659d). Assigned to `map-render-resolution` as that fix's landing commit; `mapc-pipeline-setup`'s real landing is T212 (ticket 011 adjudicated) so it loses little.
- **T174/175** (video-worker dual mandate) carry a secondary mandate gathering leads for COMBAT-M4's unfinished 高低差 item. Kept in `ui-interaction-restoration` (primary mandate, headline deliverable) rather than spun into a separate combat-height line, since that item never resolves into its own ticket within these 84 turns.

## Post-hoc notes (reviewer)

- Zero phase/activity lanes; the ui line matches the full-context answer nearly
  turn-for-turn; the production 174-member blob did not reproduce.
- Granularity ran finer than the full-context answer (5 mapC micro-lines, two
  2-3-turn lines) — partly attributable to the missing roster; ruled acceptable
  direction under finer-over-coarser [S15069/T1989].
- One name (`s11bin-editor-verification`) carries an activity word — supports
  banning the word family via the orthogonality law rather than an enumerated
  blacklist [S15069/T1996].
