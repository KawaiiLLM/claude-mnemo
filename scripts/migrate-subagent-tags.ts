/**
 * D17 — One-time tag migration: rollback:* → subagent:*
 *
 * Idempotent: safe to run multiple times.
 *
 * Usage:
 *   bun run scripts/migrate-subagent-tags.ts
 */

import { createDatabase } from "../src/db/database";

const db = createDatabase();

const result = db.run(`
  UPDATE turns
  SET tags = replace(replace(tags, '"rollback:pending"', '"subagent:pending"'),
                     '"rollback:notified"', '"subagent:notified"')
  WHERE tags LIKE '%rollback:%'
`);

console.log(`Migrated ${result.changes} turn(s) with rollback:* tags → subagent:*`);

db.close();
