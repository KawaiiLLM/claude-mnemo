import { describe, expect, mock, test } from "bun:test";
import { unlinkSync, writeFileSync } from "node:fs";

import {
  kickWorkerFast,
  notifyWorkerCompact,
  notifyWorkerFlush,
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

function staleHealthResponseWithPid(pid: number): Response {
  return new Response(JSON.stringify({ ok: true, buildId: "old-build-000", pid }), {
    status: 200,
  });
}

describe("worker client", () => {
  test("kickWorkerFast immediately wakes a compatible worker without spawning or polling readiness", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const timeoutCalls: number[] = [];
    const originalTimeout = AbortSignal.timeout;
    const fetchImpl = mock(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? "GET" });
      if (url.endsWith("/health")) {
        return healthResponse();
      }
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    const spawnImpl = mock(() => ({ unref: mock(() => {}) })) as unknown as typeof import("node:child_process").spawn;
    const setTimeoutImpl = mock(() => 0 as unknown as NodeJS.Timeout) as unknown as typeof setTimeout;

    (AbortSignal as typeof AbortSignal & {
      timeout: (ms: number) => AbortSignal;
    }).timeout = ((ms: number) => {
      timeoutCalls.push(ms);
      return new AbortController().signal;
    }) as typeof AbortSignal.timeout;

    try {
      await kickWorkerFast({
        fetchImpl,
        spawnImpl,
        setTimeoutImpl,
      });
    } finally {
      (AbortSignal as typeof AbortSignal & {
        timeout: typeof AbortSignal.timeout;
      }).timeout = originalTimeout;
    }

    expect(calls.map(({ url, method }) => ({ path: new URL(url).pathname, method }))).toEqual([
      { path: "/health", method: "GET" },
      { path: "/wake", method: "POST" },
    ]);
    expect(timeoutCalls).toEqual([3_000, 500]);
    expect(spawnImpl).not.toHaveBeenCalled();
    expect(setTimeoutImpl).not.toHaveBeenCalled();
  });

  test("kickWorkerFast immediately spawns once when the worker is down without waking or polling readiness", async () => {
    const fetchImpl = mock(async (input: string | URL) => {
      if (String(input).endsWith("/health")) {
        throw new Error("connection refused");
      }
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    const unref = mock(() => {});
    const spawnImpl = mock(() => ({ unref })) as unknown as typeof import("node:child_process").spawn;
    const setTimeoutImpl = mock(() => 0 as unknown as NodeJS.Timeout) as unknown as typeof setTimeout;

    await kickWorkerFast(
      {
        fetchImpl,
        spawnImpl,
        existsSyncImpl: () => true,
        setTimeoutImpl,
      },
      { CLAUDE_PLUGIN_ROOT: "/tmp/plugin-root" } as NodeJS.ProcessEnv,
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toEndWith("/health");
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    expect(spawnImpl.mock.calls[0]?.[0]).toBe("node");
    expect(spawnImpl.mock.calls[0]?.[1]).toEqual([
      "/tmp/plugin-root/scripts/bun-runner.js",
      "/tmp/plugin-root/scripts/worker.cjs",
    ]);
    expect(spawnImpl.mock.calls[0]?.[2]).toMatchObject({
      detached: true,
      stdio: "ignore",
    });
    expect(unref).toHaveBeenCalledTimes(1);
    expect(setTimeoutImpl).not.toHaveBeenCalled();
  });

  test("kickWorkerFast terminates a stale worker by reported pid then immediately spawns once", async () => {
    const fetchImpl = mock(async (input: string | URL) => {
      if (String(input).endsWith("/health")) {
        return staleHealthResponseWithPid(4321);
      }
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    const killImpl = mock(() => true) as unknown as typeof process.kill;
    const unref = mock(() => {});
    const spawnImpl = mock(() => ({ unref })) as unknown as typeof import("node:child_process").spawn;
    const setTimeoutImpl = mock(() => 0 as unknown as NodeJS.Timeout) as unknown as typeof setTimeout;

    await kickWorkerFast(
      {
        fetchImpl,
        killImpl,
        spawnImpl,
        existsSyncImpl: () => true,
        setTimeoutImpl,
      },
      { CLAUDE_PLUGIN_ROOT: "/tmp/plugin-root" } as NodeJS.ProcessEnv,
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toEndWith("/health");
    expect(killImpl).toHaveBeenCalledTimes(1);
    expect(killImpl).toHaveBeenCalledWith(4321, "SIGTERM");
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    expect(unref).toHaveBeenCalledTimes(1);
    expect(setTimeoutImpl).not.toHaveBeenCalled();
  });

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

  test("notifyWorkerWake waits for down after killing stale pid from health before spawning", async () => {
    let healthCallIndex = 0;
    let wakeCallCount = 0;
    let spawnHealthCallIndex: number | null = null;
    const stalePid = 4321;
    const pidPath = "/tmp/missing-worker.pid";
    const originalKill = process.kill;
    const killCalls: number[] = [];
    process.kill = ((pid: number | string) => {
      if (typeof pid === "number") {
        killCalls.push(pid);
      }
      return true;
    }) as typeof process.kill;
    const fetchImpl = mock(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith("/health")) {
        healthCallIndex += 1;
        spawnHealthCallIndex = Math.max(spawnHealthCallIndex, healthCallIndex);
        if (healthCallIndex === 1) {
          return staleHealthResponseWithPid(stalePid);
        }
        if (healthCallIndex === 2) {
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
    const spawnImpl = mock(() => {
      spawnHealthCallIndex = healthCallIndex;
      return { unref: mock(() => {}) };
    }) as unknown as typeof import("node:child_process").spawn;

    try {
      await notifyWorkerWake(
        {
          fetchImpl,
          spawnImpl,
          existsSyncImpl: (path: string) => path !== pidPath,
          pidPath,
          setTimeoutImpl: ((handler: TimerHandler) => {
            if (typeof handler === "function") handler();
            return 0 as unknown as NodeJS.Timeout;
          }) as typeof setTimeout,
        },
        { CLAUDE_PLUGIN_ROOT: "/tmp/plugin-root" } as NodeJS.ProcessEnv,
      );
    } finally {
      process.kill = originalKill;
    }

    expect(killCalls).toEqual([stalePid]);
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    expect(spawnHealthCallIndex).toBeGreaterThan(1);
    expect(wakeCallCount).toBe(1);
  });

  test("notifyWorkerWake falls back to worker.pid when stale health has no pid", async () => {
    const pidPath = "/tmp/worker-client-fallback.pid";
    writeFileSync(pidPath, "5678");
    let healthCallIndex = 0;
    let wakeCallCount = 0;
    let killedPid: number | null = null;
    const originalKill = process.kill;
    process.kill = ((pid: number | string) => {
      if (typeof pid === "number") {
        killedPid = pid;
      }
      return true;
    }) as typeof process.kill;
    const fetchImpl = mock(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith("/health")) {
        healthCallIndex += 1;
        if (healthCallIndex === 1) {
          return staleHealthResponse();
        }
        if (healthCallIndex === 2) {
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

    try {
      await notifyWorkerWake(
        {
          fetchImpl,
          spawnImpl,
          pidPath,
          existsSyncImpl: () => true,
          setTimeoutImpl: ((handler: TimerHandler) => {
            if (typeof handler === "function") handler();
            return 0 as unknown as NodeJS.Timeout;
          }) as typeof setTimeout,
        },
        { CLAUDE_PLUGIN_ROOT: "/tmp/plugin-root" } as NodeJS.ProcessEnv,
      );
    } finally {
      process.kill = originalKill;
      unlinkSync(pidPath);
    }

    expect(killedPid).toBe(5678);
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    expect(wakeCallCount).toBe(1);
  });

  test("notifyWorkerWake returns without spawning when stale has no pid handle", async () => {
    let wakeCallCount = 0;
    const errorCalls: string[] = [];
    const originalError = console.error;
    console.error = ((...args: unknown[]) => {
      errorCalls.push(String(args[0]));
    }) as typeof console.error;
    const fetchImpl = mock(async (input: string | URL) => {
      if (String(input).endsWith("/health")) {
        return staleHealthResponse();
      }
      if (String(input).endsWith("/wake")) {
        wakeCallCount += 1;
      }
      return new Response(null, { status: 200 });
    });
    const spawnImpl = mock(() => ({ unref: mock(() => {}) })) as unknown as typeof import("node:child_process").spawn;

    try {
      await notifyWorkerWake(
        {
          fetchImpl,
          spawnImpl,
          existsSyncImpl: () => false,
        },
        { CLAUDE_PLUGIN_ROOT: "/tmp/plugin-root" } as NodeJS.ProcessEnv,
      );
    } finally {
      console.error = originalError;
    }

    expect(spawnImpl).not.toHaveBeenCalled();
    expect(wakeCallCount).toBe(0);
    expect(errorCalls).toContain("stale worker detected but no pid handle is available");
  });

  test("notifyWorkerWake waits for compatible worker after killing stale, then sends /wake", async () => {
    let healthCallIndex = 0;
    let wakeCallCount = 0;
    const pidPath = "/tmp/missing-worker.pid";
    const fetchImpl = mock(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith("/health")) {
        healthCallIndex += 1;
        if (healthCallIndex === 1) {
          return staleHealthResponseWithPid(4321);
        }
        if (healthCallIndex === 2) {
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
        existsSyncImpl: (path: string) => path !== pidPath,
        pidPath,
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

  test("notifyWorkerWake does not spawn while stale worker remains non-down until timeout", async () => {
    let healthCallCount = 0;
    let wakeCallCount = 0;
    let killedPid: number | null = null;
    const pidPath = "/tmp/missing-worker.pid";
    const originalKill = process.kill;
    process.kill = ((pid: number | string) => {
      if (typeof pid === "number") {
        killedPid = pid;
      }
      return true;
    }) as typeof process.kill;
    const fetchImpl = mock(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith("/health")) {
        healthCallCount += 1;
        fakeNow += 10_000;
        return staleHealthResponseWithPid(24601);
      }
      if (url.endsWith("/wake")) {
        wakeCallCount += 1;
        return new Response(null, { status: 200 });
      }
      return new Response(null, { status: 404 });
    });
    const spawnImpl = mock(() => ({ unref: mock(() => {}) })) as unknown as typeof import("node:child_process").spawn;
    let fakeNow = 1_000;

    try {
      await notifyWorkerWake(
        {
          fetchImpl,
          spawnImpl,
          existsSyncImpl: (path: string) => path !== pidPath,
          pidPath,
          nowMsImpl: () => fakeNow,
          setTimeoutImpl: ((handler: TimerHandler) => {
            if (typeof handler === "function") handler();
            return 0 as unknown as NodeJS.Timeout;
          }) as typeof setTimeout,
        },
        { CLAUDE_PLUGIN_ROOT: "/tmp/plugin-root" } as NodeJS.ProcessEnv,
      );
    } finally {
      process.kill = originalKill;
    }

    expect(killedPid).toBe(24601);
    expect(healthCallCount).toBeGreaterThan(2);
    expect(spawnImpl).not.toHaveBeenCalled();
    expect(wakeCallCount).toBe(0);
  });

  test("notifyWorkerCompact waits for down after killing stale pid before spawning", async () => {
    let healthCallIndex = 0;
    let spawnHealthCallIndex: number | null = null;
    const stalePid = 9999;
    const pidPath = "/tmp/missing-worker.pid";
    const originalKill = process.kill;
    const killCalls: number[] = [];
    process.kill = ((pid: number | string) => {
      if (typeof pid === "number") {
        killCalls.push(pid);
      }
      return true;
    }) as typeof process.kill;
    const fetchImpl = mock(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith("/health")) {
        healthCallIndex += 1;
        if (healthCallIndex === 1) {
          return staleHealthResponseWithPid(stalePid);
        }
        if (healthCallIndex === 2) {
          throw new Error("connection refused");
        }
        return healthResponse();
      }
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    const spawnImpl = mock(() => {
      spawnHealthCallIndex = healthCallIndex;
      return { unref: mock(() => {}) };
    }) as unknown as typeof import("node:child_process").spawn;

    try {
      await notifyWorkerCompact(
        42,
        "content-session-42",
        "/tmp/session.jsonl",
        {
          fetchImpl,
          spawnImpl,
          existsSyncImpl: (path: string) => path !== pidPath,
          pidPath,
          setTimeoutImpl: ((handler: TimerHandler) => {
            if (typeof handler === "function") handler();
            return 0 as unknown as NodeJS.Timeout;
          }) as typeof setTimeout,
        },
        { CLAUDE_PLUGIN_ROOT: "/tmp/plugin-root" } as NodeJS.ProcessEnv,
      );
    } finally {
      process.kill = originalKill;
    }

    expect(killCalls).toEqual([stalePid]);
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    expect(spawnHealthCallIndex).toBeGreaterThan(1);
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
      "content-session-42",
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

  test("notifyWorkerCompact applies a 5s timeout only to the compact request", async () => {
    const originalTimeout = AbortSignal.timeout;
    let timeoutMs: number | null = null;

    (AbortSignal as typeof AbortSignal & {
      timeout: (ms: number) => AbortSignal;
    }).timeout = ((ms: number) => {
      timeoutMs = ms;
      return new AbortController().signal;
    }) as typeof AbortSignal.timeout;

    try {
      const fetchImpl = mock(async (input: string | URL) => {
        if (String(input).endsWith("/health")) {
          return healthResponse();
        }
        return new Response(null, { status: 200 });
      }) as typeof fetch;

      await notifyWorkerCompact(
        42,
        "content-session-42",
        "/tmp/session.jsonl",
        { fetchImpl, existsSyncImpl: () => true },
        { CLAUDE_PLUGIN_ROOT: "/tmp/plugin-root" } as NodeJS.ProcessEnv,
      );

      expect(timeoutMs).toBe(5_000);
    } finally {
      (AbortSignal as typeof AbortSignal & {
        timeout: typeof AbortSignal.timeout;
      }).timeout = originalTimeout;
    }
  });

  test("notifyWorkerFlush sends the env-bearing finish trigger when compatible", async () => {
    let flushCallCount = 0;
    const fetchImpl = mock(async (input: string | URL) => {
      if (String(input).endsWith("/health")) {
        return healthResponse();
      }
      if (String(input).endsWith("/trigger")) {
        flushCallCount += 1;
        return new Response(null, { status: 200 });
      }
      return new Response(null, { status: 404 });
    });

    await notifyWorkerFlush(
      42,
      "content-session-42",
      { fetchImpl, existsSyncImpl: () => true },
      { CLAUDE_PLUGIN_ROOT: "/tmp/plugin-root" } as NodeJS.ProcessEnv,
    );

    expect(flushCallCount).toBe(1);
    const flushCall = fetchImpl.mock.calls.find((call) => String(call[0]).endsWith("/trigger"));
    expect(JSON.parse(String(flushCall?.[1]?.body))).toEqual({
      action: "finish",
      content_session_id: "content-session-42",
      session_id: 42,
      env: {},
    });
  });

  test("notifyWorkerFlush waits for down after killing stale pid before spawning startup flush worker", async () => {
    let healthCallIndex = 0;
    let flushCallCount = 0;
    let spawnHealthCallIndex: number | null = null;
    const stalePid = 1357;
    const pidPath = "/tmp/missing-worker.pid";
    const originalKill = process.kill;
    const killCalls: number[] = [];
    process.kill = ((pid: number | string) => {
      if (typeof pid === "number") {
        killCalls.push(pid);
      }
      return true;
    }) as typeof process.kill;
    const fetchImpl = mock(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith("/health")) {
        healthCallIndex += 1;
        if (healthCallIndex === 1) {
          return staleHealthResponseWithPid(stalePid);
        }
        if (healthCallIndex === 2) {
          throw new Error("connection refused");
        }
        return healthResponse();
      }
      if (url.endsWith("/trigger")) {
        flushCallCount += 1;
        return new Response(null, { status: 200 });
      }
      return new Response(null, { status: 404 });
    });
    const spawnImpl = mock(() => {
      spawnHealthCallIndex = healthCallIndex;
      return { unref: mock(() => {}) };
    }) as unknown as typeof import("node:child_process").spawn;

    try {
      await notifyWorkerFlush(
        42,
        "content-session-42",
      {
        fetchImpl,
        spawnImpl,
        existsSyncImpl: (path: string) => path !== pidPath,
        pidPath,
        setTimeoutImpl: ((handler: TimerHandler) => {
          if (typeof handler === "function") handler();
          return 0 as unknown as NodeJS.Timeout;
        }) as typeof setTimeout,
        },
        { CLAUDE_PLUGIN_ROOT: "/tmp/plugin-root" } as NodeJS.ProcessEnv,
      );
    } finally {
      process.kill = originalKill;
    }

    expect(killCalls).toEqual([stalePid]);
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    expect(spawnHealthCallIndex).toBeGreaterThan(1);
    expect(flushCallCount).toBe(1);
  });

  test("notifyWorkerFlush starts a down worker then hands over env before finish", async () => {
    let healthCalls = 0;
    let triggerBody: Record<string, unknown> | null = null;
    const fetchImpl = mock(async (input: string | URL) => {
      if (String(input).endsWith("/health")) {
        healthCalls += 1;
        if (healthCalls === 1) {
          throw new Error("connection refused");
        }
        return healthResponse();
      }
      return new Response(null, { status: 200 });
    });
    const spawnImpl = mock(() => ({ unref: mock(() => {}) })) as unknown as typeof import("node:child_process").spawn;

    await notifyWorkerFlush(
      42,
      "content-session-42",
      {
        fetchImpl,
        spawnImpl,
        existsSyncImpl: () => true,
        setTimeoutImpl: ((handler: TimerHandler) => {
          if (typeof handler === "function") handler();
          return 0 as unknown as NodeJS.Timeout;
        }) as typeof setTimeout,
      },
      {
        CLAUDE_PLUGIN_ROOT: "/tmp/plugin-root",
        ANTHROPIC_API_KEY: "session-key",
      } as NodeJS.ProcessEnv,
    );

    expect(spawnImpl).toHaveBeenCalledTimes(1);
    const triggerCall = fetchImpl.mock.calls.find((call) => String(call[0]).endsWith("/trigger"));
    triggerBody = JSON.parse(String(triggerCall?.[1]?.body));
    expect(triggerBody).toEqual({
      action: "finish",
      content_session_id: "content-session-42",
      session_id: 42,
      env: { ANTHROPIC_API_KEY: "session-key" },
    });
  });

  test("notifyWorkerFlush returns without spawning when stale has no pid handle", async () => {
    const fetchImpl = mock(async (input: string | URL) => {
      if (String(input).endsWith("/health")) {
        return staleHealthResponse();
      }
      if (String(input).endsWith("/flush")) {
        return new Response(null, { status: 200 });
      }
      return new Response(null, { status: 404 });
    });
    const spawnImpl = mock(() => ({ unref: mock(() => {}) })) as unknown as typeof import("node:child_process").spawn;

    await notifyWorkerFlush(
      42,
      "content-session-42",
      {
        fetchImpl,
        spawnImpl,
        existsSyncImpl: () => false,
      },
      { CLAUDE_PLUGIN_ROOT: "/tmp/plugin-root" } as NodeJS.ProcessEnv,
    );

    expect(spawnImpl).not.toHaveBeenCalled();
    expect(fetchImpl.mock.calls.some((call) => String(call[0]).endsWith("/trigger"))).toBe(
      false,
    );
  });

  test("notifyWorkerFlush does not persist a startup hint when trigger is non-OK", async () => {
    const fetchImpl = mock(async (input: string | URL) => {
      if (String(input).endsWith("/health")) {
        return healthResponse();
      }
      if (String(input).endsWith("/trigger")) {
        return new Response("missing endpoint", { status: 404 });
      }
      return new Response(null, { status: 404 });
    });
    const spawnImpl = mock(() => ({ unref: mock(() => {}) })) as unknown as typeof import("node:child_process").spawn;

    await notifyWorkerFlush(
      42,
      "content-session-42",
      { fetchImpl, spawnImpl, existsSyncImpl: () => true },
      { CLAUDE_PLUGIN_ROOT: "/tmp/plugin-root" } as NodeJS.ProcessEnv,
    );

    expect(spawnImpl).not.toHaveBeenCalled();
  });

  test("notifyWorkerCompact throws a diagnostic error when stale has no pid handle", async () => {
    const fetchImpl = mock(async (input: string | URL) => {
      if (String(input).endsWith("/health")) {
        return staleHealthResponse();
      }
      return new Response(null, { status: 200 });
    });
    const spawnImpl = mock(() => ({ unref: mock(() => {}) })) as unknown as typeof import("node:child_process").spawn;

    await expect(
      notifyWorkerCompact(
        42,
        "content-session-42",
        "/tmp/session.jsonl",
        {
          fetchImpl,
          spawnImpl,
          existsSyncImpl: () => false,
        },
        { CLAUDE_PLUGIN_ROOT: "/tmp/plugin-root" } as NodeJS.ProcessEnv,
      ),
    ).rejects.toThrow("Stale worker detected but no pid handle is available for restart.");

    expect(spawnImpl).not.toHaveBeenCalled();
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
