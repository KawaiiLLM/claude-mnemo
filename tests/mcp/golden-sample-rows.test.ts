import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { writeMemoryEdges } from "../../src/db/memory-edges";
import { initializeSchema } from "../../src/db/schema";
import { reindexTurnFromDb } from "../../src/db/search";
import { addSegmentMembers, attachSegmentToSession } from "../../src/db/segments";
import { recallMemory } from "../../src/mcp/recall";
import { timelineQuery } from "../../src/mcp/timeline";

/**
 * The rendered contract, byte for byte.
 *
 * Every `expect` in this file compares against a block QUOTED from the spec's
 * 金样例 section (`.scratch/read-write-contract/spec.md`, "金样例" — the
 * user's own verbatim example blocks, restated at [S15069/T1029]). The
 * fixtures are built to make those blocks reachable literally: the segment is
 * `E31`, the sessions are `S15069`/`S15088`, the turns carry the sample's own
 * prompt numbers, and the placeholder strings (`title`, `xxx`) are the stored
 * values. A row that reads differently here is a row that reads differently
 * to the model.
 *
 * Sessions are inserted with `title = NULL` on purpose wherever the sample's
 * transition line is BARE (`    [S15069]`). The transition-line contract is
 * "title on first appearance" ([S15069/T1032]), so a titled session's first
 * appearance carries its title — asserted separately below — and the sample
 * blocks pin the shape, not the presence of a title the fixture never stored.
 */

const CUTOFF = Date.UTC(2026, 7, 1) / 1000;
/** 2026-08-17 18:19 UTC — the sample's own stamp, so `08-17 18:19` renders literally. */
const T821_EPOCH = Date.UTC(2026, 7, 17, 18, 19) / 1000;

describe("金样例 — the rendered row contract", () => {
  let db: Database;
  const originalTz = process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

  function insertSession(id: number, title: string | null): void {
    db.run(
      `INSERT INTO sessions (id, content_session_id, project, title, created_at_epoch)
       VALUES (?, ?, '/tmp/project', ?, ?)`,
      [id, `content-${id}`, title, CUTOFF],
    );
  }

  function insertSegment(id: number, title: string): void {
    db.run(
      `INSERT INTO segments (id, title, type, tags, status, created_at_epoch, updated_at_epoch)
       VALUES (?, ?, '[]', '[]', 'open', ?, ?)`,
      [id, title, CUTOFF, CUTOFF],
    );
  }

  function insertTurn(options: {
    sessionId: number;
    promptNumber: number;
    title: string | null;
    content?: string | null;
    epoch?: number;
    type?: string[];
    tags?: string[];
    rolledBack?: boolean;
    toolCallCount?: number;
    filesModified?: string[];
  }): number {
    const id = db
      .query<{ id: number }, unknown[]>(
        `INSERT INTO turns (
           session_id, prompt_number, status, type, title, created_at_epoch,
           user_prompt, assistant_response, content, files_read, files_modified,
           tags, was_rolled_back, tool_call_count
         ) VALUES (?, ?, 'extracted', ?, ?, ?, 'user prompt', 'assistant response',
                   ?, '[]', ?, ?, ?, ?)
         RETURNING id`,
      )
      .get(
        options.sessionId,
        options.promptNumber,
        JSON.stringify(options.type ?? []),
        options.title,
        options.epoch ?? CUTOFF + options.promptNumber,
        options.content ?? null,
        JSON.stringify(options.filesModified ?? []),
        JSON.stringify(options.tags ?? []),
        options.rolledBack ? 1 : 0,
        options.toolCallCount ?? 0,
      )!.id;
    reindexTurnFromDb(db, id);
    return id;
  }

  beforeEach(() => {
    process.env.TZ = "UTC";
    db = createDatabase(":memory:");
    initializeSchema(db);
  });

  afterEach(() => {
    db.close();
    process.env.TZ = originalTz;
  });

  // -------------------------------------------------------------------------
  // 金样例: `recall(id="S31/T1..10")` 会话 turn 列表
  // -------------------------------------------------------------------------

  test("session turn listing: the session heads its own rows, turn rows are bare, fields sit one rung under", () => {
    insertSession(15069, "title");
    insertTurn({ sessionId: 15069, promptNumber: 823, title: "title", content: "xxx", rolledBack: true });
    insertTurn({ sessionId: 15069, promptNumber: 824, title: "title", content: "xxx", rolledBack: true });

    const output = recallMemory(db, { id: "S15069/T823..824" });

    expect(output).toBe(
      [
        "[S15069] title",
        "    [T823] title [extracted] [rewind]",
        "        08-01 00:13",
        "        - content: xxx",
        "    [T824] title [extracted] [rewind]",
        "        08-01 00:13",
        "        - content: xxx",
      ].join("\n"),
    );
  });

  // -------------------------------------------------------------------------
  // 金样例: `recall(id="E31/T1..10")` 段成员列表
  // -------------------------------------------------------------------------

  test("segment member listing: [E] → [S] → [T] → field rows, no per-row session prefix", () => {
    insertSession(15069, null);
    insertSegment(31, "title");
    const first = insertTurn({
      sessionId: 15069,
      promptNumber: 823,
      title: "title",
      content: "xxx",
      rolledBack: true,
    });
    const second = insertTurn({
      sessionId: 15069,
      promptNumber: 824,
      title: "title",
      content: "xxx",
      rolledBack: true,
    });
    addSegmentMembers(db, 31, [first, second], CUTOFF);

    const output = recallMemory(db, { id: "E31/T1..10" });

    expect(output).toBe(
      [
        "[E31] title",
        "    [S15069]",
        "        [T823] title [extracted] [rewind]",
        "            08-01 00:13",
        "            - content: xxx",
        "        [T824] title [extracted] [rewind]",
        "            08-01 00:13",
        "            - content: xxx",
      ].join("\n"),
    );
  });

  // -------------------------------------------------------------------------
  // 金样例: `recall(id="E31")` 段卡片
  // -------------------------------------------------------------------------

  test("segment card: a stats row, facet rows, a BARE session id list, content/insight, and unfolded 0-row lines", () => {
    insertSession(15069, null);
    insertSession(15088, null);
    insertSegment(31, "title");
    db.run(`UPDATE segments SET content = ?, insight = ?, goal = ? WHERE id = 31`, [
      "...",
      "xxx",
      "- xxx\n- xxx",
    ]);
    const member = insertTurn({
      sessionId: 15069,
      promptNumber: 823,
      title: "title",
      type: ["research"],
    });
    addSegmentMembers(db, 31, [member], CUTOFF);
    attachSegmentToSession(db, 15069, 31, CUTOFF);
    attachSegmentToSession(db, 15088, 31, CUTOFF);

    const output = recallMemory(db, { id: "E31" });

    expect(output).toBe(
      [
        "[E31] title",
        "    - stats: [open] · 1 turn · created 2026-08-01 · last edit 2026-08-01 · maintenance 1 turn ago",
        "    - type: 🔍research×1",
        "    - sessions: S15069, S15088",
        "    - content: ...",
        "    - insight: xxx",
        "    - goal:",
        "        - xxx",
        "        - xxx",
        "    - constraints: 0 rows",
        "    - decisions: 0 rows",
        "    - done: 0 rows",
        "    - next_steps: 0 rows",
        "    - reference: 0 rows",
      ].join("\n"),
    );
  });

  // -------------------------------------------------------------------------
  // 金样例: timeline 里程碑视图
  // -------------------------------------------------------------------------

  test("milestone view: bracketed address, per-row date+time, type glyph, title — and ↳ antecedent ADDRESSES", () => {
    insertSession(15069, null);
    insertSession(15088, null);
    insertSegment(31, "title");
    const t811 = insertTurn({
      sessionId: 15069,
      promptNumber: 811,
      title: "title",
      epoch: T821_EPOCH - 600,
      type: ["design"],
    });
    const t812 = insertTurn({
      sessionId: 15069,
      promptNumber: 812,
      title: "title",
      epoch: T821_EPOCH - 300,
      type: ["design"],
    });
    const t821 = insertTurn({
      sessionId: 15069,
      promptNumber: 821,
      title: "title",
      epoch: T821_EPOCH,
      type: ["design"],
    });
    const t822 = insertTurn({
      sessionId: 15069,
      promptNumber: 822,
      title: "title",
      epoch: T821_EPOCH + 60,
      type: ["design"],
    });
    const s2t21 = insertTurn({
      sessionId: 15088,
      promptNumber: 21,
      title: "title",
      epoch: T821_EPOCH + 86_400,
      type: ["design"],
    });
    addSegmentMembers(db, 31, [t811, t812, t821, t822, s2t21], CUTOFF);
    writeMemoryEdges(db, [
      { citing: { kind: "turn", id: t821 }, cited: { kind: "turn", id: t811 }, relation: "extends", provenance: "asserted" },
      { citing: { kind: "turn", id: t821 }, cited: { kind: "turn", id: t812 }, relation: "extends", provenance: "asserted" },
    ], CUTOFF);

    const output = timelineQuery(db, {
      id: "E31",
      view: "milestones",
      pageSize: 3,
      taskCausalityEraCutoffEpoch: CUTOFF,
    });

    // The sample's own shape: `[E31] title` → `    [S…]` → `        [T…] date
    // time glyph title` → `            ↳ <addresses>`. Only the head of the
    // page is asserted verbatim; the selection itself is ticket 02's subject.
    const lines = output.split("\n");
    expect(lines[0]).toBe("[E31] title");
    expect(lines[1]).toBe("    [S15069]");
    expect(lines).toContain("        [T821] 08-17 18:19 ⚖️ title");
    expect(lines).toContain("            ↳ T811, T812");
    // A milestone row never carries a G value.
    expect(output).not.toMatch(/\bG[0-4]\b/);
  });

  test("milestone view: an antecedent in ANOTHER session renders session-qualified", () => {
    insertSession(15069, null);
    insertSession(15088, null);
    insertSegment(31, "title");
    const foreign = insertTurn({
      sessionId: 15088,
      promptNumber: 21,
      title: "title",
      epoch: T821_EPOCH - 600,
      type: ["design"],
    });
    const citer = insertTurn({
      sessionId: 15069,
      promptNumber: 821,
      title: "title",
      epoch: T821_EPOCH,
      type: ["design"],
    });
    addSegmentMembers(db, 31, [foreign, citer], CUTOFF);
    writeMemoryEdges(db, [
      { citing: { kind: "turn", id: citer }, cited: { kind: "turn", id: foreign }, relation: "extends", provenance: "asserted" },
    ], CUTOFF);

    const output = timelineQuery(db, {
      id: "E31",
      view: "milestones",
      pageSize: 10,
      taskCausalityEraCutoffEpoch: CUTOFF,
    });

    expect(output.split("\n")).toContain("            ↳ S15088/T21");
  });

  test("milestone view: a session re-entered later gets a second transition line, and its title only once", () => {
    insertSession(15069, "first");
    insertSession(15088, "second");
    insertSegment(31, "title");
    const a = insertTurn({ sessionId: 15069, promptNumber: 821, title: "title", epoch: T821_EPOCH, type: ["design"] });
    const b = insertTurn({
      sessionId: 15088,
      promptNumber: 21,
      title: "title",
      epoch: T821_EPOCH + 86_400,
      type: ["design"],
    });
    const c = insertTurn({
      sessionId: 15069,
      promptNumber: 823,
      title: "title",
      epoch: T821_EPOCH + 172_800,
      type: ["design"],
    });
    addSegmentMembers(db, 31, [a, b, c], CUTOFF);

    const lines = timelineQuery(db, {
      id: "E31",
      view: "milestones",
      pageSize: 10,
      taskCausalityEraCutoffEpoch: CUTOFF,
    }).split("\n");

    expect(lines.filter((line) => line.startsWith("    [S"))).toEqual([
      "    [S15069] first",
      "    [S15088] second",
      "    [S15069]",
    ]);
  });

  // -------------------------------------------------------------------------
  // ticket 05 (.scratch/view-render-repair/05-timeline-one-row-form.md):
  // turns 表溶解's SECOND act — the `metadata`/`- content:` shape these two
  // tests used to pin (read-write-contract spec) was itself replaced: the
  // turns view now adopts the SAME minimal milestone row this file's
  // "milestone view" tests above already assert (`[T<n>] date time glyph
  // title`), with no metadata line and no `- content:` anywhere on ANY
  // timeline output. `[rewind]` does not carry over either — that marker is
  // recall's own row (format.ts's `FormattedTurn.wasRolledBack`), asserted on
  // recall separately in this same file ("session turn listing" above).
  //
  // T823 here is NOT rolled back (view-render-repair ticket 06, ruling
  // [S15069/T1084] supersedes the original fixture, which used
  // `rolledBack: true` to prove the row exists without a `[rewind]` marker):
  // a rolled-back turn is now excluded from timeline's row set entirely, so
  // it can no longer stand in for "the minimal row shape, unmarked" — it
  // renders no row at all. `[rewind]`'s absence from a LIVE row is still
  // proven by the trailing `not.toContain("[rewind]")` below; a dedicated
  // "rolled-back turn has no row" case lives in timeline.test.ts.
  // -------------------------------------------------------------------------

  test("turns view: no tabular surface, no metadata line, no `- content:` — the SAME minimal row the milestones view uses", () => {
    insertSession(15069, null);
    insertSegment(31, "title");
    const first = insertTurn({
      sessionId: 15069,
      promptNumber: 823,
      title: "title",
      epoch: T821_EPOCH,
      toolCallCount: 20,
      filesModified: ["a.ts", "b.ts", "c.ts"],
    });
    addSegmentMembers(db, 31, [first], CUTOFF);

    const output = timelineQuery(db, { id: "E31", view: "turns" });

    // No `type` was stored, so the glyph is the pending placeholder (`⏳`) —
    // the same fact `milestoneEffGrade`'s truth table and every other view
    // read off an empty type list.
    expect(output).toBe(
      ["[E31] title", "    [S15069]", "        [T823] 08-17 18:19 ⏳ title"].join("\n"),
    );
    expect(output).not.toContain(" | ");
    expect(output).not.toContain("- content:");
    expect(output).not.toContain("[rewind]");
  });

  test("turns view: every member states its OWN stamp inline (no shared gap line to carry it)", () => {
    insertSession(15069, null);
    insertSegment(31, "title");
    const first = insertTurn({ sessionId: 15069, promptNumber: 823, title: "title", epoch: T821_EPOCH });
    const second = insertTurn({
      sessionId: 15069,
      promptNumber: 824,
      title: "title",
      epoch: T821_EPOCH + 360,
    });
    addSegmentMembers(db, 31, [first, second], CUTOFF);

    const lines = timelineQuery(db, { id: "E31", view: "turns" }).split("\n");
    expect(lines).toContain("        [T823] 08-17 18:19 ⏳ title");
    expect(lines).toContain("        [T824] 08-17 18:25 ⏳ title");
  });

  // Ticket 12 (edge-mechanism-revision spec, [S15069/T1135] re-pin): metadata
  // is a DEFAULT row, not an opt-in one — this test used to pin the opposite
  // (metadata excluded unless explicitly requested), which was itself the
  // regression the ruling base names (d0590fe). `filter.fields` stays the
  // sole selection mechanism: an explicit NARROW selection can still drop
  // metadata, just as it always could drop title or content.
  test("metadata renders by default; an explicit narrow selection can still drop it", () => {
    insertSession(15069, null);
    insertTurn({
      sessionId: 15069,
      promptNumber: 823,
      title: "title",
      content: "xxx",
      epoch: T821_EPOCH,
      toolCallCount: 20,
      // Ticket 10 (write-mode-edit-semantics spec D8): type/tags now ride on
      // this SAME metadata line, so this sample turn carries both to prove
      // the extended shape, not just the pre-ticket-10 time+stats prefix.
      type: ["design", "research"],
      tags: ["claude-mnemo", "write-gate"],
    });

    const byDefault = recallMemory(db, { id: "S15069/T823" });
    expect(byDefault.split("\n")).toEqual([
      "[S15069]",
      "    [T823] title [extracted]",
      "        08-17 18:19 · 🔧20 · design, research · #claude-mnemo #write-gate",
      "        - content: xxx",
    ]);

    const narrowed = recallMemory(db, {
      id: "S15069/T823",
      filter: { fields: ["title", "content"] },
    });
    expect(narrowed).not.toContain("08-17 18:19");
  });

  test("metadata: an empty type and an empty tags list each drop their own segment, no orphan separator", () => {
    insertSession(15069, null);
    insertTurn({
      sessionId: 15069,
      promptNumber: 823,
      title: "title",
      content: "xxx",
      epoch: T821_EPOCH,
      toolCallCount: 20,
      // type/tags both default to [] via insertTurn — nothing stored for
      // either, so the metadata line must read exactly as it did before
      // ticket 10: no trailing " · " for either missing segment.
    });

    const requested = recallMemory(db, {
      id: "S15069/T823",
      filter: { fields: ["title", "metadata", "content"] },
    });
    expect(requested.split("\n")).toEqual([
      "[S15069]",
      "    [T823] title [extracted]",
      "        08-17 18:19 · 🔧20",
      "        - content: xxx",
    ]);
  });

  test("metadata: type present but tags empty renders only the type segment — no orphan separator", () => {
    insertSession(15069, null);
    insertTurn({
      sessionId: 15069,
      promptNumber: 823,
      title: "title",
      content: "xxx",
      epoch: T821_EPOCH,
      type: ["design"],
    });

    const requested = recallMemory(db, {
      id: "S15069/T823",
      filter: { fields: ["title", "metadata", "content"] },
    });
    expect(requested.split("\n")).toEqual([
      "[S15069]",
      "    [T823] title [extracted]",
      "        08-17 18:19 · design",
      "        - content: xxx",
    ]);
  });

  test("metadata: tags present but type empty renders only the tags segment — no orphan separator", () => {
    insertSession(15069, null);
    insertTurn({
      sessionId: 15069,
      promptNumber: 823,
      title: "title",
      content: "xxx",
      epoch: T821_EPOCH,
      tags: ["write-gate"],
    });

    const requested = recallMemory(db, {
      id: "S15069/T823",
      filter: { fields: ["title", "metadata", "content"] },
    });
    expect(requested.split("\n")).toEqual([
      "[S15069]",
      "    [T823] title [extracted]",
      "        08-17 18:19 · #write-gate",
      "        - content: xxx",
    ]);
  });

  // -------------------------------------------------------------------------
  // 金样例 + 补充裁决: the listing shape and the page-open citation escape
  // -------------------------------------------------------------------------

  test("listing shape: transition lines, no count badges, title only on a session's first appearance", () => {
    insertSession(15069, "first");
    insertSession(15088, "second");
    insertTurn({ sessionId: 15069, promptNumber: 1, title: "one", content: "xxx", epoch: CUTOFF + 1 });
    insertTurn({ sessionId: 15088, promptNumber: 1, title: "two", content: "xxx", epoch: CUTOFF + 2 });
    insertTurn({ sessionId: 15069, promptNumber: 2, title: "three", content: "xxx", epoch: CUTOFF + 3 });

    const output = recallMemory(db, {});
    const lines = output.split("\n");

    expect(lines).toEqual([
      "── turns ──",
      "[S15069] first",
      "    [T2] three [extracted]",
      "        - content: xxx",
      "[S15088] second",
      "    [T1] two [extracted]",
      "        - content: xxx",
      "[S15069]",
      "    [T1] one [extracted]",
      "        - content: xxx",
    ]);
    // No badge survives anywhere on the listing.
    expect(output).not.toMatch(/[💬💡🔧✏️📖]\d/);
  });

  test("page-open escape: a page opening mid-session-run repeats no transition line and gives its FIRST row the full [S][T] form", () => {
    insertSession(15069, "first");
    for (let promptNumber = 1; promptNumber <= 4; promptNumber += 1) {
      insertTurn({
        sessionId: 15069,
        promptNumber,
        title: `t${promptNumber}`,
        content: "xxx",
        epoch: CUTOFF + promptNumber,
      });
    }

    const page2 = recallMemory(db, { page: 2, pageSize: 2 }).split("\n");

    expect(page2).toEqual([
      "── turns ──",
      "page 2 / 2 (total 4)",
      "    [S15069][T2] t2 [extracted]",
      "        - content: xxx",
      "    [T1] t1 [extracted]",
      "        - content: xxx",
    ]);
  });

  test("segment member listing: a page opening mid-session-run carries the same escape", () => {
    insertSession(15069, null);
    insertSegment(31, "title");
    const ids: number[] = [];
    for (let promptNumber = 823; promptNumber <= 826; promptNumber += 1) {
      ids.push(
        insertTurn({
          sessionId: 15069,
          promptNumber,
          title: "title",
          content: "xxx",
          epoch: CUTOFF + promptNumber,
        }),
      );
    }
    addSegmentMembers(db, 31, ids, CUTOFF);

    const page2 = recallMemory(db, { id: "E31/T*", page: 2, pageSize: 2 }).split("\n");

    expect(page2.filter((line) => !/^\s+\d\d-\d\d \d\d:\d\d/.test(line))).toEqual([
      "page 2 / 2 (total 4)",
      "[E31] title",
      "        [S15069][T825] title [extracted]",
      "            - content: xxx",
      "        [T826] title [extracted]",
      "            - content: xxx",
    ]);
    // The metadata line rides between each title row and its field rows
    // (golden sample Image #7); its clock varies with the fixture epochs, so
    // it is pinned by shape and position rather than by literal time.
    expect(page2[3]).toMatch(/^            \d\d-\d\d \d\d:\d\d/);
    expect(page2[6]).toMatch(/^            \d\d-\d\d \d\d:\d\d/);
  });

  // -------------------------------------------------------------------------
  // 补充裁决: 搜索形态与浏览形态的唯一差异=排序
  //
  // Ticket 12 (edge-mechanism-revision spec): this ruling's byte-for-byte
  // equality with the bare browse feed was always coincidental, not pinned —
  // a search hit renders through `DEFAULT_TURN_RENDER_FIELDS` (a turn CARD,
  // same as any id-addressed turn), while the bare browse feed uses its own,
  // deliberately narrower `DEFAULT_BROWSE_FIELDS` (recall.ts, a one-line
  // listing, unaffected by this ticket — see format.ts's own comment on
  // `DEFAULT_TURN_RENDER_FIELDS`). The two defaults were identical before
  // this ticket added `metadata` to the former only, so a search hit now
  // carries the same metadata line any other turn card does; the RUNGS this
  // test actually pins (transition line, bare turn row, `- content:` row,
  // relevance ordering) are unchanged.
  // -------------------------------------------------------------------------

  test("search shape = browse shape in its rungs and ordering; a search hit is a turn card, so it also carries metadata", () => {
    insertSession(15069, "first");
    insertTurn({ sessionId: 15069, promptNumber: 1, title: "alpha", content: "needle here", epoch: CUTOFF + 1 });
    insertTurn({ sessionId: 15069, promptNumber: 2, title: "beta", content: "plain body", epoch: CUTOFF + 2 });

    const search = recallMemory(db, { query: "needle" }).split("\n");

    // Same rungs as the browse feed: a transition line, then a bare turn row,
    // then the metadata line, then a `- content:` field row. No session-header
    // stats.
    expect(search[0]).toBe("[S15069] first");
    expect(search[1]).toBe("    [T1] alpha [extracted]");
    expect(search[2]).toBe("        08-01 00:00");
    expect(search[3]).toStartWith("        - content: ");
    expect(search[3]).toContain("**needle**");
    expect(search.some((line) => line.includes("💬") || line.includes("💡"))).toBe(false);
  });
});
