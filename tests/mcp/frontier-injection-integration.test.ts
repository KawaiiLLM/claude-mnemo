import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { insertLane } from "../../src/db/lanes";
import { writeMemoryEdges } from "../../src/db/memory-edges";
import { initializeSchema } from "../../src/db/schema";
import {
  addSegmentMembers,
  attachSegmentToSession,
  createSegment,
  type SegmentRecord,
} from "../../src/db/segments";
import { upsertSession } from "../../src/db/sessions";
import {
  checkFieldGate,
  sessionWriterId,
  stampField,
} from "../../src/db/write-gate";
import { renderSegmentLaneVocabulary } from "../../src/mcp/lane-vocabulary";
import {
  buildSegmentFrontierSection,
  buildSegmentLaneListView,
  renderSegmentLaneView,
} from "../../src/mcp/timeline";
import { renderAttachedSegmentBlock } from "../../src/hooks/session-composition";
import type { CitationRelation } from "../../src/db/citations";

/**
 * Frontier-injection ticket 06 — the CROSS-SURFACE integration corpus: one
 * seeded multi-task, multi-lane, multi-session fixture exercised through all
 * three read surfaces together — the SessionStart frontier block (ticket 02),
 * the lane-view adjacency pages (tickets 04/05), and the attach receipt's
 * vocabulary render (ticket 03) — with the denominator-agreement contract
 * asserted wherever the surfaces' universes coincide.
 *
 * ONE known legal divergence remains, carved out exactly (nothing else may
 * diverge). Ticket 07 P1-3 retired the other: the old reading-(a) forward-vs-
 * edges split is now an EQUALITY, because the shared visible-edge predicate
 * (`buildFrontierEdgeVisibility`) excludes an unqualifiable-head edge from
 * the digest's `edges` denominator exactly as the page render excludes it —
 * the digest counts what the page counts, on every lane.
 *
 *   (b) the attach receipt renders era-null (ticket 03 adjudication: one
 *       receipt, one universe with its sibling card) while the SessionStart
 *       block is era-scoped. This is a UNIVERSE CHOICE, not a predicate
 *       leak (peer verdict, ticket 07): the receipt is the all-era tag
 *       vocabulary — its denominators and pointers are explicitly all-era,
 *       and no cross-surface equality is promised pre-era. The divergence
 *       is possible on pre-era corpora only and vanishes whenever the block
 *       also runs era-null.
 *
 * Plus the ticket's write-gate check: pointer-only-seen `S/T` addresses (a
 * digest's `latest override` pointer, the receipt's whole render) grant
 * NOTHING — an over-write against such an address still refuses `never-read`.
 */

const BASE_EPOCH = 1_756_600_000;

function makeDb(): Database {
  const db = createDatabase(":memory:");
  initializeSchema(db);
  return db;
}

function makeSession(db: Database, contentSessionId: string): number {
  return upsertSession(db, {
    contentSessionId,
    project: "/projects/frontier-integration",
    title: `Session ${contentSessionId}`,
    insight: null,
    createdAtEpoch: BASE_EPOCH,
    updatedAtEpoch: null,
    completedAtEpoch: null,
  }).id;
}

interface TurnSpec {
  prompt: number;
  epoch: number;
  title?: string;
  types?: string[];
  tags?: string[];
}

function makeTurn(db: Database, sessionId: number, spec: TurnSpec): number {
  return db
    .query<
      { id: number },
      [number, number, string, string, string, number]
    >(
      `INSERT INTO turns (
         session_id, prompt_number, status, user_prompt, assistant_response,
         title, type, tags, created_at_epoch, was_rolled_back
       ) VALUES (?, ?, 'extracted', 'asked', 'answered', ?, ?, ?, ?, 0)
       RETURNING id`,
    )
    .get(
      sessionId,
      spec.prompt,
      spec.title ?? "corpus row",
      JSON.stringify(spec.types ?? []),
      JSON.stringify(spec.tags ?? []),
      spec.epoch,
    )!.id;
}

/** The settled truth: one COMMITTED (`done`) settlement window — never edge presence. */
function settleWindow(
  db: Database,
  sessionId: number,
  windowStart: number,
  windowEnd: number,
): void {
  db.query(
    `INSERT INTO note_settlement_jobs (
       session_id, window_start, window_end, trigger_type,
       status, attempts, retry_at_epoch, created_at_epoch, updated_at_epoch
     ) VALUES (?, ?, ?, 'consecutive', 'done', 1, 0, ?, ?)`,
  ).run(sessionId, windowStart, windowEnd, BASE_EPOCH, BASE_EPOCH);
}

function makeEdge(
  db: Database,
  citingTurnId: number,
  citedTurnId: number,
  relation: CitationRelation,
  tailTag: string,
  headTag: string,
): void {
  writeMemoryEdges(
    db,
    [
      {
        citing: { kind: "turn", id: citingTurnId },
        cited: { kind: "turn", id: citedTurnId },
        relation,
        provenance: "judged",
        tailTag,
        headTag,
      },
    ],
    BASE_EPOCH,
  );
}

/** The counts every digest line and lane-view header both speak (frontier count map). */
interface LaneCounts {
  settled: number;
  islands: number;
  singletons: number;
  frontier: number;
}

function parseCounts(line: string): LaneCounts {
  const settled = /(\d+) settled/.exec(line);
  const islands = /islands (\d+)\+(\d+)/.exec(line);
  const frontier = /frontier (\d+)/.exec(line);
  expect(settled).not.toBeNull();
  expect(islands).not.toBeNull();
  return {
    settled: Number(settled![1]),
    islands: Number(islands![1]),
    singletons: Number(islands![2]),
    frontier: frontier === null ? 0 : Number(frontier[1]),
  };
}

function digestEdgeCount(line: string): number {
  const match = /(\d+) edges/.exec(line);
  expect(match).not.toBeNull();
  return Number(match![1]);
}

function headerForwardCount(line: string): number {
  const match = /(\d+) forward/.exec(line);
  expect(match).not.toBeNull();
  return Number(match![1]);
}

/** The digest lines of a rendered block/receipt — the only lines led by a bare `#tag`. */
function digestLines(text: string): string[] {
  return text.split("\n").filter((line) => line.startsWith("#"));
}

function digestLineFor(text: string, tag: string): string {
  const line = digestLines(text).find((candidate) =>
    candidate.startsWith(`#${tag} `) || candidate === `#${tag}`,
  );
  expect(line).toBeDefined();
  return line!;
}

/** One lane's rendered adjacency page 1 through the REAL lane route (canonical `#tag` selector). */
function lanePage(db: Database, segmentId: number, tag: string): string {
  return renderSegmentLaneView(
    buildSegmentLaneListView(db, segmentId, { tag }, 1, 1000, null),
  );
}

function laneHeaderLine(pageText: string, segmentId: number, tag: string): string {
  const line = pageText
    .split("\n")
    .find((candidate) => candidate.startsWith(`E${segmentId}/#${tag} `));
  expect(line).toBeDefined();
  return line!;
}

function grantCount(db: Database, writer: string, entityType: string, entityId: number): number {
  return db
    .query<{ c: number }, [string, string, number]>(
      `SELECT COUNT(*) AS c FROM write_gate_reads
       WHERE writer = ? AND entity_type = ? AND entity_id = ?`,
    )
    .get(writer, entityType, entityId)!.c;
}

function totalGrantRows(db: Database): number {
  return db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM write_gate_reads").get()!.c;
}

/**
 * The corpus: two tasks, four lanes (one zero-settled, one sharing a tag
 * word across tasks), three sessions, five edges — including one cross-lane
 * override (task B into task A's alpha) and ONE unqualifiable-head edge (a
 * `consume` from task A's beta whose head turn belongs to no segment).
 * Under ticket 07 P1-3's shared predicate that edge is excluded from EVERY
 * surface — digest count, page render, forward multiset alike — which is
 * exactly what the equality assertions below pin.
 */
function seedCorpus(db: Database) {
  const s1 = makeSession(db, "corpus-s1");
  const s2 = makeSession(db, "corpus-s2");
  const s3 = makeSession(db, "corpus-s3");
  const taskA = createSegment(db, { title: "Task A", tags: ["task-a"], nowEpoch: BASE_EPOCH });
  const taskB = createSegment(db, { title: "Task B", tags: ["task-b"], nowEpoch: BASE_EPOCH });
  insertLane(db, taskA.id, "alpha", BASE_EPOCH);
  insertLane(db, taskA.id, "beta", BASE_EPOCH);
  insertLane(db, taskA.id, "zeta", BASE_EPOCH); // stays zero-settled, digest-only
  insertLane(db, taskB.id, "alpha", BASE_EPOCH); // same word, DIFFERENT lane

  const a1 = makeTurn(db, s1, { prompt: 1, epoch: BASE_EPOCH + 100, title: "alpha ground ruling", types: ["design"], tags: ["alpha"] });
  const a2 = makeTurn(db, s1, { prompt: 2, epoch: BASE_EPOCH + 200, title: "alpha reversal", types: ["correction"], tags: ["alpha"] });
  const a3 = makeTurn(db, s1, { prompt: 3, epoch: BASE_EPOCH + 300, title: "beta baseline", tags: ["beta"] });
  const a4 = makeTurn(db, s1, { prompt: 4, epoch: BASE_EPOCH + 400, title: "beta override lands", tags: ["beta"] });
  const a5 = makeTurn(db, s1, { prompt: 5, epoch: BASE_EPOCH + 900, title: "alpha frontier work", tags: ["alpha"] });
  const b1 = makeTurn(db, s2, { prompt: 1, epoch: BASE_EPOCH + 500, title: "cross-task corrector", tags: ["alpha"] });
  const a6 = makeTurn(db, s2, { prompt: 2, epoch: BASE_EPOCH + 600, title: "alpha follow-up", tags: ["alpha"] });
  // The pathological HEAD: carries the settled tag word but belongs to NO
  // segment, so its address can never render the mandated qualified form.
  const h1 = makeTurn(db, s3, { prompt: 1, epoch: BASE_EPOCH + 700, title: "homeless head", tags: ["beta"] });

  addSegmentMembers(db, taskA.id, [a1, a2, a3, a4, a5, a6], BASE_EPOCH);
  addSegmentMembers(db, taskB.id, [b1], BASE_EPOCH);
  attachSegmentToSession(db, s3, taskA.id, BASE_EPOCH);
  attachSegmentToSession(db, s3, taskB.id, BASE_EPOCH);
  settleWindow(db, s1, 1, 4); // a1..a4 settled; a5 (T5) stays frontier
  settleWindow(db, s2, 1, 2); // b1, a6 settled

  makeEdge(db, a2, a1, "override", "alpha", "alpha");
  makeEdge(db, a6, a2, "extends", "alpha", "alpha");
  makeEdge(db, b1, a1, "override", "alpha", "alpha"); // cross-lane, NEWEST tail
  makeEdge(db, a4, a3, "override", "beta", "beta");
  makeEdge(db, a4, h1, "consume", "beta", "beta"); // reading-(b) pathology

  return { s1, s2, s3, taskA, taskB, a1, a2, a3, a4, a5, a6, b1, h1 };
}

describe("ticket 06 — cross-surface denominator agreement on one corpus", () => {
  test("digest counts, lane-view header counts and the receipt agree wherever their universes coincide; ONLY the era-null receipt divergence parts them", () => {
    const db = makeDb();
    const { s1, s2, taskA, taskB } = seedCorpus(db);

    // Surface 1: the SessionStart block, through the REAL slot composer
    // (header line + `buildSegmentFrontierSection` bytes), era-null so its
    // universe coincides with the receipt's.
    const blockA = renderAttachedSegmentBlock(db, "milestones", taskA, null);
    const blockB = renderAttachedSegmentBlock(db, "milestones", taskB, null);
    expect(blockA.split("\n")[0]).toBe(`[E${taskA.id}] · milestones`);
    // Elected rows really render (the block is digest + rows, not digest-only).
    expect(blockA).toContain("alpha ground ruling");
    // Task B's member is not electable in task A's section.
    expect(blockA).not.toContain("cross-task corrector");

    // Surface 2: the attach receipt's vocabulary render.
    const receiptA = renderSegmentLaneVocabulary(db, taskA.id);
    const receiptB = renderSegmentLaneVocabulary(db, taskB.id);

    // Surface 3: the lane view, page 1 per lane through the canonical route.
    const pageAlphaA = lanePage(db, taskA.id, "alpha");
    const pageBeta = lanePage(db, taskA.id, "beta");
    const pageZeta = lanePage(db, taskA.id, "zeta");
    const pageAlphaB = lanePage(db, taskB.id, "alpha");

    // --- Vocabulary completeness across surfaces: every declared lane tag
    // renders on BOTH digest surfaces, zero-settled included, and (era-null
    // vs era-null) the digest lines are BYTE-IDENTICAL, order included.
    expect(digestLines(blockA)).toEqual(digestLines(receiptA));
    expect(digestLines(blockB)).toEqual(digestLines(receiptB));
    expect(digestLines(blockA).map((line) => line.split(" ")[0])).toEqual([
      "#alpha",
      "#beta",
      "#zeta",
    ]);

    // --- Exact digest grammar for the corpus (pins the denominators the
    // agreement below is then measured against).
    expect(digestLineFor(blockA, "alpha")).toBe(
      `#alpha · 3 settled · 2 edges · islands 1+0 · latest override S${s2}/T1(E${taskB.id}/#alpha) -> S${s1}/T1 · frontier 1`,
    );
    // beta counts ONE edge: the same-lane override. The `consume` onto the
    // homeless head is excluded from this denominator by the shared
    // predicate — not merely skipped at the page render (ticket 07 P1-3).
    expect(digestLineFor(blockA, "beta")).toBe(
      `#beta · 2 settled · 1 edges · islands 1+0 · latest override S${s1}/T4 -> S${s1}/T3`,
    );
    expect(digestLineFor(blockA, "zeta")).toBe("#zeta · 0 settled · 0 edges · islands 0+0");
    expect(digestLineFor(blockB, "alpha")).toBe("#alpha · 1 settled · 1 edges · islands 0+1");

    // --- Denominator agreement, lane by lane: settled / islands /
    // singletons / frontier agree on EVERY lane across digest and header.
    const laneMatrix: Array<[string, number, string, string]> = [
      ["alpha", taskA.id, digestLineFor(blockA, "alpha"), laneHeaderLine(pageAlphaA, taskA.id, "alpha")],
      ["beta", taskA.id, digestLineFor(blockA, "beta"), laneHeaderLine(pageBeta, taskA.id, "beta")],
      ["zeta", taskA.id, digestLineFor(blockA, "zeta"), laneHeaderLine(pageZeta, taskA.id, "zeta")],
      ["alpha", taskB.id, digestLineFor(blockB, "alpha"), laneHeaderLine(pageAlphaB, taskB.id, "alpha")],
    ];
    for (const [, , digest, header] of laneMatrix) {
      expect(parseCounts(header)).toEqual(parseCounts(digest));
    }

    // --- Reading-(b) EQUALITY (ticket 07 P1-3 flips the old divergence):
    // forward == edges on EVERY lane, beta included — the unqualifiable-head
    // edge is excluded from the digest denominator and the page render by
    // the ONE shared predicate, never counted on one surface and dropped on
    // the other.
    expect(headerForwardCount(laneHeaderLine(pageAlphaA, taskA.id, "alpha"))).toBe(
      digestEdgeCount(digestLineFor(blockA, "alpha")),
    );
    expect(headerForwardCount(laneHeaderLine(pageZeta, taskA.id, "zeta"))).toBe(
      digestEdgeCount(digestLineFor(blockA, "zeta")),
    );
    expect(headerForwardCount(laneHeaderLine(pageAlphaB, taskB.id, "alpha"))).toBe(
      digestEdgeCount(digestLineFor(blockB, "alpha")),
    );
    expect(headerForwardCount(laneHeaderLine(pageBeta, taskA.id, "beta"))).toBe(
      digestEdgeCount(digestLineFor(blockA, "beta")),
    );
    // The excluded edge is invisible in the skeleton too — no unqualified stub.
    expect(pageBeta).not.toContain("consume");

    // --- The lane view's own cross-surface content spot-checks: the
    // cross-lane forward stub and the cross-lane inbound mirror both name
    // the SAME qualified addresses the digest pointer speaks.
    expect(pageAlphaB).toContain(`override => S${s1}/T1^(E${taskA.id}/#alpha)`);
    expect(pageAlphaA).toContain(`└ override <= S${s2}/T1^(E${taskB.id}/#alpha)`);

    db.close();
  });

  test("the era-null receipt divergence, carved exactly (a universe choice, not a predicate leak): the all-era receipt parts from the era-scoped block ONLY by the members the cutoff excludes", () => {
    const db = makeDb();
    const { taskA } = seedCorpus(db);

    // Cutoff between a2 (BASE+200) and a3 (BASE+300): alpha loses a1+a2 from
    // the era half, keeping a6 settled and a5 frontier; beta keeps both.
    const eraSection = buildSegmentFrontierSection(db, taskA.id, BASE_EPOCH + 250, 2000);
    const receipt = renderSegmentLaneVocabulary(db, taskA.id);

    expect(digestLineFor(eraSection, "alpha")).toContain("1 settled");
    expect(digestLineFor(receipt, "alpha")).toContain("3 settled");
    // Where the cutoff excludes nothing, the two surfaces still agree.
    expect(parseCounts(digestLineFor(eraSection, "beta"))).toEqual(
      parseCounts(digestLineFor(receipt, "beta")),
    );

    db.close();
  });
});

describe("ticket 06 — pointer-only-seen addresses grant nothing at the write gate", () => {
  test("a digest pointer's S/T address earns no read grant, and the over-write it would license refuses never-read; the receipt render grants nothing at all", () => {
    const db = makeDb();
    const { s2, s3, taskA, a1, b1 } = seedCorpus(db);
    const reader = sessionWriterId(s3);

    // Render the block WITH a reader identity (the primitive's own seam; the
    // hook path passes none and grants nothing at all). Budget 2000 accepts
    // every settled task-A candidate, so a1 is granted AS AN ACCEPTED ROW —
    // while b1, task B's member, appears ONLY inside the digest pointer
    // `latest override S<s2>/T1(E<B>/#alpha) -> …` and can never be a row here.
    const section = buildSegmentFrontierSection(db, taskA.id, null, 2000, reader);
    expect(section).toContain(`latest override S${s2}/T1`);
    expect(section).not.toContain("cross-task corrector");

    expect(grantCount(db, reader, "segment", taskA.id)).toBe(1);
    expect(grantCount(db, reader, "turn", a1)).toBe(1); // accepted row → granted
    expect(grantCount(db, reader, "turn", b1)).toBe(0); // pointer-only → NOT granted

    // The over-write the pointer sighting must NOT license: another writer
    // owns b1's content, so the gate has to consult a grant — and finds none.
    stampField(db, "turn", b1, "content", sessionWriterId(s2), BASE_EPOCH + 1_000);
    const verdict = checkFieldGate(db, reader, "turn", b1, "content", `S${s2}/T1`, {
      requireCompleteRead: true,
    });
    expect(verdict.ok).toBe(false);
    expect(!verdict.ok && verdict.reason).toBe("never-read");

    // The attach receipt is a PURE render (ticket 03 adjudication: its digest
    // pointers ship ungranted) — the grants table does not move at all.
    const before = totalGrantRows(db);
    renderSegmentLaneVocabulary(db, taskA.id);
    renderSegmentLaneVocabulary(db, taskA.id);
    expect(totalGrantRows(db)).toBe(before);

    db.close();
  });
});
