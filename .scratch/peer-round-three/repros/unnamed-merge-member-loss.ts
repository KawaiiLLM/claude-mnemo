import { createDatabase } from "/Users/zhaoqixuan/Projects/claude-mnemo/src/db/database";
import { initializeSchema } from "/Users/zhaoqixuan/Projects/claude-mnemo/src/db/schema";
import { createSegment, addSegmentMembers, mergeSegments, getSegment } from "/Users/zhaoqixuan/Projects/claude-mnemo/src/db/segments";
import { upsertSession } from "/Users/zhaoqixuan/Projects/claude-mnemo/src/db/sessions";

const db = createDatabase(":memory:");
initializeSchema(db);
const NOW = Math.floor(Date.now() / 1000);
const sid = upsertSession(db, { contentSessionId: "repro", project: "/p", title: null, insight: null, createdAtEpoch: NOW, updatedAtEpoch: NOW, completedAtEpoch: null } as any).id;
const tid = db.query<{ id: number }, [number, number, string, number, number, string | null]>(
  `INSERT INTO turns (session_id, prompt_number, status, created_at_epoch, was_rolled_back, tags)
   VALUES (?, ?, ?, ?, ?, ?) RETURNING id`).get(sid, 1, "active", NOW, 0, JSON.stringify(["fromtag"]))!.id;

const from = createSegment(db, { title: "source", tags: ["fromtag"], nowEpoch: NOW });
const into = createSegment(db, { title: "destination with NO tag", tags: [], nowEpoch: NOW });
addSegmentMembers(db, from.id, [tid], NOW);
console.log(`from=E${from.id} tags=${JSON.stringify(from.tags)} | into=E${into.id} tags=${JSON.stringify(into.tags)}`);
console.log("before:", JSON.stringify(db.query("select segment_id, turn_id from segment_members").all()));

try {
  const out: any = mergeSegments(db, from.id, into.id, NOW, {});
  console.log("receipt =", JSON.stringify(out));
  const after = db.query("select segment_id, turn_id from segment_members").all();
  console.log("after :", JSON.stringify(after));
  console.log(`source E${from.id} exists:`, getSegment(db, from.id) !== null);
  if (out.membersMoved > 0 && after.length === 0) {
    console.log(">>> REPRODUCED: receipt says", out.membersMoved, "member(s) moved; ZERO membership rows survive, and the source is gone.");
  }
} catch (err) {
  console.log("merge refused —", (err as Error).constructor.name + ":", (err as Error).message.slice(0, 160));
}
