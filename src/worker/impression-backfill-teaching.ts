import { renderImpressionTeaching } from "./note-settlement-impression-teaching";
import type { BackfillAnchorRow, BackfillTaskInput } from "./impression-backfill";

/**
 * THE MIGRATION TEACHING VARIANT (lane-impressions spec Rev 8, "Legacy
 * backfill": "The migration mode gets its own teaching variant — synthesizes
 * from fields, not windows — ON THE SAME LAW (line form, state ceiling,
 * checklist)").
 *
 * IT BUILDS ON TICKET 02'S TEXT, IT DOES NOT FORK IT.
 * `renderImpressionTeaching()` is rendered VERBATIM below and everything this
 * module adds sits around it: what the source is (four retiring fields, not a
 * settlement window), where anchors come from (the member/anchor index, and
 * nowhere else), and what to do with material that fits nowhere (report it as
 * `unresolved`, which REFUSES this task's cutover rather than inventing a home
 * for it). A forked copy of the writing law would be a second law, free to
 * drift from the one settlement enforces on the very same containers minutes
 * later.
 *
 * THE ONE RULE THAT DOES NOT CARRY OVER is the submission shape: settlement
 * submits `{id, baseRevision, decision}` per touched container through its
 * `commit` tool; a migration job returns ONE batch for ONE task and carries no
 * revisions, because the fence it is checked against is the SOURCE SNAPSHOT,
 * which the job holds rather than the writer. So the shared text's "HOW YOU
 * SUBMIT IT" paragraph is superseded explicitly and out loud, rather than
 * silently contradicted.
 *
 * THE INDEX IS RENDERED WHOLE, and that is a decision rather than an oversight.
 * A truncated member/anchor index would make "re-source every load-bearing
 * claim through the index" quietly unachievable for any claim about an early
 * turn — the writer would be forced to either invent an address (refused at
 * commit) or report the claim `unresolved` (refusing the whole task's cutover)
 * for no reason but a render budget. The spec answers input size with a
 * MEASUREMENT GATE, not a cap, so this renders everything and the scale gate
 * reports what that costs.
 */

function renderAnchorRow(anchor: BackfillAnchorRow): string {
  const lanes =
    anchor.laneTags.length > 0
      ? ` [${anchor.laneTags.map((tag) => `#${tag}`).join(" ")}]`
      : "";
  return `    ${anchor.address}${lanes} ${anchor.title ?? "(untitled)"}`;
}

/**
 * The task's inputs, as the migration writer reads them: the four source
 * fields verbatim, the declared-lane roster with each lane's budget and member
 * addresses, and the task-wide member/anchor index the claims must be
 * re-sourced through.
 *
 * DATA ONLY — every instruction lives in `renderImpressionBackfillTeaching`
 * below, the same split ticket 02 draws between its advisory block and its
 * prompt.
 *
 * The task-wide index carries each member's TITLE and its lane words; the
 * per-lane blocks carry only ADDRESSES, because a member's title would then be
 * rendered once per lane it belongs to and says nothing new the second time.
 */
export function renderImpressionBackfillInput(input: BackfillTaskInput): string {
  const lines: string[] = [
    `## The task: E${input.segmentId} [${input.status}] ${input.title}`,
    "",
    "### The retiring fields, verbatim",
    "",
  ];
  const field = (name: string, value: string | null): void => {
    lines.push(`#### ${name}`, "");
    lines.push(value === null || value.trim() === "" ? "(empty)" : value, "");
  };
  field("content (becomes the TASK-TIER impression)", input.source.content);
  field("done (retires)", input.source.done);
  field("decisions (dissolves into the impressions)", input.source.decisions);
  field("next_steps (retires; what is still owed becomes frontier lines)", input.source.nextSteps);

  lines.push(
    `### The declared-lane roster: ${input.lanes.length} lane(s), each with its budget`,
    "",
  );
  if (input.lanes.length === 0) {
    lines.push(
      "(none — this task declares no lane, so there is nothing but the task tier to write)",
      "",
    );
  }
  for (const lane of input.lanes) {
    lines.push(
      `#${lane.tag} — cap ${lane.cap} tokens (${lane.settledMemberCount} settled member(s)); ` +
        `${lane.anchors.length} member(s):`,
    );
    lines.push(
      lane.anchors.length === 0
        ? "    (no member carries this lane's word)"
        : `    ${lane.anchors.map((anchor) => anchor.address).join(", ")}`,
    );
    lines.push("");
  }

  lines.push(
    `### The task tier — cap ${input.taskCap} tokens`,
    "",
    `The member/anchor index: ${input.anchorIndex.length} live member turn(s), event order.`,
    "THESE ADDRESSES, AND NO OTHERS, ARE ADMISSIBLE ANCHORS.",
    "",
  );
  if (input.anchorIndex.length === 0) {
    lines.push("    (this task owns no live member turn — no claim here can be anchored)");
  }
  for (const anchor of input.anchorIndex) {
    lines.push(renderAnchorRow(anchor));
  }
  return lines.join("\n");
}

/**
 * The migration writer's whole instruction set: the shared writing law, then
 * the four things that are true only of a migration.
 */
export function renderImpressionBackfillTeaching(): string {
  return [
    "# Legacy backfill — seed this task's impressions, once",
    "",
    "You are a MIGRATION job, not a settlement run. You see one whole task: its",
    "retiring narrative fields, its declared-lane roster, and its member/anchor",
    "index. You write that task's per-lane INITIAL impressions and its TASK-TIER",
    "impression, once, and the same transaction that stores them retires the",
    "fields you read. Ordinary settlement maintains them from there on.",
    "",
    renderImpressionTeaching(),
    "",
    "## What is different because this is a migration",
    "",
    "YOUR SOURCE IS FIELDS, NOT A WINDOW. A settlement run synthesizes from the",
    "turns it just settled; you synthesize from `done`, `decisions`,",
    "`next_steps` and `content` — text written by hand over the task's whole",
    "life. Read it as a record of what was BELIEVED, not as proof of what is",
    "TRUE: the state ceiling above applies to every sentence you carry across,",
    "and a legacy row saying something shipped is not itself evidence that it",
    "did.",
    "",
    "ANCHORS COME FROM THE INDEX, AND FROM NOWHERE ELSE. Most legacy rows carry",
    "no address at all, so a load-bearing claim has to be RE-SOURCED: find the",
    "member turn that proves it in the member/anchor index you were given, and",
    "cite that turn. An address you did not read in the index is refused even if",
    "it happens to name a real turn somewhere — migrating a claim onto an",
    "invented address would mint untraceable current law, which is worse than",
    "the claim not surviving at all.",
    "",
    "A LOAD-BEARING CLAIM YOU CANNOT ANCHOR GOES TO `unresolved`. So does",
    "content that belongs to no lane and is not task-level. Do NOT drop it, do",
    "NOT weaken it into something you can say without an anchor, and do NOT",
    "invent a third place to keep it. Report it, and this task's cutover is",
    "REFUSED: its fields stay exactly as they are until a human or a better",
    "mapping resolves them. Nothing you report is lost; something you drop is.",
    "",
    "WHAT YOU RETURN is ONE JSON object, and nothing else:",
    "",
    '  {"lanes": [{"tag": "visual-style", "text": "…"}, …],',
    '   "task": "…",',
    '   "unresolved": [{"claim": "…", "reason": "…"}]}',
    "",
    "`task` is REQUIRED — the task-tier impression, and its arrival is what cuts",
    "this task over. `lanes` carries one entry per lane you had material for; a",
    "declared lane the fields say nothing about simply gets no entry, because a",
    "first impression invented out of nothing is exactly the failure this whole",
    "surface exists to avoid. `unresolved` is `[]` when everything found a home.",
    "",
    "This supersedes the shared law's `HOW YOU SUBMIT IT` paragraph: there is no",
    "`commit` tool here, no per-container `decision`, and no `baseRevision` — the",
    "fence you are checked against is a snapshot of the SOURCES you were shown,",
    "and the job holds it for you. If any of them moved while you were writing,",
    "nothing lands and you are asked again from scratch.",
  ].join("\n");
}

/** The whole model context for one migration job: the law, then the task. */
export function renderImpressionBackfillPrompt(
  input: BackfillTaskInput,
  /** The previous attempt's refusal, verbatim — a regeneration is told exactly what it must repair. */
  feedback: string | null,
): string {
  const blocks = [renderImpressionBackfillTeaching(), renderImpressionBackfillInput(input)];
  if (feedback !== null) {
    blocks.push(
      [
        "## Your previous attempt was refused",
        "",
        "Nothing landed. Read the refusal, then write the batch again from scratch —",
        "the inputs above are re-read for you at every attempt, so they are current.",
        "",
        feedback,
      ].join("\n"),
    );
  }
  return blocks.join("\n\n");
}
