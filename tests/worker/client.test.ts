import { describe, expect, mock, test } from "bun:test";

import {
  notifyWorkerCompact,
  notifyWorkerWake,
  resolveWorkerScriptPaths,
  spawnWorkerProcess,
} from "../../src/worker/client";
import { BUILD_ID } from "../../src/shared/build-id";

function healthResponse(buildId: string = BUILD_ID): Response {
  return new Response(JSON.stringify({ ok: true, buildId }), { status: 200 });
}

function staleHealthResponse(): Response {
  return new Response(JSON.stringify({ ok: true, buildId: "old-build-000" }), {
    status: 200,
  });
}

describe("worker client", () => {
  test("resolveWorkerScriptPaths uses CLAUDE_PLUGIN_ROOT when present", () => {
    expect(
      resolveWorkerScriptPaths({
        CLAUDE_PLUGIN_ROOT: "/tmp/plugin-root",
      } as NodeJS.ProcessEnv),
    ).toEqual({
      bunRunnerPath: "/tmp/plugin-root/scripts/bun-runner.js",
      workerPath: "/tmp/plugin-root/scripts/worker.cjs",
    });
  });

  test("spawnWorkerProcess uses bun-runner.js and worker.cjs", () => {
    const spawnImpl = mock(() => ({ unref: mock(() => {}) })) as unknown as typeof import("node:child_process").spawn;
    spawnWorkerProcess(
      {
        spawnImpl,
        existsSyncImpl: () => true,
      },
      {
        CLAUDE_PLUGIN_ROOT: "/tmp/plugin-root",
      } as NodeJS.ProcessEnv,
    );

    expect(spawnImpl).toHaveBeenCalledTimes(1);
    expect(spawnImpl.mock.calls[0]?.[0]).toBe("node");
    expect(spawnImpl.mock.calls[0]?.[1]).toEqual([
      "/tmp/plugin-root/scripts/bun-runner.js",
      "/tmp/plugin-root/scripts/worker.cjs",
    ]);
  });

  test("notifyWorkerWake sends wake when worker is compatible", async () => {
    let wakeCallCount = 0;
    const fetchImpl = mock(async (input: string | URL) => {
      if (String(input).endsWith("/health")) {
        return healthResponse();
      }
      if (String(input).endsWith("/wake")) {
        wakeCallCount += 1;
        return new Response(null, { status: 200 });
      }
      return new Response(null, { status: 404 });
    });
    const spawnImpl = mock(() => ({ unref: mock(() => {}) })) as unknown as typeof import("node:child_process").spawn;

    await notifyWorkerWake(
      { fetchImpl, spawnImpl, existsSyncImpl: () => true },
      { CLAUDE_PLUGIN_ROOT: "/tmp/plugin-root" } as NodeJS.ProcessEnv,
    );

    expect(wakeCallCount).toBe(1);
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  test("notifyWorkerWake spawns the worker when down and sends /wake after it becomes compatible", async () => {
    let healthCallIndex = 0;
    let wakeCallCount = 0;
    const fetchImpl = mock(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith("/health")) {
        healthCallIndex += 1;
        if (healthCallIndex === 1) {
          throw new Error("connection refused");
        }
        return healthResponse();
      }
      if (url.endsWith("/wake")) {
        wakeCallCount += 1;
        return new Response(null, { status: 200 });
      }
      return new Response(null, { status: 404 });
    });
    const spawnImpl = mock(() => ({ unref: mock(() => {}) })) as unknown as typeof import("node:child_process").spawn;

    await notifyWorkerWake(
      {
        fetchImpl,
        spawnImpl,
        existsSyncImpl: () => true,
        setTimeoutImpl: ((handler: TimerHandler) => {
          if (typeof handler === "function") handler();
          return 0 as unknown as NodeJS.Timeout;
        }) as typeof setTimeout,
      },
      { CLAUDE_PLUGIN_ROOT: "/tmp/plugin-root" } as NodeJS.ProcessEnv,
    );

    expect(spawnImpl).toHaveBeenCalledTimes(1);
    expect(wakeCallCount).toBe(1);
  });

  test("notifyWorkerWake waits for compatible worker after killing stale, then sends /wake", async () => {
    let healthCallIndex = 0;
    let wakeCallCount = 0;
    const fetchImpl = mock(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith("/health")) {
        healthCallIndex += 1;
        if (healthCallIndex <= 2) {
          return staleHealthResponse();
        }
        return healthResponse();
      }
      if (url.endsWith("/wake")) {
        wakeCallCount += 1;
        return new Response(null, { status: 200 });
      }
      return new Response(null, { status: 404 });
    });
    const spawnImpl = mock(() => ({ unref: mock(() => {}) })) as unknown as typeof import("node:child_process").spawn;

    await notifyWorkerWake(
      {
        fetchImpl,
        spawnImpl,
        existsSyncImpl: (path: string) => !path.includes("nonexistent-pid"),
        pidPath: "/tmp/nonexistent-pid",
        setTimeoutImpl: ((handler: TimerHandler) => {
          if (typeof handler === "function") handler();
          return 0 as unknown as NodeJS.Timeout;
        }) as typeof setTimeout,
      },
      { CLAUDE_PLUGIN_ROOT: "/tmp/plugin-root" } as NodeJS.ProcessEnv,
    );

    expect(spawnImpl).toHaveBeenCalledTimes(1);
    expect(wakeCallCount).toBe(1);
  });

  test("notifyWorkerWake does not send /wake when stale worker never becomes compatible", async () => {
    let wakeCallCount = 0;
    let fakeNow = 1000;
    const fetchImpl = mock(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith("/health")) {
        fakeNow += 31_000;
        return staleHealthResponse();
      }
      if (url.endsWith("/wake")) {
        wakeCallCount += 1;
      }
      return new Response(null, { status: 200 });
    });
    const spawnImpl = mock(() => ({ unref: mock(() => {}) })) as unknown as typeof import("node:child_process").spawn;

    await notifyWorkerWake(
      {
        fetchImpl,
        spawnImpl,
        existsSyncImpl: (path: string) => !path.includes("nonexistent-pid"),
        pidPath: "/tmp/nonexistent-pid",
        nowMsImpl: () => fakeNow,
        setTimeoutImpl: ((handler: TimerHandler) => {
          if (typeof handler === "function") handler();
          return 0 as unknown as NodeJS.Timeout;
        }) as typeof setTimeout,
      },
      { CLAUDE_PLUGIN_ROOT: "/tmp/plugin-root" } as NodeJS.ProcessEnv,
    );

    expect(spawnImpl).toHaveBeenCalledTimes(1);
    expect(wakeCallCount).toBe(0);
  });

  test("notifyWorkerCompact kills stale worker before spawning new one", async () => {
    let callIndex = 0;
    const fetchImpl = mock(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith("/health")) {
        callIndex += 1;
        if (callIndex === 1) {
          return staleHealthResponse();
        }
        return healthResponse();
      }
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    const spawnImpl = mock(() => ({ unref: mock(() => {}) })) as unknown as typeof import("node:child_process").spawn;

    await notifyWorkerCompact(
      42,
      "/tmp/session.jsonl",
      {
        fetchImpl,
        spawnImpl,
        existsSyncImpl: (path: string) => !path.includes("nonexistent-pid"),
        pidPath: "/tmp/nonexistent-pid",
        setTimeoutImpl: ((handler: TimerHandler) => {
          if (typeof handler === "function") handler();
          return 0 as unknown as NodeJS.Timeout;
        }) as typeof setTimeout,
      },
      { CLAUDE_PLUGIN_ROOT: "/tmp/plugin-root" } as NodeJS.ProcessEnv,
    );

    expect(spawnImpl).toHaveBeenCalledTimes(1);
    const compactCall = fetchImpl.mock.calls.find((call) =>
      String(call[0]).endsWith("/compact"),
    );
    expect(compactCall).toBeDefined();
  });

  test("notifyWorkerCompact skips kill when worker is simply down", async () => {
    let callIndex = 0;
    const fetchImpl = mock(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith("/health")) {
        callIndex += 1;
        if (callIndex === 1) {
          throw new Error("connection refused");
        }
        return healthResponse();
      }
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    const spawnImpl = mock(() => ({ unref: mock(() => {}) })) as unknown as typeof import("node:child_process").spawn;

    await notifyWorkerCompact(
      42,
      "/tmp/session.jsonl",
      {
        fetchImpl,
        spawnImpl,
        existsSyncImpl: () => true,
        setTimeoutImpl: ((handler: TimerHandler) => {
          if (typeof handler === "function") handler();
          return 0 as unknown as NodeJS.Timeout;
        }) as typeof setTimeout,
      },
      { CLAUDE_PLUGIN_ROOT: "/tmp/plugin-root" } as NodeJS.ProcessEnv,
    );

    expect(spawnImpl).toHaveBeenCalledTimes(1);
  });

  test("health response without buildId is treated as compatible", async () => {
    let wakeCallCount = 0;
    const fetchImpl = mock(async (input: string | URL) => {
      if (String(input).endsWith("/health")) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (String(input).endsWith("/wake")) {
        wakeCallCount += 1;
      }
      return new Response(null, { status: 200 });
    });
    const spawnImpl = mock(() => ({ unref: mock(() => {}) })) as unknown as typeof import("node:child_process").spawn;

    await notifyWorkerWake(
      { fetchImpl, spawnImpl, existsSyncImpl: () => true },
      { CLAUDE_PLUGIN_ROOT: "/tmp/plugin-root" } as NodeJS.ProcessEnv,
    );

    expect(wakeCallCount).toBe(1);
    expect(spawnImpl).not.toHaveBeenCalled();
  });
});
