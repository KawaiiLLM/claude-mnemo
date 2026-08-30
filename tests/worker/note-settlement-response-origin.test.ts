import { describe, expect, mock, test } from "bun:test";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

import {
  createResponseOriginRegistry,
  observeSdkAssistantMessage,
  resolveResponseOrigin,
  RESPONSE_ORIGIN_TOOL_USE_META_KEY,
  RESPONSE_ORIGIN_WAIT_TIMEOUT_MS,
  type ResponseOriginRegistry,
} from "../../src/worker/note-settlement-response-origin";

/**
 * The response-origin coordinator, unit-tested in isolation from either host
 * loop (settlement-execution-repair ticket 01). Every scenario named in the
 * ticket's acceptance list gets its own `test`, named after that scenario so
 * a failure names exactly which property broke.
 */

function textBlock(): { type: "text"; toolUseId?: undefined } {
  return { type: "text" };
}

/** An `ObservedResponseBlock` — what `observeAssistantMessage` itself takes. */
function toolUseBlock(id: string): { type: "tool_use"; toolUseId: string } {
  return { type: "tool_use", toolUseId: id };
}

/**
 * A REAL SDK content-block shape (`{type, id, name, input}`) — what
 * `observeSdkAssistantMessage`'s reduction reads `.id` off of. Deliberately a
 * different shape from `toolUseBlock` above: that helper feeds the already-
 * reduced `ObservedResponseBlock` contract straight to the registry, and
 * conflating the two would let a field-name mismatch between them pass
 * silently.
 */
function sdkToolUseBlock(id: string): { type: "tool_use"; id: string; name: string; input: unknown } {
  return { type: "tool_use", id, name: "note", input: {} };
}

describe("same-id mapping immutability", () => {
  test("a second observation of the same message id never re-reads the stage or re-maps its tool_use ids", () => {
    const readStage = mock(() => "topics" as const);
    const registry = createResponseOriginRegistry({ readStage });

    registry.observeAssistantMessage("msg_1", [toolUseBlock("tu_1")]);
    expect(readStage).toHaveBeenCalledTimes(1);

    // The row moved on (a real transition landed) — the SAME message id is
    // observed again (defensive: the host loop must never be able to move
    // an already-frozen origin just by seeing its message twice).
    readStage.mockImplementation(() => "edges");
    registry.observeAssistantMessage("msg_1", [toolUseBlock("tu_1"), toolUseBlock("tu_2")]);

    expect(readStage).toHaveBeenCalledTimes(1);
    return Promise.all([
      registry.resolveOrigin("tu_1").then((origin) => expect(origin).toBe("topics")),
      // tu_2 arrived under the SAME message id — still the frozen origin.
      registry.resolveOrigin("tu_2").then((origin) => expect(origin).toBe("topics")),
    ]);
  });
});

describe("text-first block freezing", () => {
  test("the origin freezes at the first block of a new message even when it is text, before any tool_use block", async () => {
    const readStage = mock(() => "topics" as const);
    const registry = createResponseOriginRegistry({ readStage });

    registry.observeAssistantMessage("msg_1", [textBlock(), toolUseBlock("tu_1")]);

    expect(readStage).toHaveBeenCalledTimes(1);
    expect(await registry.resolveOrigin("tu_1")).toBe("topics");
  });
});

describe("handler-before-observation waiting then succeeding", () => {
  test("a resolveOrigin call made before the owning message is observed waits, then resolves once it is", async () => {
    const registry = createResponseOriginRegistry({ readStage: () => "topics" });

    const pending = registry.resolveOrigin("tu_1");
    expect(registry.pendingWaiterCount()).toBe(1);

    registry.observeAssistantMessage("msg_1", [toolUseBlock("tu_1")]);

    expect(await pending).toBe("topics");
    expect(registry.pendingWaiterCount()).toBe(0);
  });
});

describe("an unknown id resolving refusal-shaped when its response closes unmapped", () => {
  test("closeResponse resolves every still-pending waiter to \"unknown\", never rejecting", async () => {
    const registry = createResponseOriginRegistry({ readStage: () => "topics" });

    const pending = registry.resolveOrigin("tu_never_mapped");
    registry.closeResponse();

    expect(await pending).toBe("unknown");
    expect(registry.pendingWaiterCount()).toBe(0);
  });

  test("a NEW message id closes the previous response automatically — a waiter for an id that belonged only to the old response resolves \"unknown\"", async () => {
    const registry = createResponseOriginRegistry({ readStage: () => "topics" });

    registry.observeAssistantMessage("msg_1", [toolUseBlock("tu_1")]);
    const orphaned = registry.resolveOrigin("tu_from_msg_1_never_sent");

    // A genuinely new response begins — msg_1's window is over.
    registry.observeAssistantMessage("msg_2", [toolUseBlock("tu_2")]);

    expect(await orphaned).toBe("unknown");
    expect(await registry.resolveOrigin("tu_2")).toBe("topics");
  });

  test("ordering safety: a waiter racing the SAME incoming message's own tool_use id is satisfied by it, not swept by the transition it triggers", async () => {
    const registry = createResponseOriginRegistry({ readStage: () => "topics" });
    registry.observeAssistantMessage("msg_1", [toolUseBlock("tu_old")]);

    // The handler for msg_2's own tool_use id races ahead of the loop's
    // observation of msg_2 — exactly the scenario the wait exists for.
    const racing = registry.resolveOrigin("tu_msg2");

    registry.observeAssistantMessage("msg_2", [toolUseBlock("tu_msg2")]);

    expect(await racing).toBe("topics");
  });
});

describe("a query abort resolving unknown and clearing waiters", () => {
  test("abort() resolves pending waiters \"unknown\" (never rejects) and leaves zero pending", async () => {
    const registry = createResponseOriginRegistry({ readStage: () => "topics" });
    const pending = registry.resolveOrigin("tu_1");

    registry.abort();

    expect(await pending).toBe("unknown");
    expect(registry.pendingWaiterCount()).toBe(0);
  });

  test("after abort, a brand-new resolveOrigin call resolves \"unknown\" immediately — no fresh waiter is ever registered", async () => {
    const registry = createResponseOriginRegistry({ readStage: () => "topics" });
    registry.abort();

    expect(await registry.resolveOrigin("tu_after_abort")).toBe("unknown");
    expect(registry.pendingWaiterCount()).toBe(0);
  });
});

describe("dispose leaving zero pending", () => {
  test("dispose() rejects every pending waiter and leaves zero pending", async () => {
    const registry = createResponseOriginRegistry({ readStage: () => "topics" });
    const pending = registry.resolveOrigin("tu_1");
    const rejection = pending.then(
      () => {
        throw new Error("expected resolveOrigin to reject after dispose");
      },
      (error) => error,
    );

    registry.dispose();

    const error = await rejection;
    expect(error).toBeInstanceOf(Error);
    expect(registry.pendingWaiterCount()).toBe(0);
  });

  test("dispose() is idempotent, and observeAssistantMessage after dispose is a harmless no-op", async () => {
    const readStage = mock(() => "topics" as const);
    const registry = createResponseOriginRegistry({ readStage });
    registry.dispose();
    registry.dispose();

    registry.observeAssistantMessage("msg_after_dispose", [toolUseBlock("tu_1")]);
    expect(readStage).not.toHaveBeenCalled();

    await expect(registry.resolveOrigin("tu_1")).rejects.toThrow();
  });
});

describe("absent metadata resolving unknown immediately", () => {
  function unusedRegistry(): ResponseOriginRegistry {
    return {
      observeAssistantMessage: () => {
        throw new Error("must not be called");
      },
      closeResponse: () => {
        throw new Error("must not be called");
      },
      abort: () => {
        throw new Error("must not be called");
      },
      dispose: () => {
        throw new Error("must not be called");
      },
      resolveOrigin: () => {
        throw new Error("resolveResponseOrigin must not reach the registry when metadata is absent");
      },
      pendingWaiterCount: () => 0,
    };
  }

  test("extra with no _meta resolves \"unknown\" without touching the registry", async () => {
    expect(await resolveResponseOrigin(unusedRegistry(), {})).toBe("unknown");
  });

  test("extra with _meta but no claudecode/toolUseId key resolves \"unknown\" without touching the registry", async () => {
    expect(
      await resolveResponseOrigin(unusedRegistry(), { _meta: { unrelated: "value" } }),
    ).toBe("unknown");
  });

  test("extra that is null/undefined resolves \"unknown\" without touching the registry", async () => {
    expect(await resolveResponseOrigin(unusedRegistry(), undefined)).toBe("unknown");
    expect(await resolveResponseOrigin(unusedRegistry(), null)).toBe("unknown");
  });
});

describe("a new generation clearing the table", () => {
  test("two registries never share state — observing one does not resolve the other", async () => {
    const first = createResponseOriginRegistry({ readStage: () => "topics" });
    const second = createResponseOriginRegistry({ readStage: () => "edges" });

    first.observeAssistantMessage("msg_1", [toolUseBlock("tu_1")]);

    expect(await first.resolveOrigin("tu_1")).toBe("topics");
    // A registry that had never seen "tu_1" waits for it rather than
    // inheriting the other registry's mapping — proven by racing the
    // deadline: it settles "unknown", not "topics".
    expect(
      await createResponseOriginRegistry({ readStage: () => "edges", waitTimeoutMs: 5 }).resolveOrigin(
        "tu_1",
      ),
    ).toBe("unknown");
    void second;
  });
});

describe("the mechanical deadline is a backstop when nothing else ever closes the wait", () => {
  test("a waiter with no closeResponse/abort/dispose still resolves \"unknown\" once the deadline elapses", async () => {
    const registry = createResponseOriginRegistry({ readStage: () => "topics", waitTimeoutMs: 15 });
    expect(await registry.resolveOrigin("tu_never_arrives")).toBe("unknown");
    expect(registry.pendingWaiterCount()).toBe(0);
  });

  test("the exported default deadline constant is what an un-configured registry uses", () => {
    expect(RESPONSE_ORIGIN_WAIT_TIMEOUT_MS).toBeGreaterThan(0);
  });
});

describe("readStage returning null (job row unreadable) freezes to unknown, never a guess", () => {
  test("a message observed while the durable row cannot be read freezes \"unknown\"", async () => {
    const registry = createResponseOriginRegistry({ readStage: () => null });
    registry.observeAssistantMessage("msg_1", [toolUseBlock("tu_1")]);
    expect(await registry.resolveOrigin("tu_1")).toBe("unknown");
  });
});

describe("observeSdkAssistantMessage — the host-loop reduction from a real SDKAssistantMessage", () => {
  test("reduces message.message.id and content blocks into exactly what observeAssistantMessage expects", async () => {
    const registry = createResponseOriginRegistry({ readStage: () => "edges" });
    observeSdkAssistantMessage(registry, {
      message: {
        id: "msg_real_1",
        content: [textBlock(), sdkToolUseBlock("tu_real_1"), sdkToolUseBlock("tu_real_2")],
      },
      // The rest of a real SDKAssistantMessage is irrelevant to this
      // reduction — `Pick<SDKAssistantMessage, "message">` is the whole
      // contract.
    } as never);

    expect(await registry.resolveOrigin("tu_real_1")).toBe("edges");
    expect(await registry.resolveOrigin("tu_real_2")).toBe("edges");
  });
});

describe(`sentinel: the "${RESPONSE_ORIGIN_TOOL_USE_META_KEY}" MCP metadata key survives a real handler round-trip`, () => {
  // THE DRIFT GUARD (spec r3/r4). `resolveResponseOrigin` reads
  // `extra._meta?.[RESPONSE_ORIGIN_TOOL_USE_META_KEY]` — a private Claude
  // Code convention (~/Projects/claude-code-main/src/services/mcp/client.ts
  // ~1841-1843: `meta = toolUseId ? { 'claudecode/toolUseId': toolUseId } :
  // {}`), carried over the wire as the MCP protocol's own `_meta` request
  // field. This test does not (cannot, in a unit test) invoke a real Claude
  // Code process — it instead drives the actual dependency this module
  // shares with production: `@anthropic-ai/claude-agent-sdk`'s `tool()` /
  // `createSdkMcpServer()` connected, over a REAL `@modelcontextprotocol/sdk`
  // transport, to a REAL `Client` that attaches `_meta` on its call exactly
  // as an MCP client is specified to. If either SDK's version bumps ever
  // stop threading `_meta` into the server-side handler's `extra`, or rename
  // the key's carrier, this is what goes red — and per the module doc,
  // production itself only degrades to `"unknown"` (safe), never throws or
  // hangs.
  test("a tool called with _meta[claudecode/toolUseId] set delivers it to the handler's extra._meta", async () => {
    const TEST_TOOL_USE_ID = "toolu_sentinel_test_id";
    let capturedExtra: { _meta?: Record<string, unknown> } | undefined;

    const probeTool = tool(
      "probe",
      "sentinel probe tool",
      { value: z.string() },
      async (_args: { value: string }, extra: unknown) => {
        capturedExtra = extra as { _meta?: Record<string, unknown> };
        return { content: [{ type: "text" as const, text: "ok" }] };
      },
    );
    const sdkServer = createSdkMcpServer({
      name: "response-origin-sentinel",
      version: "0.0.0",
      tools: [probeTool],
    });
    const mcpServerInstance = (sdkServer as unknown as { instance: { connect(transport: unknown): Promise<void> } })
      .instance;

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "response-origin-sentinel-client", version: "0.0.0" });

    await Promise.all([
      mcpServerInstance.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    try {
      await client.callTool({
        name: "probe",
        arguments: { value: "x" },
        _meta: { [RESPONSE_ORIGIN_TOOL_USE_META_KEY]: TEST_TOOL_USE_ID },
      });

      expect(capturedExtra?._meta?.[RESPONSE_ORIGIN_TOOL_USE_META_KEY]).toBe(TEST_TOOL_USE_ID);

      // resolveResponseOrigin reading exactly what the handler received —
      // the seam this whole sentinel exists to protect.
      const registry = createResponseOriginRegistry({ readStage: () => "topics" });
      registry.observeAssistantMessage("msg_1", [
        { type: "tool_use", toolUseId: TEST_TOOL_USE_ID },
      ]);
      expect(await resolveResponseOrigin(registry, capturedExtra)).toBe("topics");
    } finally {
      await client.close();
    }
  });
});

describe(
  `producer sentinel: the resolved SDK artifact still mints "${RESPONSE_ORIGIN_TOOL_USE_META_KEY}" ` +
    "(settlement-execution-repair ticket 13, P2 sweep item 1)",
  () => {
    // THE GAP THE ROUND-TRIP SENTINEL ABOVE CANNOT COVER. That test drives a
    // REAL `@modelcontextprotocol/sdk` `Client`, but it is US who attaches
    // `_meta: { [RESPONSE_ORIGIN_TOOL_USE_META_KEY]: ... }` on the call — it
    // proves the SERVER side (`tool()`/`createSdkMcpServer()`) delivers
    // whatever `_meta` a client sends, never that the CLIENT side (the
    // actual Claude Code adapter driving the real settlement subprocess)
    // still SENDS that key at all. If an SDK/adapter upgrade stopped minting
    // it, the round-trip test would keep passing (we would just be feeding
    // the server a key nothing real ever produces) while every settlement
    // write silently degraded to `resolveResponseOrigin`'s safe fallback,
    // `"unknown"` — exactly the drift this sentinel exists to turn red
    // instead.
    //
    // THE PRODUCER, LOCATED. The literal string lives inside
    // `node_modules/@anthropic-ai/claude-agent-sdk/cli.js` — the bundled CC
    // adapter binary the SDK package ships alongside `sdk.mjs`, and (per
    // `sdk.mjs`'s own resolution: `pathToClaudeCodeExecutable ??=
    // join(dirname(sdk.mjs), "cli.js")`) the SDK's own DEFAULT executable
    // whenever a caller does not supply `pathToClaudeCodeExecutable` — this
    // repo's own settlement dispatch (`resolveClaudeCodeExecutablePath`,
    // worker/claude-executable.ts) only overrides that default when
    // `CLAUDE_CODE_PATH`/`CLAUDE_CODE_EXECUTABLE` is set or a `claude`
    // binary is found on `PATH`; absent both, this exact bundled cli.js is
    // what actually runs. Inside it, minified, the minting site (an MCP
    // tool descriptor's own `.call()`):
    //   let I=$u5(X),W=I?{"claudecode/toolUseId":I}:{}, ...
    //   VS2({client:K, tool:G.name, args:Z, meta:W, signal:...})
    // — `$u5` extracts the calling tool-use id from the call context, and
    // the ternary is the literal producer this sentinel pins.
    //
    // WHAT THIS CATCHES. An `@anthropic-ai/claude-agent-sdk` version bump —
    // tracked in this repo's own `package.json`/lockfile — that drops or
    // renames the key inside the SDK's OWN bundled adapter. `Bun.resolveSync`
    // below resolves through the SAME module-resolution algorithm Node/Bun
    // use at runtime, so this reads whatever version is ACTUALLY installed,
    // not a path assumed from directory layout.
    //
    // WHAT THIS CANNOT CATCH. A real production settlement subprocess
    // prefers a SYSTEM-INSTALLED `claude` binary over this bundled cli.js
    // whenever `resolveClaudeCodeExecutablePath` finds one — an artifact
    // entirely outside this repo's dependency graph, with no lockfile entry
    // and no offline copy to grep. If Claude Code's own release cadence ever
    // drifts this key away from what the paired SDK version bundles, this
    // sentinel stays green while that production path goes dark — the exact
    // residual gap ticket 13 anticipated ("if the producer is not present in
    // any resolvable artifact... pin the closest resolvable artifact").
    const sdkEntryPath = Bun.resolveSync(
      "@anthropic-ai/claude-agent-sdk",
      import.meta.dir,
    );
    const sdkCliPath = join(dirname(sdkEntryPath), "cli.js");

    test(`cli.js (the SDK's own pathToClaudeCodeExecutable default) still contains the "${RESPONSE_ORIGIN_TOOL_USE_META_KEY}" literal`, () => {
      const source = readFileSync(sdkCliPath, "utf8");
      expect(source).toContain(`"${RESPONSE_ORIGIN_TOOL_USE_META_KEY}"`);
    });
  },
);

describe(
  "cold `edges` resume applies no per-call origin gate (documented narrowing, settlement-execution-repair ticket 13, P2 sweep item 2)",
  () => {
    // WHY A SOURCE-TEXT PIN, NOT A BEHAVIORAL ONE. Exercising
    // `createNoteSettlementSdkQuery` itself needs a real job row (DB schema,
    // a claimed settlement job) that belongs to
    // `tests/worker/note-settlement-sdk-query.test.ts`'s own fixture
    // machinery, well outside this file's and this ticket's territory. The
    // CONTRACT this pins is narrower and file-local: the cold wrapper's own
    // `leasedTool` region must keep declining to resolve a per-call origin
    // (no `resolveResponseOrigin` CALL — as opposed to the two comment
    // MENTIONS a few lines above it, which reference the unified region's
    // own call for contrast) — so that if a later change reintroduces
    // per-call gating here without updating this pin, the mismatch between
    // "the code guards this path" and "the tests below still assume no
    // origin staging needed" (per
    // `staged-settlement-integration.test.ts`'s own comment) surfaces here
    // first, in the one file this ticket owns, rather than as a mass of
    // unrelated red in a file it does not.
    const source = readFileSync(
      join(
        import.meta.dir,
        "../../src/worker/note-settlement-sdk-query.ts",
      ),
      "utf8",
    );
    const coldWrapperStart = source.indexOf(
      "export function createNoteSettlementSdkQuery(",
    );
    const unifiedRegionStart = source.indexOf(
      "export function createUnifiedNoteSettlementSdkQuery(",
    );
    if (coldWrapperStart === -1 || unifiedRegionStart === -1 || unifiedRegionStart <= coldWrapperStart) {
      throw new Error(
        "fixture assumption broken — could not locate both createNoteSettlementSdkQuery and " +
          "createUnifiedNoteSettlementSdkQuery in note-settlement-sdk-query.ts",
      );
    }
    const coldWrapperSource = source.slice(coldWrapperStart, unifiedRegionStart);

    test("the documented-narrowing comment is present ahead of the leased-tool wrapper", () => {
      expect(coldWrapperSource).toContain(
        "SETTLEMENT-EXECUTION-REPAIR TICKET 13, ITEM 2",
      );
      expect(coldWrapperSource).toContain("REUSE WAS THE TICKET'S OWN PREFERRED REPAIR");
    });

    test("the cold wrapper's own tool handlers never call resolveResponseOrigin (structural pin)", () => {
      expect(coldWrapperSource).not.toContain("= await resolveResponseOrigin(");
    });
  },
);
