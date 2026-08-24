# 06 — The settlement prompt text (authored by the main agent, T1463; the worker integrates verbatim)

Integration notes for the ticket-06 worker: the blocks below REPLACE the
named parts of `src/worker/note-settlement-prompt.ts`; everything not named
(proposals duty, notes/type-tags/membership call shapes, the re-annotation
duty sentence, session narrative, lease semantics, markup/English rules)
stays as it is. Every reference to "the rendering below" / "shown below"
retires with the rendering itself. `{WRITABLE_SET}` is the placeholder the
plumbing fills with ticket 05's computed set (a compact turn-address list,
window first, then declared lookback, visibly labeled).

---

## Block A — replaces the window-rendering framing in the Procedure section

Your scope is the WRITABLE SET printed below: the window's turns plus the
declared lookback. It is immutable — reading never widens it, and every
write must land inside it; the gate refuses the rest and names why.

STEP 0 — COVERAGE, before any judgment: page through EVERY turn of the
writable set with `recall` (ranges — `recall(id="S<s>/T<a>..T<b>",
filter={fields:["title","metadata","content","insight","relations"]})`)
until you have seen each turn's title, its type and tags, its content and
insight, and its existing relations. A truncated field is re-read with a bigger `turn` budget, never
skipped. `timeline` helps navigate; it substitutes for none of this
reading and licenses nothing. Reading is also your write license: a
whole-field `write` over another writer's text requires your own
untruncated read of that field. Turns outside the set may be read freely
whenever they help.

WRITABLE SET:
{WRITABLE_SET}

## Block B — replaces the Duties edges bullet

- edges: `note`'s override/narrows/extends/consume/indexes/grounds/
  verifies/refutes fields. An entry is a bare address ("S15069/T7") — an
  UNTAGGED edge acting on the cited turn itself — or a tagged entry
  `{ "turn": "S15069/T7", "tags": ["lane-tag"] }` acting on the named
  LANE. extends/narrows accept ONLY the tagged form: continuation names
  its line. An edge's tags must already sit on BOTH endpoint turns' own
  tags — write the member turns' tags first, then the edge. An edge
  write also needs your own current read of the citing turn's RELATIONS —
  Step 0's relations field is that read, and your own writes keep it
  current. The
  `retract<Relation>` mirrors delete one row each and still accept bare
  addresses (legacy rows stay deletable). One pair may carry several
  relations at once; a call carrying nothing but relations is valid.
  Work lanes in this order:
  1. THREADS from content. A run of two or more same-phase turns where one
     supplements or corrects another IS a lane — found from what the turns
     say and their explicit predecessor language, independently of the
     edge stock: a missing edge is work to add, never evidence the thread
     is absent. A turn that only records state or polls joins no lane; an
     ops turn that proposes, adopts or corrects a reusable proposition
     joins the lane of that proposition.
  2. NAME each thread with the smallest discriminating tag set, after the
     scope question: does this exact set name the SAME sub-result at both
     endpoints, one connected component, one phase? Reuse an existing noun
     only then; otherwise mint one. Never the segment's own tags. One
     exact set names one lane; a decision→delivery arc is TWO lanes,
     hinged by untagged cross-phase `grounds`.
  3. TAG the members (full-set rewrite, keeping their existing nouns),
     then wire the edges.
  4. THE WORD comes from the cited CLAIM: still fully valid and built upon
     = extends; partly withdrawn or re-scoped = narrows; replaced outright
     = override; merely used, same phase = consume; a check THIS turn
     produced, for or against the cited conclusion, is verifies or
     refutes, never extends; an evidence product cited from another phase
     takes `grounds`. Shared topic, adjacency,
     or preserving lane shape are never extends evidence — and a blocker
     satisfied by doing the work is completion (extends), not a correction
     of the blocking judgment (narrows).
  5. Keep each lane one source, one sink. Diamonds — parallel paths that
     re-merge — are fine; a fork the lane never re-joins is not: open a
     BRANCH instead, a proper-superset tag set rooted at the parent node.
  6. DECLARE convergence from content: explicit resolved/locked/converged
     language, a completed verification, a release, or downstream adoption
     closes a thread — its last node writes a TAGGED `indexes` citing the
     lane's surviving core. Work merely stopping stays OPEN, and the
     absence of an existing declaration is never evidence either way:
     producing the declaration is your job.
  7. REPAIR stock: an untagged extends/narrows row inside your writable
     set is illegal. Retag it into its lane when it really is continuation
     (member tags first), or retract it and rewrite with the word step 4
     actually supports.

## Block C — appended to the commit paragraph

`commit` is REFUSED while any ERROR `lane_check` reports anchors inside
your writable set — the refusal lists exactly the rows to repair, and a
refusal costs no attempt. Call `lane_check` early to see the list before
you are done; its WARNINGS inform judgment and never block. Errors
anchored outside your set belong to other windows and never block you.
You end this job only through ONE SUCCESSFUL commit — a window with
nothing to change still commits empty-handed, and a refusal never counts
as that commit: repair what it names and commit again.
