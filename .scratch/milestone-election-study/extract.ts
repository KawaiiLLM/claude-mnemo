// Read-only feature extraction for the milestone-election study.
import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { resolveEraCutoff } from "/Users/zhaoqixuan/Projects/claude-mnemo/src/db/era";
import { chronologicalSegmentMembers } from "/Users/zhaoqixuan/Projects/claude-mnemo/src/mcp/segment-card";
import { getSegment } from "/Users/zhaoqixuan/Projects/claude-mnemo/src/db/segments";
import {
  getRelationEdgesAmongTurns,
  getRolledBackCiterIds,
} from "/Users/zhaoqixuan/Projects/claude-mnemo/src/db/memory-edges";
import { electMilestones } from "/Users/zhaoqixuan/Projects/claude-mnemo/src/shared/milestone-election";
import { buildSplitSegmentMilestoneCard } from "/Users/zhaoqixuan/Projects/claude-mnemo/src/mcp/timeline";

const db = new Database(join(homedir(), ".claude-mnemo", "claude-mnemo.db"), { readonly: true });
const cutoff = resolveEraCutoff(db);
const WORDS = ["override", "narrows", "extends", "indexes", "consume", "grounds", "verifies"];

function liveFilter(ids: number[]): Set<number> {
  if (ids.length === 0) return new Set();
  const ph = ids.map(() => "?").join(",");
  const rows = db
    .query<{ id: number }, number[]>(
      `SELECT id FROM turns WHERE id IN (${ph}) AND was_rolled_back = 1`,
    )
    .all(...ids);
  return new Set(rows.map((r) => r.id));
}

interface Row {
  [k: string]: string | number;
}

function longestExtendsThrough(
  id: number,
  outAdj: Map<number, number[]>,
  inAdj: Map<number, number[]>,
): number {
  // longest extends-path length (edges) passing through `id`:
  // depth following outgoing extends + depth following incoming extends
  const memo = new Map<string, number>();
  function depth(n: number, adj: Map<number, number[]>, dir: string, seen: Set<number>): number {
    const key = `${dir}:${n}`;
    if (memo.has(key)) return memo.get(key)!;
    if (seen.has(n)) return 0;
    seen.add(n);
    let best = 0;
    for (const m of adj.get(n) ?? []) {
      const d = 1 + depth(m, adj, dir, seen);
      if (d > best) best = d;
    }
    seen.delete(n);
    memo.set(key, best);
    return best;
  }
  return depth(id, outAdj, "o", new Set()) + depth(id, inAdj, "i", new Set());
}

const allRows: Row[] = [];

for (const segId of [60, 70]) {
  const segment = getSegment(db, segId)!;
  const raw = chronologicalSegmentMembers(db, segment, cutoff);
  const notSkipped = raw.filter((m) => m.status !== "skipped");
  const rolled = liveFilter(notSkipped.map((m) => m.turnId));
  const liveMembers = notSkipped.filter((m) => !rolled.has(m.turnId));

  // --- replicate the split card's two elections ---
  const RECENT = 200;
  const boundaryIndex = Math.max(0, liveMembers.length - RECENT);
  const sides: Array<{ name: string; members: typeof liveMembers }> = [
    { name: "old", members: liveMembers.slice(0, boundaryIndex) },
    { name: "recent", members: liveMembers.slice(boundaryIndex) },
  ];

  // --- actual elected set: parse the real card render ---
  const card = buildSplitSegmentMilestoneCard(db, segId, cutoff, 2000, RECENT);
  const electedKeys = new Set<string>();
  let curSession = 0;
  for (const line of card.split("\n")) {
    const sm = line.match(/^\s*\[S(\d+)\]\s*$/);
    if (sm) {
      curSession = Number(sm[1]);
      continue;
    }
    const tm = line.match(/^\s*\[T(\d+)\]/);
    if (tm) electedKeys.add(`${curSession}/${tm[1]}`);
  }

  for (const side of sides) {
    if (side.members.length === 0) continue;
    const memberIds = new Set(side.members.map((m) => m.turnId));
    const laneEdges = getRelationEdgesAmongTurns(db, [...memberIds]);
    const rolledBackCiterIds = getRolledBackCiterIds(db, [...memberIds]);
    // external nodes, eligible:false
    const extIds = new Set<number>();
    for (const e of laneEdges) {
      if (!memberIds.has(e.citingId)) extIds.add(e.citingId);
      if (!memberIds.has(e.citedId)) extIds.add(e.citedId);
    }
    const extTurns: any[] = [];
    if (extIds.size > 0) {
      const ph = [...extIds].map(() => "?").join(",");
      const rows = db
        .query<any, number[]>(
          `SELECT id, session_id AS sessionId, prompt_number AS promptNumber,
                  created_at_epoch AS createdAtEpoch, was_rolled_back AS wasRolledBack
             FROM turns WHERE id IN (${ph})`,
        )
        .all(...extIds);
      for (const r of rows)
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
      50, // DEFAULT_TIMELINE_PAGE_SIZE
      rolledBackCiterIds,
    );
    const rankOf = new Map<number, number>();
    const candOf = new Map<number, any>();
    let r = 0;
    for (const c of candidates) {
      if (!memberIds.has(c.id)) continue;
      r += 1;
      rankOf.set(c.id, r);
      candOf.set(c.id, c);
    }

    // per-relation degrees over the SAME edge set the election saw
    const inDeg = new Map<number, Map<string, number>>();
    const outDeg = new Map<number, Map<string, number>>();
    const bump = (m: Map<number, Map<string, number>>, id: number, w: string) => {
      let b = m.get(id);
      if (!b) {
        b = new Map();
        m.set(id, b);
      }
      b.set(w, (b.get(w) ?? 0) + 1);
    };
    const extOut = new Map<number, number[]>();
    const extIn = new Map<number, number[]>();
    for (const e of laneEdges) {
      bump(inDeg, e.citedId, e.relation);
      bump(outDeg, e.citingId, e.relation);
      if (e.relation === "extends") {
        (extOut.get(e.citingId) ?? extOut.set(e.citingId, []).get(e.citingId)!).push(e.citedId);
        (extIn.get(e.citedId) ?? extIn.set(e.citedId, []).get(e.citedId)!).push(e.citingId);
      }
    }
    // tier-1/2 predicates
    const declaresIndex = new Set<number>();
    const unsettledIndex = new Set<number>();
    for (const e of laneEdges) {
      if (e.relation === "indexes") {
        declaresIndex.add(e.citingId);
        if (e.tailTag === "" && e.headTag === "") unsettledIndex.add(e.citingId);
      }
    }

    // full turn text
    const ph = side.members.map(() => "?").join(",");
    const texts = new Map<number, any>();
    for (const t of db
      .query<any, number[]>(
        `SELECT id, title, content, insight, type, tags, status, created_at_epoch AS ep,
                session_id AS sid, prompt_number AS pn
           FROM turns WHERE id IN (${ph})`,
      )
      .all(...side.members.map((m) => m.turnId)))
      texts.set(t.id, t);

    for (const m of side.members) {
      const t = texts.get(m.turnId);
      const c = candOf.get(m.turnId);
      const ind = inDeg.get(m.turnId) ?? new Map();
      const outd = outDeg.get(m.turnId) ?? new Map();
      const row: Row = {
        seg: `E${segId}`,
        side: side.name,
        turn_id: m.turnId,
        addr: `S${t.sid}/T${t.pn}`,
        date: new Date(t.ep * 1000).toISOString().slice(0, 10),
        elected: electedKeys.has(`${t.sid}/${t.pn}`) ? 1 : 0,
        tier: c?.tier ?? 5,
        reason: c?.reason ?? "other",
        rank: rankOf.get(m.turnId) ?? 0,
        in_pos: c?.inDegree ?? 0,
        out_all: c?.outDegree ?? 0,
        type: (t.type ?? "[]").replace(/[\[\]"]/g, ""),
        tags: (t.tags ?? "[]").replace(/[\[\]"]/g, ""),
        title_len: (t.title ?? "").length,
        content_len: (t.content ?? "").length,
        insight_len: (t.insight ?? "").length,
        has_insight: t.insight ? 1 : 0,
        declares_index: declaresIndex.has(m.turnId) ? 1 : 0,
        unsettled_index: unsettledIndex.has(m.turnId) ? 1 : 0,
        extends_depth: longestExtendsThrough(m.turnId, extOut, extIn),
        title: (t.title ?? "").replace(/\s+/g, " "),
      };
      for (const w of WORDS) {
        row[`in_${w}`] = ind.get(w) ?? 0;
        row[`out_${w}`] = outd.get(w) ?? 0;
      }
      allRows.push(row);
    }
  }
}

const cols = Object.keys(allRows[0]);
const tsv = [
  cols.join("\t"),
  ...allRows.map((r) => cols.map((c) => String(r[c] ?? "").replace(/\t/g, " ")).join("\t")),
].join("\n");
writeFileSync("/tmp/mstudy/all-features.tsv", tsv);
console.log("rows:", allRows.length, "cols:", cols.length);
const e60 = allRows.filter((r) => r.seg === "E60");
const e70 = allRows.filter((r) => r.seg === "E70");
console.log("E60 live:", e60.length, "elected:", e60.filter((r) => r.elected === 1).length);
console.log("E70 live:", e70.length, "elected:", e70.filter((r) => r.elected === 1).length);
