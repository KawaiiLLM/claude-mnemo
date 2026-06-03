import type { Database } from "bun:sqlite";

export type Ownership = "foreign" | "child" | "unknown";

export interface OwnerInfo {
  sessionId: number;
  turnId: number;
  promptNumber: number;
}

export interface PromptOwnership {
  ownership: Ownership;
  owners: OwnerInfo[];
}

export function classifyPromptOwnership(
  db: Database,
  childSessionId: number,
  promptIds: string[],
): Map<string, PromptOwnership> {
  const result = new Map<string, PromptOwnership>();
  for (const p of promptIds) result.set(p, { ownership: "unknown", owners: [] });
  if (promptIds.length === 0) return result;

  const placeholders = promptIds.map(() => "?").join(",");
  const rows = db
    .query<
      { content_prompt_id: string; session_id: number; turn_id: number; prompt_number: number },
      string[]
    >(
      `SELECT content_prompt_id, session_id, id AS turn_id, prompt_number
       FROM turns
       WHERE content_prompt_id IN (${placeholders}) AND content_prompt_id IS NOT NULL`,
    )
    .all(...promptIds);

  for (const row of rows) {
    result.get(row.content_prompt_id)!.owners.push({
      sessionId: row.session_id,
      turnId: row.turn_id,
      promptNumber: row.prompt_number,
    });
  }

  for (const [, e] of result) {
    if (e.owners.length === 0) {
      e.ownership = "unknown";
    } else if (e.owners.some((o) => o.sessionId !== childSessionId)) {
      e.ownership = "foreign";
    } else {
      e.ownership = "child";
    }
  }

  return result;
}
