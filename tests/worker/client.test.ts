import { describe, expect, mock, test } from "bun:test";

import {
  notifyWorkerCompact,
  notifyWorkerWake,
  resolveWorkerScriptPaths,
  spawnWorkerProcess,
} from "../../src/worker/client";

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

  test("notifyWorkerWake waits for wake request success before resolving", async () => {
    let resolveWake!: (value: Response) => void;
    const wakeRequest = new Promise<Response>((resolve) => {
      resolveWake = resolve;
    });
    const fetchImpl = mock(async () => wakeRequest);
    const spawnImpl = mock(() => ({ unref: mock(() => {}) })) as unknown as typeof import("node:child_process").spawn;

    const wakePromise = notifyWorkerWake(
      {
        fetchImpl,
        spawnImpl,
        existsSyncImpl: () => true,
      },
      {
        CLAUDE_PLUGIN_ROOT: "/tmp/plugin-root",
      } as NodeJS.ProcessEnv,
    );

    let settled = false;
    void wakePromise.then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false);

    resolveWake(new Response(null, { status: 200 }));
    await wakePromise;
    expect(settled).toBe(true);
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  test("notifyWorkerWake spawns the worker before resolving when wake fails", async () => {
    let rejectWake!: (error: unknown) => void;
    const wakeRequest = new Promise<Response>((_, reject) => {
      rejectWake = reject;
    });
    const fetchImpl = mock(async () => wakeRequest);
    const spawnImpl = mock(() => ({ unref: mock(() => {}) })) as unknown as typeof import("node:child_process").spawn;

    const wakePromise = notifyWorkerWake(
      {
        fetchImpl,
        spawnImpl,
        existsSyncImpl: () => true,
      },
      {
        CLAUDE_PLUGIN_ROOT: "/tmp/plugin-root",
      } as NodeJS.ProcessEnv,
    );

    rejectWake(new Error("wake failed"));
    await wakePromise;

    expect(spawnImpl).toHaveBeenCalledTimes(1);
  });

  test("notifyWorkerCompact waits for readiness after spawning a missing worker", async () => {
    const fetchImpl = mock(async (input: string | URL) => {
      if (String(input).endsWith("/health")) {
        fetchImpl.healthCount = (fetchImpl.healthCount ?? 0) + 1;
        if (fetchImpl.healthCount === 1) {
          throw new Error("not ready");
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }

      return new Response(null, { status: 200 });
    }) as typeof fetch & { healthCount?: number };
    const spawnImpl = mock(() => ({ unref: mock(() => {}) })) as unknown as typeof import("node:child_process").spawn;

    await notifyWorkerCompact(
      42,
      "/tmp/session.jsonl",
      {
        fetchImpl,
        spawnImpl,
        existsSyncImpl: () => true,
        setTimeoutImpl: ((handler: TimerHandler) => {
          if (typeof handler === "function") {
            handler();
          }
          return 0 as unknown as NodeJS.Timeout;
        }) as typeof setTimeout,
      },
      {
        CLAUDE_PLUGIN_ROOT: "/tmp/plugin-root",
      } as NodeJS.ProcessEnv,
    );

    expect(spawnImpl).toHaveBeenCalledTimes(1);
    const compactCall = fetchImpl.mock.calls.find((call) =>
      String(call[0]).endsWith("/compact"),
    );
    expect(compactCall).toBeDefined();
    expect(JSON.parse(String(compactCall?.[1]?.body))).toEqual({
      session_id: 42,
      transcript_path: "/tmp/session.jsonl",
    });
  });
});
