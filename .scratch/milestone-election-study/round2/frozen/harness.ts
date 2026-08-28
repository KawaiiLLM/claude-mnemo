/**
 * Round-2 milestone-election harness. Copied into each arm tree
 * (/tmp/mnemo-r2-arms/<ARM>/harness.ts) and run there, so every `./src`
 * import resolves to THAT arm's election module. Production DB is opened
 * strictly read-only; src/ is never written.
 *
 * Usage: bun run harness.ts <ARM>   (cwd = the arm tree)
 * Writes /tmp/mstudy2/<ARM>/{card-E60.txt,card-E70.txt,seated.tsv,election.tsv}
 * and (arm A only, but identical for all) manifest.tsv.
 */
import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolveEraCutoff } from "./src/db/era";
import { getSegment } from "./src/db/segments";
import { chronologicalSegmentMembers } from "./src/mcp/segment-card";
import { getRelationEdgesAmongTurns, getRolledBackCiterIds } from "./src/db/memory-edges";
import { electMilestones } from "./src/shared/milestone-election";
import { buildSplitSegmentMilestoneCard, DEFAULT_TIMELINE_PAGE_SIZE } from "./src/mcp/timeline";

const ARM = process.argv[2];
if (!ARM) throw new Error("usage: bun run harness.ts <ARM>");
const OUT = `/tmp/mstudy2/${ARM}`;
mkdirSync(OUT, { recursive: true });

const PAGE_BUDGET = 2000;
const RECENT = 200;

const db = new Database(join(homedir(), ".claude-mnemo", "claude-mnemo.db"), { readonly: true });
const cutoff = resolveEraCutoff(db);

function liveRolledBack(ids: number[]): Set<number> {
  if (ids.length === 0) return new Set();
  const ph = ids.map(() => "?").join(",");
  const rows = db
    .query<{ id: number }, number[]>(`SELECT id FROM turns WHERE id IN (${ph}) AND was_rolled_back = 1`)
    .all(...ids);
  return new Set(rows.map((r) => r.id));
}

const manifest: string[] = [];
const election: string[] = [];
const seated: string[] = [];

for (const segId of [60, 70]) {
  const segment = getSegment(db, segId)!;
  const raw = chronologicalSegmentMembers(db, segment, cutoff);
  const notSkipped = raw.filter((m) => (m as any).status !== "skipped");
  const rolled = liveRolledBack(notSkipped.map((m) => m.turnId));
  const liveMembers = notSkipped.filter((m) => !rolled.has(m.turnId));

  const boundaryIndex = Math.max(0, liveMembers.length - RECENT);
  const sides = [
    { name: "old", members: liveMembers.slice(0, boundaryIndex) },
    { name: "recent", members: liveMembers.slice(boundaryIndex) },
  ];

  // ---- the REAL card, REAL budget, REAL boundary ----
  const card = buildSplitSegmentMilestoneCard(db, segId, cutoff, PAGE_BUDGET, RECENT);
  writeFileSync(`${OUT}/card-E${segId}.txt`, card);

  // parse seated addresses: a row line starts with `[T<n>]`; `[S<n>]` alone is
  // a session marker. Antecedent `↳` lines never start with `[T`.
  const seatedKeys = new Set<string>();
  let curSession = 0;
  for (const line of card.split("\n")) {
    const sm = line.match(/^\s*\[S(\d+)\]\s*$/);
    if (sm) {
      curSession = Number(sm[1]);
      continue;
    }
    const tm = line.match(/^\s*\[T(\d+)\]/);
    if (tm) seatedKeys.add(`${curSession}/${tm[1]}`);
  }

  const meta = new Map<number, any>();
  {
    const ids = liveMembers.map((m) => m.turnId);
    const ph = ids.map(() => "?").join(",");
    for (const t of db
      .query<any, number[]>(
        `SELECT id, title, type, insight, created_at_epoch AS ep, session_id AS sid, prompt_number AS pn
           FROM turns WHERE id IN (${ph})`,
      )
      .all(...ids))
      meta.set(t.id, t);
  }

  for (const side of sides) {
    if (side.members.length === 0) continue;
    const memberIds = new Set(side.members.map((m) => m.turnId));
    const laneEdges = getRelationEdgesAmongTurns(db, [...memberIds]);
    const rolledBackCiterIds = getRolledBackCiterIds(db, [...memberIds]);

    const extIds = new Set<number>();
    for (const e of laneEdges) {
      if (!memberIds.has(e.citingId)) extIds.add(e.citingId);
      if (!memberIds.has(e.citedId)) extIds.add(e.citedId);
    }
    const extTurns: any[] = [];
    if (extIds.size > 0) {
      const ph = [...extIds].map(() => "?").join(",");
      for (const r of db
        .query<any, number[]>(
          `SELECT id, session_id AS sessionId, prompt_number AS promptNumber,
                  created_at_epoch AS createdAtEpoch, was_rolled_back AS wasRolledBack
             FROM turns WHERE id IN (${ph})`,
        )
        .all(...extIds))
        extTurns.push({
          id: r.id,
          type: [],
          laneTags: [],
          order: [r.sessionId, r.promptNumber] as const,
          createdAtEpoch: r.createdAtEpoch,
          wasRolledBack: r.wasRolledBack === 1,
          eligible: false,
        });
    }
    const electionTurns = side.members.map((m) => ({
      id: m.turnId,
      type: m.type,
      laneTags: [],
      order: [m.sessionId, m.promptNumber] as const,
      createdAtEpoch: m.createdAtEpoch,
    }));
    const { candidates } = electMilestones(
      [...electionTurns, ...extTurns] as any,
      laneEdges,
      DEFAULT_TIMELINE_PAGE_SIZE,
      rolledBackCiterIds,
    );
    let rank = 0;
    for (const c of candidates) {
      if (!memberIds.has(c.id)) continue;
      rank += 1;
      const t = meta.get(c.id)!;
      const addr = `S${t.sid}/T${t.pn}`;
      const isSeated = seatedKeys.has(`${t.sid}/${t.pn}`) ? 1 : 0;
      election.push(
        [
          ARM, `E${segId}`, side.name, c.id, addr,
          new Date(t.ep * 1000).toISOString().slice(0, 10),
          c.tier, c.reason, rank, c.inDegree, c.outDegree, isSeated,
          (t.type ?? "[]").replace(/[\[\]"]/g, ""),
          (t.title ?? "").replace(/\s+/g, " "),
        ].join("\t"),
      );
      if (isSeated) {
        seated.push([ARM, `E${segId}`, side.name, c.id, addr, c.tier, c.reason, rank].join("\t"));
      }
    }

    // manifest = the candidate pool, arm-independent (eligibility never changes)
    for (const m of side.members) {
      const t = meta.get(m.turnId)!;
      manifest.push(
        [
          `E${segId}`, side.name, m.turnId, `S${t.sid}/T${t.pn}`,
          new Date(t.ep * 1000).toISOString().slice(0, 10),
          (t.type ?? "[]").replace(/[\[\]"]/g, ""),
          (t.title ?? "").replace(/\s+/g, " "),
        ].join("\t"),
      );
    }
  }
}

writeFileSync(
  `${OUT}/election.tsv`,
  ["arm\tseg\tside\tturn_id\taddr\tdate\ttier\treason\trank\tin_deg\tout_deg\tseated\ttype\ttitle", ...election].join("\n") + "\n",
);
writeFileSync(
  `${OUT}/seated.tsv`,
  ["arm\tseg\tside\tturn_id\taddr\ttier\treason\trank", ...seated].join("\n") + "\n",
);
writeFileSync(
  `${OUT}/manifest.tsv`,
  ["seg\tside\tturn_id\taddr\tdate\ttype\ttitle", ...manifest].join("\n") + "\n",
);
console.log(`arm ${ARM}: seated=${seated.length} candidates=${election.length} manifest=${manifest.length}`);
