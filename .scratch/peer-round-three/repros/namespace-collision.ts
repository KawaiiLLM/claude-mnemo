import { createDatabase } from "/Users/zhaoqixuan/Projects/claude-mnemo/src/db/database";
import { initializeSchema } from "/Users/zhaoqixuan/Projects/claude-mnemo/src/db/schema";
import { createSegment } from "/Users/zhaoqixuan/Projects/claude-mnemo/src/db/segments";
import { insertLane } from "/Users/zhaoqixuan/Projects/claude-mnemo/src/db/lanes";

const db = createDatabase(":memory:");
initializeSchema(db);
const NOW = Math.floor(Date.now() / 1000);

const e1 = createSegment(db, { title: "container one", tags: ["e1tag"], nowEpoch: NOW });
insertLane(db, e1.id, "alpha", NOW);
console.log(`E${e1.id} task tag = e1tag, lane 'alpha' declared inside it`);

// (a) task minted with a word an existing LANE owns
try {
  const e2 = createSegment(db, { title: "container two", tags: ["alpha"], nowEpoch: NOW });
  console.log(`>>> (a) REPRODUCED: createSegment accepted 'alpha' -> E${e2.id}. 'alpha' now names E${e1.id}'s lane AND E${e2.id}'s task.`);
} catch (err) {
  console.log("    (a) refused —", (err as Error).constructor.name);
}

// (b) the mirror direction, for contrast: lane minted with a word a TASK owns
try {
  insertLane(db, e1.id, "e1tag", NOW);
  console.log(">>> (b) lane 'e1tag' also accepted — no guard either way");
} catch (err) {
  console.log("    (b) refused —", (err as Error).constructor.name, "(insertLane DOES guard)");
}
