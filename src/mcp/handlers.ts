import type { Database } from "bun:sqlite";

import type { MemoryFilterInput } from "./memory-filter";
import { noteTool } from "./note";
import {
  recallMemoryDelivery,
  type RecallDelivery,
  type RecallInput,
} from "./recall";
import { rememberTool } from "./remember";
import { timelineQuery } from "./timeline";
import {
  WORKER_TOOL_RESULT_CONTENT_LIMIT,
  WORKER_TOOL_RESULT_MAX_CHARS,
  WORKER_TOOL_RESULT_TRUNCATION_HINT,
} from "./tool-envelope";
import { resolveEraCutoff } from "../db/era";
import { sessionWriterId } from "../db/write-gate";
import { stripPrivateTags } from "../shared/tag-stripping";


// Ticket 07 (phase-connectivity): the three numbers moved to `tool-envelope.ts`
// so `recall.ts` can judge a lane page against them without importing this
// module (which imports IT). Re-exported here, where every existing caller
// already looks for them.
export {
  WORKER_TOOL_RESULT_CONTENT_LIMIT,
  WORKER_TOOL_RESULT_MAX_CHARS,
  WORKER_TOOL_RESULT_TRUNCATION_HINT,
};

export type ToolResult = {
  content: Array<{
    type: "text";
    text: string;
  }>;
};

export type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult> | ToolResult;

export interface MnemoToolHandlers {
  recall: ToolHandler;
  timeline: ToolHandler;
  note: ToolHandler;
  remember: ToolHandler;
}

// Ticket 04: `phases` retired.
export type TimelineToolView = "turns" | "milestones";

export interface TimelineQueryInput {
  id: string;
  page?: number;
  pageSize?: number;
  view?: TimelineToolView;
  eraCutoffEpoch?: number | null;
  // Ticket 04 (spec "Tools"): the structured filter grammar shared with recall.
  filter?: MemoryFilterInput;
  // Ticket 05: token budget for the segment views (milestone size governor,
  // turn-view pagination budget).
  pageBudget?: number;
}

export interface CreateDatabaseBackedHandlersOptions {
  defaultProject?: string;
  // "worker" gates the private-tag-stripped, 100K-char-capped envelope
  // (`workerTextResult`/`deliverRecall` below) the memory worker's tool
  // channel needs — the public main agent uses "main" (default) and gets the
  // render verbatim. floor-and-render-fidelity ticket 03 retired the
  // dbid:T<dbid> correlation token this flag used to ALSO gate (recall and
  // lane_check both speak S<n>/T<m> now, so the worker no longer needs a
  // second, db-id-keyed vocabulary to correlate the two) — this is wired
  // here, NOT in `recallInputShape`, which is strict.
  audience?: "main" | "worker";
  /**
   * P2 era boundary (spec D11/D12). Resolved once here rather than per call —
   * it only changes on a reload — and defaults to the configured value, whose
   * own default (`null`) keeps every turn on the legacy path. This is the one
   * place the value is read for tool calls: reads (recall/timeline) and writes
   * (note) are handed the same number, so a turn cannot be written
   * under one era's rules and rendered under the other's.
   */
  eraCutoffEpoch?: number | null;
  /**
   * Resolves the caller's mnemo session id for `note` (spec D2), called fresh
   * on every `note` invocation rather than once here — the process-session
   * mapping this reads can be written by a UserPromptSubmit hook that runs
   * AFTER these handlers are built (the MCP server connects before the
   * session's first prompt), so resolving once at construction time would
   * permanently miss it. Only the MCP direct-execution entry point
   * (server.ts) ever supplies this; every other construction path — every
   * worker tool channel included — must leave it undefined, which `note`
   * reads as "caller identity unknown" and always admits.
   */
  resolveCallerSessionId?: () => number | null;
  /**
   * The write-gate reader identity these handlers' reads are attributed to,
   * for a caller that is NOT a session (peer round, the settlement fold-back).
   * Overrides the `session:<id>` derivation above; resolved per call for the
   * same reason that one is.
   *
   * This exists because the settlement child reads under its own claim
   * identity (`claim:<job>:<generation>`) — a per-REQUEST value that did not
   * exist when this factory was built. Without the seam it hand-rolled its own
   * `recallMemory` call plus a byte-for-byte copy of the worker envelope
   * below, which is exactly the kind of second copy that drifts: the envelope
   * grew a delivery-ledger commit (P1-6) that the copy would not have had.
   *
   * Note what it does NOT do: it applies to every read tool this handler set
   * exposes, `timeline` included. A caller that wants one identified reader and
   * one anonymous one (settlement: `recall` grants, `timeline` deliberately
   * does not) builds two handler sets and registers one tool from each, so the
   * asymmetry is a stated decision at the registration rather than a hidden
   * exemption in here.
   */
  resolveReaderId?: () => string | null;
  /** Clock seam for the read-grant timestamp; defaults to the real clock. */
  now?: () => number;
}

export function textResult(text: string): ToolResult {
  return {
    content: [
      {
        type: "text",
        text,
      },
    ],
  };
}

export function createStubHandler(toolName: string): ToolHandler {
  return async () => textResult(`${toolName} not implemented`);
}

export function toTimelineQueryInput(args: Record<string, unknown>): TimelineQueryInput {
  const input: TimelineQueryInput = {
    id: args.id as string,
  };

  if (args.page !== undefined) {
    input.page = args.page as number;
  }
  if (args.pageSize !== undefined) {
    input.pageSize = args.pageSize as number;
  }
  if (args.view !== undefined) {
    input.view = args.view as TimelineToolView;
  }
  if (args.filter !== undefined) {
    input.filter = args.filter as MemoryFilterInput;
  }
  // Ticket 05's owed wiring: the segment views' token budget (spec "Budgets").
  if (args.pageBudget !== undefined) {
    input.pageBudget = args.pageBudget as number;
  }

  return input;
}

export function createDatabaseBackedHandlers(
  database?: Database,
  options: CreateDatabaseBackedHandlersOptions = {},
): Partial<MnemoToolHandlers> {
  if (!database) {
    return {};
  }

  const isWorkerAudience = options.audience === "worker";
  // Resolved per tool call, not once here. These handlers are built when the
  // MCP server connects, which can be before any process of this build has
  // recorded the era: pinning `null` at that moment would make every `note` in
  // the session decline to promote its turn while the hooks, resolving live,
  // settle the same rows as new-era holes.
  const eraCutoff = (): number | null =>
    options.eraCutoffEpoch !== undefined
      ? options.eraCutoffEpoch
      : resolveEraCutoff(database);
  // Write gate (ticket 01): the SAME caller-session resolution `note`/
  // `remember` already use, re-encoded as this identity's write-gate writer
  // id. Resolved fresh per call, not once here, for the identical reason
  // `note`'s own `callerSessionId` is — the process-session mapping this
  // reads can be written by a hook that runs after these handlers are built.
  const readerId = (): string | null => {
    if (options.resolveReaderId) {
      return options.resolveReaderId();
    }
    const callerSessionId = options.resolveCallerSessionId?.() ?? null;
    return typeof callerSessionId === "number" ? sessionWriterId(callerSessionId) : null;
  };
  const workerTextResult = (text: string): ToolResult => {
    if (!isWorkerAudience) {
      return textResult(text);
    }
    const stripped = stripPrivateTags(text);
    if (stripped.length <= WORKER_TOOL_RESULT_MAX_CHARS) {
      return textResult(stripped);
    }
    return textResult(
      stripped.slice(0, WORKER_TOOL_RESULT_CONTENT_LIMIT) + WORKER_TOOL_RESULT_TRUNCATION_HINT,
    );
  };
  /**
   * The envelope, and the read grant it authorizes, decided together (peer
   * round P1-6). `workerTextResult` above is the same wire envelope — this is
   * that envelope told what it just delivered, so the grants and completeness
   * records the render collected are written for exactly the entities inside
   * the delivered bytes and for no others.
   *
   * The three branches are the three envelopes, and each commits what IT
   * delivered: the main agent's result is the render verbatim; a worker result
   * under the cap is the whole render minus private tags; a worker result over
   * the cap is a prefix, and the prefix's own length is what the ledger is told
   * (see `RecallDelivery.commitDelivered` for why measuring the STRIPPED prefix
   * against unstripped offsets can only ever under-grant).
   */
  const deliverRecall = (delivery: RecallDelivery): ToolResult => {
    if (!isWorkerAudience) {
      delivery.commitDelivered(delivery.text.length);
      return textResult(delivery.text);
    }
    const stripped = stripPrivateTags(delivery.text);
    if (stripped.length <= WORKER_TOOL_RESULT_MAX_CHARS) {
      delivery.commitDelivered(delivery.text.length);
      return textResult(stripped);
    }
    delivery.commitDelivered(WORKER_TOOL_RESULT_CONTENT_LIMIT);
    return textResult(
      stripped.slice(0, WORKER_TOOL_RESULT_CONTENT_LIMIT) + WORKER_TOOL_RESULT_TRUNCATION_HINT,
    );
  };

  return {
    recall: (args) =>
      deliverRecall(
        recallMemoryDelivery(database, {
          id: args.id as string | undefined,
          query: args.query as string | undefined,
          // Ticket 04: `time` moved into the structured `filter` object
          // (public schema no longer offers a top-level `time`). Ticket 11:
          // `filter.fields` is the sole field-selection mechanism — the
          // worker gets no special exemption any more (the retired `view`/
          // `depth` mapping and the `truncate`/`truncateCap` forwarding
          // below it are both gone).
          filter: args.filter as RecallInput["filter"],
          // Settlement-read-once ticket 01 (spec D1): the intent half of the
          // read contract — a top-level input beside `filter`, never inside
          // it (the filter object is shared with `timeline`, which refuses
          // this key by name).
          boundedFields: args.boundedFields as string[] | undefined,
          page: args.page as number | undefined,
          pageSize: args.pageSize as number | undefined,
          pageBudget: args.pageBudget as number | undefined,
          turn: args.turn as number | undefined,
          eraCutoffEpoch: eraCutoff(),
          readerId: readerId(),
          ...(options.now ? { now: options.now } : {}),
        }),
      ),
    timeline: (args) =>
      workerTextResult(
        timelineQuery(database, {
          ...toTimelineQueryInput(args),
          eraCutoffEpoch: eraCutoff(),
          readerId: readerId(),
        }),
      ),
    // Not wrapped in workerTextResult: `note` is a main-agent-only write, and
    // its confirmation is a short mechanical receipt with no memory text to
    // truncate or re-strip.
    note: (args) =>
      noteTool(database, args as Parameters<typeof noteTool>[1], {
        eraCutoffEpoch: eraCutoff(),
        callerSessionId: options.resolveCallerSessionId?.() ?? null,
      }),
    // Same shape as `note`: a main-agent-only write (ADR-0002), a short
    // mechanical receipt (plus `attach`'s field render), nothing to truncate.
    // No era gating — segments carry no legacy shape `remember` needs to
    // route around.
    remember: (args) =>
      rememberTool(database, args as Parameters<typeof rememberTool>[1], {
        callerSessionId: options.resolveCallerSessionId?.() ?? null,
      }),
  };
}
