import type { SDKAssistantMessage } from "@anthropic-ai/claude-agent-sdk";

import type { NoteSettlementStage } from "../db/note-settlement";

/**
 * THE RESPONSE-ORIGIN COORDINATOR (settlement-execution-repair ticket 01,
 * spec Rev 5 §Implementation "Two-layer identity" clause (a)). This module
 * lands the OBSERVATION half only: origins are tracked and resolvable, but
 * nothing in the host loops or write faces refuses on them yet — a later
 * ticket arms the refusal. That "later ticket" reads this module through
 * exactly two seams: `resolveResponseOrigin` (what a write face calls) and
 * `ResponseOrigin` (what it gets back).
 *
 * THE MECHANIC THIS PINS DOWN. The API's assistant `message.id` is the round
 * boundary: the SDK preserves it on every `SDKAssistantMessage`
 * (`SDKAssistantMessage.message.id`, the underlying `APIAssistantMessage`'s
 * own `id`), and a NEW id begins only after the previous response's full
 * tool-result set has drained back to the model — so at any instant at most
 * one response is "open" (has tool calls that may still be resolving their
 * origin). A settlement host loop observes each assistant message as it
 * arrives and, at the FIRST block of a message it has not seen before,
 * freezes that response's origin by reading the durable job row's `stage`
 * ONCE (never re-read for that message id again, however many times the loop
 * happens to see it) and maps every `tool_use` block's id in that message to
 * the frozen origin.
 *
 * THE RACE THIS CLOSES. The SDK may hand a tool call to its MCP handler
 * before the host loop's own `for await` has gotten around to observing the
 * assistant message that produced it — handler and loop both consume the
 * same underlying stream, but on different schedules. A handler resolving
 * its own call's origin therefore WAITS when it runs ahead, and the wait is
 * bounded on every axis (spec r4's "mechanical termination contract"):
 *   - the response that would have supplied the mapping closes without it
 *     (the loop observed a DIFFERENT, later message id, or the query ended) —
 *     resolves `"unknown"`;
 *   - the query aborts — resolves `"unknown"`;
 *   - a short coordinator deadline elapses — resolves `"unknown"`;
 *   - the registry is disposed (a new claim/generation is replacing it) —
 *     REJECTS, because disposal means this whole call's context no longer
 *     exists to answer for, which is a harder failure than "the origin
 *     could not be determined in time" and must not be silently downgraded
 *     to a value a caller might treat as a normal refusal.
 * No code path holds a promise that isn't wired to at least the deadline, so
 * nothing here can hang forever.
 */

/** The private Claude Code MCP metadata key carrying the calling tool's id. */
export const RESPONSE_ORIGIN_TOOL_USE_META_KEY = "claudecode/toolUseId";

/** Spec r4's "short coordinator deadline" — overridable per registry for tests. */
export const RESPONSE_ORIGIN_WAIT_TIMEOUT_MS = 5_000;

/**
 * What a call-origin resolves to: the durable stage this call's response was
 * frozen under, or `"unknown"` — which is deliberately NOT a third stage. A
 * write face that cannot determine an origin has exactly one safe reading of
 * it (fail closed), never a guess at which stage it might have been.
 */
export type ResponseOrigin = NoteSettlementStage | "unknown";

/**
 * One content block of an observed assistant message, reduced to what the
 * registry needs: its type (so the FIRST block — text or otherwise — is what
 * freezes the origin, never specifically the first `tool_use` block) and,
 * for a `tool_use` block, the id the registry maps.
 */
export interface ObservedResponseBlock {
  readonly type: string;
  readonly toolUseId?: string;
}

export interface ResponseOriginRegistry {
  /**
   * Called by the host loop for every assistant message it observes,
   * including repeats of an id it has already frozen (idempotent — the
   * SAME-ID MAPPING IMMUTABILITY property: a second observation of a
   * message id never re-reads the stage or moves an already-mapped
   * `tool_use` id, even if the durable row has since changed).
   *
   * Blocks are read in order and the origin is frozen at the first one,
   * whatever its type — a response that opens with reasoning/text before
   * its first `tool_use` block freezes on the text block, not the later
   * tool call.
   *
   * When `messageId` is a genuinely new id (the registry already has an
   * OPEN response under a different id), that older response is treated as
   * closed: this message's own blocks are mapped first, and only THEN are
   * any waiters still pending for other ids swept to `"unknown"` — a waiter
   * racing this very call for one of ITS OWN `tool_use` ids always gets its
   * first honest chance to resolve before the sweep can touch it.
   */
  observeAssistantMessage(
    messageId: string,
    blocks: readonly ObservedResponseBlock[],
  ): void;

  /**
   * Closes the currently open response (if any) — every pending waiter is
   * resolved `"unknown"`, on the reading that a response which has fully
   * ended without ever producing a given `tool_use` id's mapping is never
   * going to. The host loop calls this once after its `for await` drains,
   * closing out whichever response was still open when the query ended.
   */
  closeResponse(): void;

  /**
   * The query is aborting — nothing further will ever be observed. Like
   * `closeResponse`, pending waiters resolve `"unknown"` (spec: abort is one
   * of the three deadline-equivalent termination causes, not a hard
   * failure); unlike `closeResponse`, this also flips a permanent flag so
   * any call to `resolveOrigin` AFTER this point resolves `"unknown"`
   * immediately rather than registering a fresh waiter that would just sit
   * on its own deadline.
   */
  abort(): void;

  /**
   * The registry itself is being torn down (a new claim/generation has
   * replaced it). Every pending waiter REJECTS — see the module doc for why
   * this is the one path that rejects rather than resolving `"unknown"`.
   * Idempotent; leaves zero pending waiters.
   */
  dispose(): void;

  /**
   * Resolve one `tool_use` id's origin. Already-mapped ids resolve
   * synchronously (as a resolved promise); everything else registers a
   * waiter bounded by `closeResponse`/`abort`/the deadline/`dispose`, per
   * the module doc.
   */
  resolveOrigin(toolUseId: string): Promise<ResponseOrigin>;

  /** Diagnostic only — the count of waiters still pending. */
  pendingWaiterCount(): number;
}

export interface CreateResponseOriginRegistryOptions {
  /**
   * Reads the durable job row's stage AT THE MOMENT a new response's origin
   * is being frozen. `null` means the row could not be read (job gone,
   * reclaimed, or any other reason a fresh read came back empty) — treated
   * exactly like "no mapping": the response's origin freezes to `"unknown"`,
   * never a guess.
   */
  readStage: () => NoteSettlementStage | null;
  /** Overridable for tests; defaults to `RESPONSE_ORIGIN_WAIT_TIMEOUT_MS`. */
  waitTimeoutMs?: number;
}

interface PendingWaiter {
  readonly resolve: (origin: ResponseOrigin) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

class ResponseOriginRegistryImpl implements ResponseOriginRegistry {
  private readonly readStage: () => NoteSettlementStage | null;
  private readonly waitTimeoutMs: number;
  /** `tool_use` id -> frozen origin. Never overwritten once set. */
  private readonly origins = new Map<string, ResponseOrigin>();
  /** Assistant `message.id` -> frozen origin. Never overwritten once set. */
  private readonly frozenMessages = new Map<string, ResponseOrigin>();
  private openMessageId: string | null = null;
  private readonly waiters = new Map<string, PendingWaiter[]>();
  private disposed = false;
  private aborted = false;

  constructor(options: CreateResponseOriginRegistryOptions) {
    this.readStage = options.readStage;
    this.waitTimeoutMs = options.waitTimeoutMs ?? RESPONSE_ORIGIN_WAIT_TIMEOUT_MS;
  }

  observeAssistantMessage(
    messageId: string,
    blocks: readonly ObservedResponseBlock[],
  ): void {
    if (this.disposed) {
      return;
    }
    const isNewResponse =
      this.openMessageId !== null && this.openMessageId !== messageId;

    let origin = this.frozenMessages.get(messageId);
    if (origin === undefined) {
      origin = this.readStage() ?? "unknown";
      this.frozenMessages.set(messageId, origin);
    }
    this.openMessageId = messageId;

    // This message's OWN ids first — a waiter racing this exact call always
    // gets its honest shot before the transition sweep below can touch it.
    for (const block of blocks) {
      if (!block.toolUseId) {
        continue;
      }
      if (!this.origins.has(block.toolUseId)) {
        this.origins.set(block.toolUseId, origin);
      }
      this.settleWaiters(block.toolUseId, origin);
    }

    if (isNewResponse) {
      this.sweepPendingToUnknown();
    }
  }

  closeResponse(): void {
    if (this.disposed) {
      return;
    }
    this.sweepPendingToUnknown();
    this.openMessageId = null;
  }

  abort(): void {
    if (this.disposed) {
      return;
    }
    this.aborted = true;
    this.sweepPendingToUnknown();
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const list of this.waiters.values()) {
      for (const waiter of list) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error("response-origin registry disposed"));
      }
    }
    this.waiters.clear();
  }

  resolveOrigin(toolUseId: string): Promise<ResponseOrigin> {
    if (this.disposed) {
      return Promise.reject(new Error("response-origin registry disposed"));
    }
    const known = this.origins.get(toolUseId);
    if (known !== undefined) {
      return Promise.resolve(known);
    }
    if (this.aborted) {
      return Promise.resolve("unknown");
    }
    return new Promise<ResponseOrigin>((resolve, reject) => {
      const waiter: PendingWaiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.removeWaiter(toolUseId, waiter);
          resolve("unknown");
        }, this.waitTimeoutMs),
      };
      // A leaked timer must never be the reason this process outlives its
      // own work — the deadline is a backstop for the WAIT, not a reason to
      // keep the event loop alive on its own.
      waiter.timer.unref?.();
      const list = this.waiters.get(toolUseId);
      if (list) {
        list.push(waiter);
      } else {
        this.waiters.set(toolUseId, [waiter]);
      }
    });
  }

  pendingWaiterCount(): number {
    let count = 0;
    for (const list of this.waiters.values()) {
      count += list.length;
    }
    return count;
  }

  private settleWaiters(toolUseId: string, origin: ResponseOrigin): void {
    const list = this.waiters.get(toolUseId);
    if (!list) {
      return;
    }
    this.waiters.delete(toolUseId);
    for (const waiter of list) {
      clearTimeout(waiter.timer);
      waiter.resolve(origin);
    }
  }

  private sweepPendingToUnknown(): void {
    for (const list of this.waiters.values()) {
      for (const waiter of list) {
        clearTimeout(waiter.timer);
        waiter.resolve("unknown");
      }
    }
    this.waiters.clear();
  }

  private removeWaiter(toolUseId: string, waiter: PendingWaiter): void {
    const list = this.waiters.get(toolUseId);
    if (!list) {
      return;
    }
    const index = list.indexOf(waiter);
    if (index >= 0) {
      list.splice(index, 1);
    }
    if (list.length === 0) {
      this.waiters.delete(toolUseId);
    }
  }
}

/**
 * A fresh registry for a fresh claim/generation. Every settlement dispatch
 * (one `queryImpl` call) constructs exactly one of these — never shared
 * across dispatches — so a stale generation's waiters can never be satisfied
 * by a later generation's observations; the only cross-generation guarantee
 * this module owes is that it owes none.
 */
export function createResponseOriginRegistry(
  options: CreateResponseOriginRegistryOptions,
): ResponseOriginRegistry {
  return new ResponseOriginRegistryImpl(options);
}

/**
 * The host-loop half: reduce one observed `SDKAssistantMessage` to what
 * `observeAssistantMessage` needs and feed it. Both settlement host loops
 * (stage-1's and sdk-query's `for await`) call this for every message of
 * `type === "assistant"` they see — the same reduction for both, so the two
 * loops cannot drift on what "a block" or "the message id" means.
 */
export function observeSdkAssistantMessage(
  registry: ResponseOriginRegistry,
  message: Pick<SDKAssistantMessage, "message">,
): void {
  const blocks: ObservedResponseBlock[] = message.message.content.map(
    (block: SDKAssistantMessage["message"]["content"][number]) => ({
      type: block.type,
      toolUseId: block.type === "tool_use" ? block.id : undefined,
    }),
  );
  registry.observeAssistantMessage(message.message.id, blocks);
}

/**
 * THE CLEAN SEAM a write face resolves its own call's origin through — the
 * only function later tickets need to import from this module besides the
 * `ResponseOrigin` type itself. `extra` is the MCP handler's second
 * argument, typed `unknown` by the SDK's own `tool()` signature; this
 * function is the ONE place that reaches into it, so a shape change there
 * has exactly one call site to fix.
 *
 * ABSENT METADATA RESOLVES IMMEDIATELY AS UNKNOWN — no wait, no registry
 * lookup at all. This is deliberate fail-closed behavior for the case the
 * sentinel test guards: if `RESPONSE_ORIGIN_TOOL_USE_META_KEY` ever stops
 * arriving (an SDK upgrade dropping it), every call degrades to `"unknown"`
 * rather than hanging or throwing — safe, and the sentinel test is what
 * turns that silent degradation into a red test instead.
 */
export function resolveResponseOrigin(
  registry: ResponseOriginRegistry,
  extra: unknown,
): Promise<ResponseOrigin> {
  const meta = (extra as { _meta?: unknown } | null | undefined)?._meta;
  const toolUseId =
    meta && typeof meta === "object"
      ? (meta as Record<string, unknown>)[RESPONSE_ORIGIN_TOOL_USE_META_KEY]
      : undefined;
  if (typeof toolUseId !== "string" || toolUseId.length === 0) {
    return Promise.resolve("unknown");
  }
  return registry.resolveOrigin(toolUseId);
}
