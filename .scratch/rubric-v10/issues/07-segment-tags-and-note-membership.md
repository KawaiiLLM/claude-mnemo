# 07 — Manual segment tags as the membership gate; note-time membership

**What to build:** a segment's tags become hand-curated identity instead of a derived
frequency mush: the create verb takes them, edits change them deliberately, and the
tag-derivation recomputation retires FOR TAGS ONLY (type stays derived from members).
Membership gains the segment-tag gate, the same invariant pattern as the edge-level
subset invariant one level up: assigning a turn to a segment requires the turn's tags
to carry ALL the segment's tags — a violation rejects with a receipt naming the
missing tags, nothing is co-written. The gate guards every membership write path
(remember assign, settlement reassignment, and the new note-time path) but only for
NEW assignments — existing memberships are grandfathered until the backfill campaign
retro-tags them. The note tool gains a membership parameter: a note call may assign
its turn to one segment the session has ATTACHED (attachment already rendered the
card, so the read grant is natural); remember's assign stays the batch/reassignment/
clearing surface. Segment tags never join lane identity: they gate membership, and a
lane's tag set is as small as discrimination allows — teaching text (tool describes,
rubric Segments line) says so.

**Blocked by:** 02 — Write surface and the three hard gates (both change the note
tool's surface; running in parallel would collide).

**Status:** ready-for-agent

- [ ] Segment create accepts tags; segment tags no longer recompute from members; type still does.
- [ ] Assigning a turn missing any segment tag rejects, receipt names the missing tags and the segment; all three membership paths share the one gate.
- [ ] Existing memberships are untouched by the gate (grandfathered); only new assignments are checked.
- [ ] A note call can assign its own turn to an attached segment; an unattached segment id rejects; the segment-tag gate applies there too.
- [ ] remember/note describes and the rubric's Segments section teach: manual segment tags, membership requires them, lane tags exclude them and stay minimal.
- [ ] Mutation check: disabling the gate on any one of the three membership paths fails a test.
