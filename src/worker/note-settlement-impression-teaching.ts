/**
 * THE IMPRESSION WRITING LAW, AS THE SETTLEMENT RUN IS TAUGHT IT
 * (lane-impressions spec Rev 8, ticket 02).
 *
 * TICKET 09 LIFTED TICKET 02'S FREEZE, AT THREE PLACES AND ONLY THREE. Ticket 02
 * shipped this text verbatim from the spec and forbade itself to reword it;
 * ticket 06 then ran the spec's own acceptance gate against it and the gate
 * FAILED, so the repair became the spec's to make and ticket 09's to land (user
 * ruling S15069/T2359: fix the batch, then ship). What changed, each with the
 * measurement that forced it:
 *
 *   1. LINE 1 GAINS ITS FOURTH DUTY — the open boundary. The shipped clause
 *      named three duties ("what it is, its governing law, its current state")
 *      where the gate demands four, and writers followed the prose: a blind
 *      reader given only line 1 answered the frontier question for 0 of 3 lanes,
 *      six honest abstentions (ticket 06). It was never a budget problem — those
 *      lines measured 46-98 tokens against a 150 cap.
 *   2. STATE-SCOPE ISOLATION. A list member carrying no state predicate of its
 *      own inherits the matrix clause's, and a reader absorbs it as delivered
 *      (ticket 06; reproduced by ticket 08 on 1 reader in 3, contaminated lane
 *      only — real and probabilistic, not deterministic).
 *   3. SUPERSESSION. The largest single measured effect in the whole effort: an
 *      impression that keeps a dead path readable beside the work that killed
 *      it, joined only by sequence, leads readers to take the dead path as live
 *      frontier — 5 of 5 readers, against 0 of 5 for a text that omitted the
 *      history (impression-as-index ticket 01, axis 2b).
 *
 * BOTH GOLDEN SAMPLES ARE REWRITTEN TO OBEY ALL THREE, and that is not
 * secondary polish. Writers copy the sample's CONSTRUCTION near-verbatim,
 * defects included — measured twice: two independent writers in two independent
 * draws reproduced the same four sample lines verbatim, and the arm given the
 * unrepaired sample reproduced its defect while the arm given the repaired one
 * reproduced the repair (ticket 08's canary; impression-as-index's imitation
 * table). A repair that fixes the prose and leaves the sample ships the defect.
 *
 * Everything else — the four-question checklist, the state ceiling, the line
 * form, the caps, lane relevance, anchor discipline, the revision law and the
 * submission protocol — is still the spec's text, unreworded.
 *
 * FIRST-SETTLEMENT-FEEDBACK TICKET 01 ADDS ONE PARAGRAPH, and only one: THE
 * FOLD RESETS AT EVERY NEWLINE, under ANCHOR DISCIPLINE. Job 171 (2026-09-02,
 * the second production settlement run under 0.29.0) had its first `commit`
 * refused on ELEVEN `anchor-format` violations plus one `delivery-anchor` —
 * the writer used a bare `T<m>` for every anchor in every line of a four-line
 * impression and never wrote the full form once.
 *
 * THE TICKET'S OWN PREMISE FOR THIS REPAIR IS FALSE, and is recorded as false
 * rather than quietly acted on: it says the anchor grammar "is a rule the
 * validator enforces that the teaching states only in the sample, never in the
 * prose". It does not. QUALIFIED FOLD below states the per-line rule verbatim,
 * and the delivery-word rule sits in THE STATE CEILING — both were present, to
 * the byte, in the prompt job 171 was shown (verified against that run's own
 * transcript, not against HEAD). So this is not a missing rule being supplied;
 * it is the SAME rule restated at the failure the run actually made — writing
 * the bare form as if it were the citation form, on every line — plus the
 * consequence the old text left the reader to derive (one rejection per
 * anchor, and the fold not carrying across a newline). Nothing else is
 * reworded, and no rule is added that the validator does not enforce.
 *
 * ONE TEXT, BOTH RUN SHAPES. The unified run (topic pass → `finalize` → edge
 * pass) and the resume dispatch (a reclaim that starts already on `edges`) both
 * render this same block, because both reach the same terminal `commit` carrying
 * the same obligation. A law taught in one prompt and not the other would be a
 * law the crash-recovery path does not have.
 *
 * WHY THE LAW IS IN THE PROMPT AND THE COORDINATES ARE NOT. The prompt is the
 * one channel this run is told to trust, so every INSTRUCTION lives here; the
 * per-container coordinates (current text, base revision, cap) are FACTS that do
 * not exist when this prompt is built, and they arrive as data — on `finalize`'s
 * own result in the unified run, and rendered into the resume prompt from the
 * frozen worklist the crashed attempt left behind.
 */

/**
 * The two golden samples, REWRITTEN BY TICKET 09 to obey all three repaired
 * rules. The spec's originals are in its "Further Notes" block and are the
 * texts the measurements below indicted; they are not what ships.
 *
 * What each rewrite had to fix, item by item, so a future reader can see the
 * defect it is no longer teaching:
 *
 *   FULL. Its old line 1 opened "the look is locked and shipped through ticket
 *   004 —" and then hung three artefacts off that dash, one of which (the 萌战
 *   package) is a ruled SOURCE with nothing extracted. That is the state-scope
 *   defect in its pure form, and it is the sentence a reader absorbed as
 *   delivered. The old line 1 also carried its open boundary only as a trailing
 *   "but ... remain open" on one item, which two blind readers did not read as
 *   the lane's frontier. And the whole old sample named not one superseded
 *   path, in a lane that had reversed its projection four times — so it taught,
 *   by omission, the deletion strategy that the liveness measurement showed is
 *   the mirror failure, not the fix. Now: line 1 carries all four duties and
 *   ends on the open boundary; every item carries its own state predicate in
 *   its own clause; and a dedicated line names the three dead paths with the
 *   ruling that killed each.
 *
 *   THIN. Deliberately still ONE line (the spec's peer round-2 finding 7:
 *   "Stable — no revision has been needed" was a maintenance-ledger line, the
 *   metadata-row regression the line form must never teach; a thin lane needs
 *   no second line). But a one-line impression IS line 1, so it owed the fourth
 *   duty and did not pay it — the old text named a locked scope and a primary
 *   target and stopped. It now separates the ruled plan from the unbuilt work
 *   and names what is open.
 *
 * Both are measured at HEAD's runtime tokenizer: FULL is 367 tokens over 5
 * lines with a 147-token line 1; THIN is 71 tokens. Exported so a test can pin
 * both through the deterministic validator itself — a teaching sample the
 * shipped validator would reject is a teaching that sets the writer up to fail.
 */
export const IMPRESSION_GOLDEN_SAMPLE_FULL = [
  "The SAN11 visual-fidelity lane: the locked geometry is 2:1 isometric drawn as diagonal-brick diamond tiles, superseding the 3/4 top-down pick (S18993/T105 overrides T89) and the brick-rect before it (T124), ticket 004 acceptance-verified (T149); the connected whole-road tiles are committed (T160, T168), superseding the mid-tile stripe T133 confirmed; officer stats and portraits are a ruled SOURCE only — the 萌战 package, extraction not built (T133); the elevation is decoded, its hillshade an offline preview (T198, T199) — client integration and any elevation-combat rule are the open boundary.",
  "Causal law: top-down misreading is geometry, not style — oblique feel needs diagonal gridlines; diagonal-brick diamonds give SAN11's stagger with unmodified 2:1 isometric assets (S18993/T124, T125).",
  "Binding: connected full-road tiles, never procedural stripes, locked by user ruling (S18993/T160); visible stagger is mandatory or the asset is void (T119); the 萌战 package is the ruled source for officer art, nothing extracted (T133).",
  "Dead, superseded by ruling, never revive: the 3/4 top-down pick (S18993/T89, killed by T105); the axis-aligned brick-rect (T123, by T124); the procedural mid-tile stripe (T133, by T160).",
  'Frontier: K3ST IS mapA\'s elevation (S18993/T198), overturning T197\'s "relief needs invented data" verdict; the hillshade is an offline preview only — client integration and any elevation-combat rule remain open (T199).',
].join("\n");

export const IMPRESSION_GOLDEN_SAMPLE_THIN =
  "One project covers every target JD: a vertical slice deep enough that each JD reads its own competency in it, with scope exclusions locked up front (S18993/T17); JD5 is the ruled primary target (S18993/T15) — the plan is ruled, not built, and which competencies the slice must actually demonstrate is the open boundary.";

/**
 * The whole teaching, as prompt lines. Rendered as a `## Lane impressions`
 * section by both prompts.
 */
export function renderImpressionTeaching(): string {
  return [
    "## Lane impressions — the mental model you maintain",
    "",
    "You are the SOLE writer of impressions. One impression per LANE, and one",
    "thin TASK-TIER impression per task. An impression is what a reader keeps",
    "after the chronology is forgotten: why the line exists, what understanding",
    "governs it, what binds, what is proven and what hangs. The main agent",
    "writes none of it and never will.",
    "",
    "THE FOUR QUESTIONS. Every impression answers these four, in this order,",
    "because that is the order of what a newcomer loses first:",
    "",
    "  1. GLOBAL IMPRESSION — what this lane is, its governing law, its current",
    "     state, AND its open boundary. All four, in one line. This is LINE 1",
    "     and it stands ALONE (see the line form below).",
    "  2. CAUSAL MODEL — why the line came out the way it did; the reasoning",
    "     that still governs, not the events that happened.",
    "  3. BINDINGS — what is locked and may not be reopened without a ruling.",
    "  4. FRONTIER — what is proven and what hangs; the open boundary.",
    "",
    "THE LINE FORM. Newline-delimited lines, at most 8. LINE 1 IS THE GLOBAL",
    "IMPRESSION: one self-contained line, at most 150 tokens (and at most the",
    "lane's total cap where that binds tighter), carrying the lane's whole shape",
    "— what it is, its governing law, its current state, AND ITS OPEN BOUNDARY —",
    "written to stand ALONE, because any surface that wants a fixed-size",
    "impression takes exactly line 1.",
    "",
    "THE OPEN BOUNDARY IS LINE 1'S FOURTH DUTY, NOT AN OPTIONAL FIFTH CLAUSE. A",
    "line 1 that names only what is done is a FALSE line 1, whatever its",
    "individual clauses say: a reader shown nothing but that line must be able to",
    "state what is still open, and when it cannot it does not abstain — it takes",
    "the newest finished thing for the frontier. Frontier stays question 4 of the",
    "full impression as well; line 1 carries the boundary, the frontier line",
    "carries its detail. This costs no budget — the lines that failed this ran",
    "46-98 tokens against a 150 cap.",
    "",
    "Lines 2+ cap at 60 tokens each and deepen the model. The whole text fits the",
    "lane's TOTAL CAP, which you are told per lane before you write. All caps are",
    "enforced at write by the runtime tokenizer: over any of them, that one",
    "container's write is refused and nothing else you have decided is touched.",
    "",
    "The lean target is about 5 lines under the deletion test — would a reader",
    "lose anything real if this line went? CAPACITY IS NEVER A WRITING",
    "OBLIGATION: a lane whose cap grew demands no rewrite, and a thin lane needs",
    "no second line.",
    "",
    "THE STATE CEILING. Write every claim only to the state its anchors PROVE.",
    "A /tmp preview is a /tmp preview; a design is a design; only something whose",
    "anchor shows it landed may be called shipped. What a reader absorbs becomes",
    "its belief, and an inflated state is absorbed verbatim — this is the one",
    "failure measured in the experiments behind this feature. The mechanical",
    "check is narrow on purpose (a delivery word — shipped, landed, committed,",
    "released — on a line with NO anchor is refused outright); whether an anchor",
    "actually proves the delivery its sentence claims is YOURS, and nothing",
    "checks it for you.",
    "",
    "STATE-SCOPE ISOLATION. A state predicate governs ONLY the items explicitly",
    "named in its own clause. It does not reach across a dash, a semicolon, a",
    "comma or a list boundary to items that carry no state of their own — but a",
    "READER's does, and that is the failure: an unlabelled item standing beside a",
    "delivered one is absorbed as delivered. So SOURCE, RULING, DESIGN, PREVIEW,",
    "DECODED-ONLY EVIDENCE and DELIVERED STATE never appear as unlabelled",
    "siblings. Each gets its own predicate, in its own clause, saying what it is:",
    '"X is committed (anchor)" — "Y is the ruled source, nothing built (anchor)"',
    '— "Z is decoded only, its integration open (anchor)". If you catch yourself',
    "writing one verb over a list, the list is wrong, not the verb. Every state",
    "TRANSITION starts a new locally-qualified clause; a delivery word never",
    "leads a clause whose other members are not delivered.",
    "",
    "SUPERSESSION. When a line names work that a later decision SUPERSEDED, that",
    "line SAYS SO, in the same clause, in words that mean dead — superseded by,",
    "overturned by, killed by, rejected in favour of, dead. SEQUENCE IS NOT",
    "SUPERSESSION: joining a dead path to the work that killed it with \"then\",",
    "\"later\" or a bare semicolon reads as chronology, and was measured reading",
    "exactly that way — five of five readers took the dead path for live",
    "frontier. Your own OVERRIDE edges are the mechanical source of truth for",
    "what a later decision killed; the losing side of one may never sit in a live",
    "clause without its marker.",
    "",
    "The opposite repair is also wrong, and it is the one this form falls into:",
    "DELETING the history so only live work remains buys the reader's clarity by",
    "throwing away the thing a successor would otherwise redo — the abandoned",
    "path, and the reason it was abandoned, are exactly what an impression exists",
    "to carry. Keep it and mark it dead, or omit it as a deliberate judgment.",
    "NEVER keep it unmarked.",
    "",
    "LANE RELEVANCE. A lane impression carries what belongs to THAT lane. The",
    "task-tier impression is restricted to what no lane can carry — identity",
    "shifts, cross-lane arcs — and never duplicates a lane's own text. No",
    "per-turn event bullets anywhere: an impression is a cross-node model claim,",
    "never a restatement of discrete rows, and never a maintenance ledger about",
    "itself.",
    "",
    "ANCHOR DISCIPLINE. Prose with inline anchors; no structured claim schema.",
    "Anchors go on load-bearing claims, in QUALIFIED FOLD: the first anchor in a",
    "line is the full `S<n>/T<m>`; later anchors in that SAME line from the same",
    "session may fold to a bare `T<m>`. A bare `T<m>` with no full anchor before",
    "it on its own line is refused. Every anchor must resolve to a real turn.",
    "",
    "THE FOLD RESETS AT EVERY NEWLINE. A bare `T<m>` is not this system's",
    "citation form here: line 1 pays the full `S<n>/T<m>` before anything may",
    "fold, and so does every line after it, however plain the session is from",
    "the lines above — an impression whose anchors are all bare is refused",
    "once per anchor, not once. The same per-line reading governs the delivery",
    "rule above: a line carrying shipped, landed, committed or released must",
    "carry a well-formed anchor on THAT line.",
    "",
    "WHEN TO REVISE. Revise only when the existence reason, the causal model, the",
    "bindings, the evidence state, or the open boundaries CHANGED. Continuing an",
    "existing design is not a change. Unchanged means BYTE-IDENTICAL — you keep",
    "the stored text exactly, you do not retype it. Revision is WHOLE REPLACEMENT",
    "only: the lines are prefix-coupled, and a partial patch leaves a half-new",
    "state.",
    "",
    "One thing is not a judgment call: an anchor your own edges CORRECTED in",
    "FULL this window forces you to revise or delete the sentence that rests on",
    "it. A lane whose anchors you fully corrected may not be retained. A",
    "`correct` with coverage `partial` is a nudge — reread the sentence;",
    "nothing is mechanically required.",
    "",
    "GOLDEN SAMPLE — a full impression:",
    "",
    "#visual-style",
    IMPRESSION_GOLDEN_SAMPLE_FULL,
    "",
    "GOLDEN SAMPLE — a thin lane, deliberately ONE line:",
    "",
    "#jd-portfolio-strategy",
    IMPRESSION_GOLDEN_SAMPLE_THIN,
    "",
    "HOW YOU WRITE IT. One container at a time, through `remember`, AS YOU",
    "DECIDE IT — never as one batch at the end:",
    "",
    "  remember(action: \"impression\", id: \"E<n>/#<tag>\", baseRevision: <n>,",
    "           decision: \"retain\" | \"replace\", text: \"<the whole impression>\")",
    "",
    "`id` is the container address exactly as it was printed (`E<n>/#<tag>` for a",
    "lane, `E<n>` for the task tier); `baseRevision` is the revision you were",
    "shown for it. A `replace` carries `text`, the WHOLE new impression. A",
    "`retain` carries no `text` at all.",
    "",
    "THAT CALL IS WHERE YOUR IMPRESSION IS JUDGED. It validates in full and",
    "refuses THERE, naming what it refused — an over-cap line, a bare anchor, a",
    "delivery word with no anchor on its line, a retain over a container your own",
    "edges overrode or a merge left STALE. The failure is LOCAL: only that one",
    "container is refused, every decision you already recorded still stands, and",
    "you repair that one and call again. Decide the same container twice and the",
    "LAST decision is the one you are held to.",
    "",
    "NOTHING IS WRITTEN UNTIL YOU COMMIT. A recorded decision is PENDING: no",
    "text lands, no staleness clears and no maintenance debt is discharged until",
    "your own `commit` succeeds. `commit` writes none of this — it CHECKS the",
    "duty. Every container you touched must carry a decision by then; one",
    "with none refuses the commit by name. It re-verifies each decision against",
    "the container it was made about, and if a revision or a lane's settled",
    "membership moved since you decided, the whole commit is refused and the",
    "current coordinates are printed again — read them and decide again. That",
    "applies to retains too: a retain is a judgment made against a version, and",
    "an unfenced one would mark a container checked over text you never saw. A",
    "refusal costs you no attempt.",
  ].join("\n");
}
