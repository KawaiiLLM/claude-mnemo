# 05 — 自引用:相位横跨的 turn 可引自己

**What to build:** A multi-phase turn whose phase set spans a cross-phase
word's cell may cite ITSELF with that word — a research+review turn
self-encodes (its review half carries its research half), a measure+design
turn may self evidence-for or self grounded-on. A single-phase turn can never
self-cite; diagonal words (refines/override/depends-on) never self-cite for
anyone. Self edges PARTICIPATE in scoring (user ruling T1180): a self-encodes
increments the turn's own encodesCount. This deliberately and partially
supersedes T1111's blanket self-loop ban and dissolves gap A2 (a patch
release typed correction+fix+ops self-encodes its in-turn rulings).

Mechanics, pinned:
- **Table CHECK rebuild** (the spec's one real migration): bare self rows stay
  banned at table level, relation-carrying self rows become storable —
  `CHECK (citing_kind <> cited_kind OR citing_id <> cited_id OR relation IS
  NOT NULL)`. Use the temp-name rebuild precedent (ensureMemoryEdgesMultiRelation
  in db/schema.ts: FK verification inside the transaction, staleness keyed on
  the stored DDL text). Idempotent, byte-lossless on data.
- **Validator becomes the phase gate**: self allowed iff the relation is
  cross-phase AND the turn's own phase set contains the word's source-row
  phase plus a legal target phase (necessarily distinct). Rejections name the
  reason (single-phase self / diagonal-word self), same missing-half shape as
  other phase rejections.
- **Scoring**: self-encodes counts — pin with a test, no exclusion.
- **Teaching text sweep in src**: any tool-description or validator-comment
  line saying self-loops are banned outright updates to the phase-scoped rule.
- **Render safety**: a turn carrying a self-edge must render without error or
  loop in recall/timeline (the antecedent line may show the turn itself; it
  must not recurse).

**Blocked by:** 01 (landed, 197b34d).

**Status:** ready-for-agent

- [ ] Migration test: rebuild idempotent (second run no-op), data lossless
      (edge dump byte-identical), bare self insert rejected by the CHECK,
      relation self insert accepted.
- [ ] Validator matrix: research+review self-encodes accepted;
      research-only self-anything rejected naming the single phase;
      research+review self-refines rejected (diagonal); design-only
      self-grounded-on rejected.
- [ ] Scoring pin: a self-encodes increments the turn's own encodesCount.
- [ ] Render smoke: recall and timeline render a self-edged turn without
      error.
- [ ] No src text still teaches the blanket self-loop ban.
- [ ] Full suite green except the sanctioned stale-bundle guard.
