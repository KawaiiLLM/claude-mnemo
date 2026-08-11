import type { Database } from "bun:sqlite";

/**
 * Process → mnemo-session identity map (spec D1).
 *
 * The id mnemo keys a session on is the hook payload's `session_id`, which no
 * MCP process ever receives. This table is the only place a running process's
 * own environment is joined to it, so the MCP entry point can answer "which
 * mnemo session is my caller" without guessing.
 *
 * What makes that join delicate is that an environment variable is a SNAPSHOT
 * taken when a child is spawned, not a live view: Claude Code hands each child
 * a copy of `process.env` as it stood at that moment and never pushes a later
 * value into one. A per-invocation child (a hook, spawned fresh every event)
 * therefore holds the current values; a long-lived child (the MCP server,
 * spawned once at startup) holds whatever was current when it started. Measured
 * on a resumed session that is a boot id the conversation has already moved on
 * from, while the hook holds the resumed conversation's id — the two disagree
 * for the whole life of the session. Any variable whose value can move after
 * startup is therefore unusable as the join key on its own, which is what
 * `deriveProcessIdentityKeys` exists to handle.
 */

/**
 * The environment variables that can name the Claude Code process a caller
 * belongs to, most reliable first. One list, called by both halves of the join
 * — the hook that writes this map and the MCP entry point that reads it —
 * because the previous arrangement spelled a variable name out on each side
 * with nothing structural keeping the two the same, and they were measured
 * holding different values.
 *
 * The messaging socket leads: it names the OWNING Claude Code process rather
 * than the conversation, it is exported before any hook can spawn, and it does
 * not move when a conversation is resumed, so both processes hold the identical
 * string. It is feature-gated (and skipped entirely in bare mode), which is why
 * the session id stays behind it as a fallback rather than being replaced —
 * where the socket is absent the behaviour is exactly the old one, matching on
 * a fresh session and missing on a resumed one.
 *
 * Each key carries its source as a prefix, so a socket path and a session id
 * can never collide in the map's single primary-key column.
 */
const IDENTITY_KEY_SOURCES = [
  { namespace: "socket", envVar: "CLAUDE_CODE_MESSAGING_SOCKET" },
  { namespace: "session", envVar: "CLAUDE_CODE_SESSION_ID" },
] as const;

export function deriveProcessIdentityKeys(env: NodeJS.ProcessEnv): string[] {
  const keys: string[] = [];

  for (const source of IDENTITY_KEY_SOURCES) {
    const value = env[source.envVar]?.trim();
    if (value) {
      keys.push(`${source.namespace}:${value}`);
    }
  }

  return keys;
}

/**
 * Record (or refresh) which mnemo session an identity key currently belongs to.
 * Called once per UserPromptSubmit, for every key the hook's environment yields.
 *
 * Rewritten every prompt, and with no expiry column: the socket path embeds the
 * owning process's pid, so a dead session's row could in principle be matched by
 * a later process that inherits that pid. Write ordering settles it instead —
 * `note` only happens inside a turn, and this write runs at UserPromptSubmit
 * before any of that turn's tool calls, so the new session already owns the key
 * by the time anything in it resolves an identity.
 */
export function upsertProcessSessionMap(
  db: Database,
  identityKey: string,
  sessionId: number,
  nowEpoch: number,
): void {
  db.query<unknown, [string, number, number]>(
    `INSERT INTO process_session_map (
       process_session_id, session_id, updated_at_epoch
     ) VALUES (?, ?, ?)
     ON CONFLICT(process_session_id) DO UPDATE SET
       session_id = excluded.session_id,
       updated_at_epoch = excluded.updated_at_epoch`,
  ).run(identityKey, sessionId, nowEpoch);
}

/**
 * The mnemo session an identity key was last mapped to, or null if this key has
 * never been recorded (its session has not lived through a UserPromptSubmit
 * yet, or the key comes from a variable the writing side did not hold). A miss
 * is not evidence of anything — every reader of this function treats it as
 * "identity unknown" and falls through to whatever admits on unknown identity.
 */
export function getMnemoSessionIdForProcessSession(
  db: Database,
  identityKey: string,
): number | null {
  return (
    db
      .query<{ sessionId: number }, [string]>(
        `SELECT session_id AS sessionId FROM process_session_map
         WHERE process_session_id = ?`,
      )
      .get(identityKey)?.sessionId ?? null
  );
}
