import { Database } from "bun:sqlite";

import { loadLaneCheckScope, type LaneCheckScope } from "../db/lane-checker-load";
import {
  getSegment,
  listSegmentsByActivity,
  type SegmentRecord,
  type SegmentStatus,
} from "../db/segments";
import { getSession, type SessionRecord } from "../db/sessions";
import { checkLanes, type LaneCheckerResult } from "../shared/lane-checker";
import type { LaneEdgeInput, LaneTurnInput } from "../shared/lane-interpretation";

/**
 * The console's read-only query capability (memory-console spec, "Read-only,
 * structurally"; ticket 02). Grown by ticket 03 to the full surface
 * `/api/console/*` needs — sessions paging, the segment roster, a segment's
 * card + members, and the ONE lane-check projection a graph request runs.
 *
 * `ConsoleReader` is the ONLY thing a console route handler ever receives —
 * never the raw `Database`. Every method that needs `loadLaneCheckScope` or
 * `checkLanes` (both of which need a live `Database`) lives HERE, not in
 * `console-api.ts` — `runLaneCheck` below is the "handlers receive a narrow
 * capability, never the raw Database" boundary made concrete for the
 * projection chain: `console-api.ts` imports neither `bun:sqlite` nor
 * `db/lane-checker-load.ts` at all (pinned by this module's own source guard
 * test and a matching one on `console-api.ts`).
 *
 * "Zero-own-SQL where an existing reader exists" (ticket 03's own framing):
 * `findSession`/`findSegment`/`listAllSegmentCards` delegate to
 * `db/sessions.ts`/`db/segments.ts`. Where no existing reader covers the
 * shape a route needs (session paging by cursor + per-session turn count,
 * segment roster member counts, a segment's member turn addresses, a batch
 * turn-display-fields load for the graph payload's excerpts), this module
 * owns new SQL — every statement below is a `SELECT`, nothing else.
 *
 * Two independent guarantees back the "read-only, structurally" claim (ticket
 * 02, unchanged by this growth):
 *   - the connection this module is handed is opened via
 *     `openConsoleReaderDatabase`, `bun:sqlite`'s own `{ readonly: true,
 *     create: false }` — the VFS itself refuses a write, so a bug here
 *     cannot silently succeed at one;
 *   - this module's own source is pinned free of DML (`INSERT`/`UPDATE`/
 *     `DELETE`/`REPLACE`), `db.exec`, and any import from the queue or
 *     settlement modules (`tests/worker/console-reader.test.ts`'s source
 *     guard) — so even a method added here later cannot reach for a write
 *     path or the mechanisms that drive one.
 *
 * Scope statement (spec): this is a guarantee about the CONSOLE REQUEST PATH
 * against the persistent memory DB. It says nothing about the worker process
 * at large, which keeps writing through its own (separate) connection.
 */

export interface ConsoleSessionSummary {
  id: number;
  title: string | null;
  project: string;
  turnCount: number;
  date: string;
}

export interface ConsoleSessionsPage {
  sessions: ConsoleSessionSummary[];
  /** `null` when this page is the last one — the route layer omits `nextCursor` entirely on that response, matching the contract's `nextCursor?`. */
  nextCursor: string | null;
}

export interface ConsoleSegmentCard {
  id: number;
  title: string;
  status: SegmentStatus;
  tags: string[];
  type: string[];
  memberCount: number;
}

export interface ConsoleSegmentCardDetail {
  segment: SegmentRecord;
  /** "S<session>/T<prompt>" addresses, member order (`getSegmentMemberTurnIds`'s own convention: oldest member first). */
  memberAddresses: string[];
}

export interface ConsoleTurnDisplayFields {
  sessionId: number;
  promptNumber: number;
  title: string | null;
  userPrompt: string | null;
  content: string | null;
}

export interface ConsoleLaneCheckRun {
  result: LaneCheckerResult;
  turns: readonly LaneTurnInput[];
  edges: readonly LaneEdgeInput[];
  /** ISO timestamp captured at the START of the one read transaction this run executes in (spec "One projection": "meta.asOf = one timestamp taken inside that read"). */
  asOf: string;
}

export interface ConsoleReader {
  listSessionsPage(options: {
    cursor: { epoch: number; id: number } | null;
    limit: number;
  }): ConsoleSessionsPage;
  listAllSegmentCards(): ConsoleSegmentCard[];
  findSession(sessionId: number): SessionRecord | null;
  /** `null` when the session has no turns at all (never called on an unknown session — callers check `findSession` first). */
  getSessionMaxPromptNumber(sessionId: number): number | null;
  findSegment(segmentId: number): SegmentRecord | null;
  getSegmentCardDetail(segmentId: number): ConsoleSegmentCardDetail | null;
  /** `loadLaneCheckScope` -> `checkLanes`, exactly once, inside one read transaction (spec "One projection"). */
  runLaneCheck(scope: LaneCheckScope): ConsoleLaneCheckRun;
  /** Batch turn metadata for the graph payload's title/excerpt fields — the exact shape ticket 01's own measurement script queried (`/tmp/console-measure.ts`'s `loadTurnMeta`), widened with `content` for the content-excerpt field this ticket adds. */
  loadTurnDisplayFields(
    ids: readonly number[],
  ): Map<number, ConsoleTurnDisplayFields>;
}

export type OpenConsoleReaderDatabase = (path: string) => Database;

/**
 * The production opener. `readonly: true` is `bun:sqlite`'s own read-only
 * open mode (no write operations reach the VFS); `create: false` is stated
 * explicitly even though `readonly: true` alone already refuses to create a
 * missing file — a missing console database is a real error (the worker's
 * main connection did not run first, or the path is wrong), never a reason
 * to silently create an empty one that would make every query look like
 * "no data" instead of surfacing the actual problem.
 */
export const openConsoleReaderDatabase: OpenConsoleReaderDatabase = (path) =>
  new Database(path, { readonly: true, create: false });

/** `${epoch}:${id}` — a plain, non-obfuscated pair. "Opaque" (spec) means callers must not construct one themselves, not that the bytes must hide anything: the console is a same-OS-user loopback surface where the epoch/id pair carries no information a local reader could not already get from `sessions`. */
export function encodeSessionsCursor(epoch: number, id: number): string {
  return `${epoch}:${id}`;
}

/**
 * `null` on anything that is not exactly `<digits>:<digits>` — the route
 * layer turns that into a 400. `String.match`, not `RegExp.exec` — this
 * module's own source guard bans any `.exec(` call (its intent is "no
 * `db.exec()`", the DML escape hatch), and a plain `RegExp.exec` call would
 * otherwise be an indistinguishable false positive against that same token.
 */
export function parseSessionsCursor(
  raw: string,
): { epoch: number; id: number } | null {
  const match = raw.match(/^(\d+):(\d+)$/);
  if (!match) {
    return null;
  }
  const epoch = Number(match[1]);
  const id = Number(match[2]);
  // A digit run beyond Number.MAX_SAFE_INTEGER (or long enough to parse to
  // Infinity) cannot round-trip through the JS Number this value is compared
  // and bound as without silent precision loss — treated as malformed
  // (peer finding #13), same as any other shape this regex would reject,
  // rather than handed to SQLite as a value that no longer matches the
  // digits the client actually sent.
  if (!Number.isSafeInteger(epoch) || !Number.isSafeInteger(id)) {
    return null;
  }
  return { epoch, id };
}

export interface CreateConsoleReaderOptions {
  /** Wall-clock seconds, matching every other epoch column in this schema. Defaults to the real clock; a test overrides for a deterministic `asOf`. */
  now?: () => number;
}

interface SessionPageRow {
  id: number;
  title: string | null;
  project: string;
  createdAtEpoch: number;
  turnCount: number;
}

interface SegmentMemberCountRow {
  segmentId: number;
  memberCount: number;
}

interface SessionMaxPromptRow {
  maxPromptNumber: number | null;
}

interface SegmentMemberAddressRow {
  sessionId: number;
  promptNumber: number;
}

interface TurnDisplayRow {
  id: number;
  sessionId: number;
  promptNumber: number;
  title: string | null;
  userPrompt: string | null;
  content: string | null;
}

/** Wrap an already-open (readonly) connection as the narrow console capability. */
export function createConsoleReader(
  db: Database,
  options: CreateConsoleReaderOptions = {},
): ConsoleReader {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));

  return {
    listSessionsPage({ cursor, limit }) {
      const rows = db
        .query<
          SessionPageRow,
          [number | null, number | null, number | null, number | null, number]
        >(
          `SELECT
             s.id AS id,
             s.title AS title,
             s.project AS project,
             s.created_at_epoch AS createdAtEpoch,
             (SELECT COUNT(*) FROM turns t WHERE t.session_id = s.id AND t.status != 'undone') AS turnCount
           FROM sessions s
           WHERE (?1 IS NULL)
              OR (s.created_at_epoch < ?2)
              OR (s.created_at_epoch = ?3 AND s.id < ?4)
           ORDER BY s.created_at_epoch DESC, s.id DESC
           LIMIT ?5`,
        )
        .all(
          cursor?.epoch ?? null,
          cursor?.epoch ?? null,
          cursor?.epoch ?? null,
          cursor?.id ?? null,
          limit + 1,
        );

      const hasMore = rows.length > limit;
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];

      return {
        sessions: page.map((row) => ({
          id: row.id,
          title: row.title,
          project: row.project,
          turnCount: row.turnCount,
          date: new Date(row.createdAtEpoch * 1000).toISOString(),
        })),
        nextCursor:
          hasMore && last
            ? encodeSessionsCursor(last.createdAtEpoch, last.id)
            : null,
      };
    },

    listAllSegmentCards() {
      // "Roster-sized, unpaginated" (spec): every segment, whatever its
      // status — `listSegmentsByActivity` (db/segments.ts, existing reader,
      // zero new SQL for the segment fields themselves) already returns ALL
      // statuses. `Number.MAX_SAFE_INTEGER` as `LIMIT` is SQLite's own
      // "no limit" idiom — a second COUNT(*) round-trip just to size the
      // real LIMIT would cost a query for no behavioral difference.
      const segments = listSegmentsByActivity(db, Number.MAX_SAFE_INTEGER);
      const counts = db
        .query<SegmentMemberCountRow, []>(
          `SELECT segment_id AS segmentId, COUNT(*) AS memberCount
           FROM segment_members GROUP BY segment_id`,
        )
        .all();
      const memberCountBySegmentId = new Map(
        counts.map((row) => [row.segmentId, row.memberCount]),
      );
      return segments.map((segment) => ({
        id: segment.id,
        title: segment.title,
        status: segment.status,
        tags: segment.tags,
        type: segment.type,
        memberCount: memberCountBySegmentId.get(segment.id) ?? 0,
      }));
    },

    findSession(sessionId) {
      return getSession(db, sessionId);
    },

    getSessionMaxPromptNumber(sessionId) {
      const row = db
        .query<SessionMaxPromptRow, [number]>(
          `SELECT MAX(prompt_number) AS maxPromptNumber FROM turns WHERE session_id = ?`,
        )
        .get(sessionId);
      return row?.maxPromptNumber ?? null;
    },

    findSegment(segmentId) {
      return getSegment(db, segmentId);
    },

    getSegmentCardDetail(segmentId) {
      const segment = getSegment(db, segmentId);
      if (!segment) {
        return null;
      }
      // Same join/order convention as `db/segments.ts`'s own
      // `getSegmentMemberTurnIds` (oldest member first) — widened here to
      // also pull `session_id`/`prompt_number` in the same round trip, since
      // the card route needs the "S<session>/T<prompt>" address form, not
      // bare turn ids.
      const rows = db
        .query<SegmentMemberAddressRow, [number]>(
          `SELECT t.session_id AS sessionId, t.prompt_number AS promptNumber
           FROM segment_members sm
           JOIN turns t ON t.id = sm.turn_id
           WHERE sm.segment_id = ?
           ORDER BY t.created_at_epoch ASC, t.id ASC`,
        )
        .all(segmentId);
      return {
        segment,
        memberAddresses: rows.map(
          (row) => `S${row.sessionId}/T${row.promptNumber}`,
        ),
      };
    },

    runLaneCheck(scope) {
      // ONE read transaction (spec "One projection"): `loadLaneCheckScope`
      // issues many sequential SELECTs (seed/discover/widen/supplementary —
      // see `db/lane-checker-load.ts`'s own module header), and this is a
      // SEPARATE connection from the worker's live write handle, so without
      // an explicit transaction a concurrent write between two of those
      // SELECTs could hand `checkLanes` a torn snapshot. `db.transaction`
      // wraps the callback in `BEGIN`/`COMMIT`, legal (and just a read-lock,
      // not a write) on a `readonly: true` connection in WAL mode.
      const run = db.transaction(() => {
        const asOf = new Date(now() * 1000).toISOString();
        const projection = loadLaneCheckScope(db, scope);
        const result = checkLanes(projection.turns, projection.edges);
        return {
          result,
          turns: projection.turns,
          edges: projection.edges,
          asOf,
        };
      });
      return run();
    },

    loadTurnDisplayFields(ids) {
      const uniqueIds = [...new Set(ids)];
      if (uniqueIds.length === 0) {
        return new Map();
      }
      const placeholders = uniqueIds.map(() => "?").join(",");
      const rows = db
        .query<TurnDisplayRow, number[]>(
          `SELECT id, session_id AS sessionId, prompt_number AS promptNumber,
                  title, user_prompt AS userPrompt, content
           FROM turns WHERE id IN (${placeholders})`,
        )
        .all(...uniqueIds);
      return new Map(
        rows.map((row) => [
          row.id,
          {
            sessionId: row.sessionId,
            promptNumber: row.promptNumber,
            title: row.title,
            userPrompt: row.userPrompt,
            content: row.content,
          },
        ]),
      );
    },
  };
}

export interface ConsoleReaderResolutionDeps {
  /** Test injection — when present, used directly and no connection is ever opened. The ONLY seam that works when the worker's main db is `:memory:` (two separate `:memory:` connections share no state — ticket 02's own finding). */
  consoleReaderImpl?: ConsoleReader;
  openConsoleReaderDatabaseImpl?: OpenConsoleReaderDatabase;
  /** The real file path to open the console's own connection against. `main()` supplies this from its already-open primary connection's own `db.filename`, never a fresh independent path resolution. */
  consoleDatabasePathImpl?: string;
}

/**
 * Boot-wiring resolution (ticket 03, resolving ticket 02's flagged
 * question): the console's readonly connection is opened LAZILY, on the
 * first console request, never eagerly at `main()` boot. There is no
 * consumer before a route fires, and every worker boots whether or not this
 * process ever serves a console request — an eager open would be an
 * untested, possibly-unused second handle for every ordinary hook-triggered
 * worker start, exactly ticket 02's own objection to wiring it in
 * unconditionally.
 *
 * The resolution result (success or failure) is CACHED after the first
 * attempt, for the life of the handler closure this is created inside — a
 * transient open failure becomes a standing failure (the route layer turns
 * it into a 503) until the worker restarts, rather than an open-and-fail
 * retried on every single console request. `main()`'s own connection is
 * already known-good by the time the server starts listening
 * (`initializeDatabase` has already run against the same file), so in
 * practice this only ever fails on a genuinely wrong/missing path.
 */
export function createLazyConsoleReaderResolver(
  deps: ConsoleReaderResolutionDeps,
): () => ConsoleReader {
  let cached: { reader: ConsoleReader } | { error: Error } | undefined;

  return () => {
    if (deps.consoleReaderImpl) {
      return deps.consoleReaderImpl;
    }
    if (!cached) {
      try {
        if (!deps.consoleDatabasePathImpl) {
          throw new Error("console database path is not configured");
        }
        const open =
          deps.openConsoleReaderDatabaseImpl ?? openConsoleReaderDatabase;
        cached = { reader: createConsoleReader(open(deps.consoleDatabasePathImpl)) };
      } catch (error) {
        cached = {
          error: error instanceof Error ? error : new Error(String(error)),
        };
      }
    }
    if ("error" in cached) {
      throw cached.error;
    }
    return cached.reader;
  };
}
