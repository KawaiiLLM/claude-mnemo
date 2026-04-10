import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import {
  HOOK_HEALTH_TIMEOUT_MS,
  HOOK_READINESS_TIMEOUT_MS,
} from "../shared/hook-constants";

const WORKER_PORT = 37778;
const WORKER_BASE_URL = `http://127.0.0.1:${WORKER_PORT}`;
const WAKE_TIMEOUT_MS = 500;
const COMPACT_TIMEOUT_MS = 25_000;

export interface WorkerClientDeps {
  fetchImpl?: typeof fetch;
  spawnImpl?: typeof spawn;
  existsSyncImpl?: typeof existsSync;
  setTimeoutImpl?: typeof setTimeout;
}

function createAbortSignal(timeoutMs: number): AbortSignal {
  return AbortSignal.timeout(timeoutMs);
}

function sleep(
  ms: number,
  setTimeoutImpl: typeof setTimeout = setTimeout,
): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeoutImpl(resolvePromise, ms);
  });
}

function resolvePluginRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CLAUDE_PLUGIN_ROOT && env.CLAUDE_PLUGIN_ROOT.trim() !== "") {
    return env.CLAUDE_PLUGIN_ROOT;
  }

  const currentDir = dirname(__filename);

  if (currentDir.endsWith("/plugin/scripts") || currentDir.endsWith("\\plugin\\scripts")) {
    return resolve(currentDir, "..");
  }

  return resolve(currentDir, "..", "..", "plugin");
}

export function resolveWorkerScriptPaths(
  env: NodeJS.ProcessEnv = process.env,
): { bunRunnerPath: string; workerPath: string } {
  const pluginRoot = resolvePluginRoot(env);
  return {
    bunRunnerPath: join(pluginRoot, "scripts", "bun-runner.js"),
    workerPath: join(pluginRoot, "scripts", "worker.cjs"),
  };
}

async function isWorkerHealthy(
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<boolean> {
  try {
    const response = await fetchImpl(`${WORKER_BASE_URL}/health`, {
      method: "GET",
      signal: createAbortSignal(timeoutMs),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export function spawnWorkerProcess(
  deps: WorkerClientDeps = {},
  env: NodeJS.ProcessEnv = process.env,
): void {
  const spawnImpl = deps.spawnImpl ?? spawn;
  const existsSyncImpl = deps.existsSyncImpl ?? existsSync;
  const { bunRunnerPath, workerPath } = resolveWorkerScriptPaths(env);

  if (!existsSyncImpl(bunRunnerPath) || !existsSyncImpl(workerPath)) {
    return;
  }

  const child = spawnImpl("node", [bunRunnerPath, workerPath], {
    detached: true,
    stdio: "ignore",
    env,
  });
  child.unref();
}

export async function notifyWorkerWake(
  deps: WorkerClientDeps = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  void (async () => {
    try {
      await fetchImpl(`${WORKER_BASE_URL}/wake`, {
        method: "POST",
        body: "{}",
        signal: createAbortSignal(WAKE_TIMEOUT_MS),
      });
    } catch {
      spawnWorkerProcess(deps, env);
    }
  })();
}

async function waitForWorkerReadiness(
  deps: WorkerClientDeps = {},
): Promise<boolean> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const setTimeoutImpl = deps.setTimeoutImpl ?? setTimeout;
  const startedAt = Date.now();

  while (Date.now() - startedAt < HOOK_READINESS_TIMEOUT_MS) {
    if (await isWorkerHealthy(fetchImpl, HOOK_HEALTH_TIMEOUT_MS)) {
      return true;
    }
    await sleep(100, setTimeoutImpl);
  }

  return false;
}

export async function notifyWorkerCompact(
  sessionDbId: number,
  transcriptPath: string | undefined,
  deps: WorkerClientDeps = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const fetchImpl = deps.fetchImpl ?? fetch;

  if (!(await isWorkerHealthy(fetchImpl, HOOK_HEALTH_TIMEOUT_MS))) {
    spawnWorkerProcess(deps, env);
    const ready = await waitForWorkerReadiness(deps);
    if (!ready) {
      throw new Error("Worker did not become ready before compact request.");
    }
  }

  const response = await fetchImpl(`${WORKER_BASE_URL}/compact`, {
    method: "POST",
    body: JSON.stringify({
      session_id: sessionDbId,
      transcript_path: transcriptPath ?? null,
    }),
    signal: createAbortSignal(COMPACT_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Worker compact request failed with status ${response.status}.`);
  }
}
