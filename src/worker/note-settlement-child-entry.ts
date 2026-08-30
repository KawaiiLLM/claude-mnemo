import type { Database } from "bun:sqlite";

import { createDatabase } from "../db/database";
import {
  decodeSettlementChildRequest,
  formatSettlementChildEnvelope,
  SETTLEMENT_CHILD_SCRIPT_NAME,
  type SettlementChildEnvelope,
  type SettlementChildPayload,
} from "./note-settlement-child";
import {
  createUnifiedNoteSettlementSdkQuery,
  type NoteSettlementUnifiedQuery,
} from "./note-settlement-sdk-query";

/**
 * THE CHILD SIDE of claim-monitor-repair ticket 02's process boundary — the
 * entry point of one settlement run's own process.
 *
 * Everything the worker must not host lives on this side of the pipe: the
 * model client, its transport, the settlement MCP server and the Stop hook,
 * all of it assembled by `createUnifiedNoteSettlementSdkQuery` exactly as it
 * was when it ran in the worker. What changed is only WHERE it runs, and
 * therefore what its failures can reach — an unobserved rejection out of the
 * vendored client's control-request channel now ends a process that contains
 * one run and nothing else.
 *
 * IT INSTALLS NO PROCESS-LEVEL REJECTION HANDLER, deliberately. Dying on
 * debris is the contract: the parent reads the exit code and the stderr tail
 * and fails exactly this job. A handler here would put back the very
 * attribution problem the boundary exists to remove.
 *
 * ITS OWN DATABASE HANDLE. The child opens the file itself — SQLite here is
 * already multi-process (hooks write while the worker does), so this adds a
 * writer to a set that already exists rather than a new kind of concurrency.
 * The busy timeout is named below for the same reason the hook path names
 * its own: a settlement run is a long, patient writer, not a latency-bound
 * hook, so it waits out a lock rather than failing fast on one.
 */
export const SETTLEMENT_CHILD_DB_BUSY_TIMEOUT_MS = 5_000;

export interface SettlementChildDeps {
  openDatabase?: (databasePath: string) => Database;
  createQuery?: (
    db: Database,
    payload: SettlementChildPayload,
  ) => NoteSettlementUnifiedQuery;
  readStdin?: () => Promise<string>;
  writeStdout?: (text: string) => void;
  exit?: (code: number) => void;
}

function defaultOpenDatabase(databasePath: string): Database {
  return createDatabase(databasePath, {
    busyTimeoutMs: SETTLEMENT_CHILD_DB_BUSY_TIMEOUT_MS,
  });
}

function defaultCreateQuery(
  db: Database,
  payload: SettlementChildPayload,
): NoteSettlementUnifiedQuery {
  return createUnifiedNoteSettlementSdkQuery({
    db,
    dataRoot: payload.dataRoot,
    ...(payload.defaultProject === undefined
      ? {}
      : { defaultProject: payload.defaultProject }),
  });
}

/**
 * One run, one envelope. A thrown query becomes `ok: false` with its own
 * message rather than an exit code, because a failure the run REACHED is a
 * diagnosis the parent can compose with; only a failure that kills the
 * process before this point is left to the exit code and the stderr tail.
 */
export async function runSettlementChild(
  payload: SettlementChildPayload,
  deps: SettlementChildDeps = {},
): Promise<SettlementChildEnvelope> {
  const openDatabase = deps.openDatabase ?? defaultOpenDatabase;
  const createQuery = deps.createQuery ?? defaultCreateQuery;

  let db: Database;
  try {
    db = openDatabase(payload.databasePath);
  } catch (error) {
    return {
      ok: false,
      message: `note settlement child could not open ${payload.databasePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  try {
    const runQuery = createQuery(db, payload);
    const result = await runQuery(decodeSettlementChildRequest(payload.request));
    return { ok: true, result };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    try {
      db.close(false);
    } catch {
      // A close that fails changes nothing about the envelope already decided.
    }
  }
}

function readAllStdin(): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    let text = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      text += chunk;
    });
    process.stdin.on("end", () => resolvePromise(text));
    process.stdin.on("error", rejectPromise);
  });
}

/**
 * The process's whole life: read one JSON payload off stdin, run it, print
 * one marked envelope line, leave. The explicit exit is not optional — a
 * finished SDK session can leave handles the event loop would otherwise wait
 * on forever, and a child that will not exit is exactly the wedge the parent
 * would then have to `SIGKILL`.
 */
export async function main(deps: SettlementChildDeps = {}): Promise<void> {
  const readStdin = deps.readStdin ?? readAllStdin;
  const writeStdout =
    deps.writeStdout ?? ((text: string) => void process.stdout.write(text));
  const exit = deps.exit ?? ((code: number) => process.exit(code));

  let envelope: SettlementChildEnvelope;
  try {
    const raw = await readStdin();
    const payload = JSON.parse(raw) as SettlementChildPayload;
    envelope = await runSettlementChild(payload, deps);
  } catch (error) {
    envelope = {
      ok: false,
      message: `note settlement child could not read its request: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  writeStdout(formatSettlementChildEnvelope(envelope));
  exit(0);
}

/**
 * Run only when this module IS the program — the shipped bundle, or the
 * source file under `bun run`. A test that imports it for
 * `runSettlementChild` must not start reading the test runner's stdin.
 */
const invokedDirectly = ((): boolean => {
  const entry = process.argv[1] ?? "";
  return (
    entry.endsWith(SETTLEMENT_CHILD_SCRIPT_NAME) ||
    entry.endsWith("note-settlement-child-entry.ts")
  );
})();

if (invokedDirectly) {
  void main();
}
