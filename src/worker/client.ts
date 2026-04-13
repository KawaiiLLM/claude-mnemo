import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { BUILD_ID } from "../shared/build-id";
import {
  HOOK_HEALTH_TIMEOUT_MS,
  HOOK_READINESS_TIMEOUT_MS,
} from "../shared/hook-constants";
import { WORKER_PID_PATH } from "../shared/paths";

const WORKER_PORT = 37778;
const WORKER_BASE_URL = `http://127.0.0.1:${WORKER_PORT}`;
const WAKE_TIMEOUT_MS = 500;
const FLUSH_TIMEOUT_MS = 500;
const COMPACT_TIMEOUT_MS = 5_000;

export interface WorkerClientDeps {
  fetchImpl?: typeof fetch;
  spawnImpl?: typeof spawn;
  existsSyncImpl?: typeof existsSync;
  setTimeoutImpl?: typeof setTimeout;
  nowMsImpl?: () => number;
  pidPath?: string;
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

async function isWorkerCompatible(
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<"compatible" | "stale" | "down"> {
  try {
    const response = await fetchImpl(`${WORKER_BASE_URL}/health`, {
      method: "GET",
      signal: createAbortSignal(timeoutMs),
    });

    if (!response.ok) {
      return "down";
    }

    let body: { ok?: boolean; buildId?: string };
    try {
      body = (await response.json()) as { ok?: boolean; buildId?: string };
    } catch {
      return "compatible";
    }

    if (body.buildId && body.buildId !== BUILD_ID) {
      return "stale";
    }

    return "compatible";
  } catch {
    return "down";
  }
}

function killStaleWorker(deps: WorkerClientDeps = {}): void {
  const pidPath = deps.pidPath ?? WORKER_PID_PATH;
  const existsSyncImpl = deps.existsSyncImpl ?? existsSync;

  if (!existsSyncImpl(pidPath)) {
    return;
  }

  try {
    const pid = Number(readFileSync(pidPath, "utf8").trim());

    if (Number.isInteger(pid) && pid > 0) {
      process.kill(pid, "SIGTERM");
    }
  } catch {
    // Process already gone or permission error — either way, proceed
  }
  // Do NOT remove the PID file here. The new worker overwrites it on startup.
  // If the old process survives SIGTERM, the file remains as a handle for retry.
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

  const status = await isWorkerCompatible(fetchImpl, HOOK_HEALTH_TIMEOUT_MS);

  if (status === "stale") {
    killStaleWorker(deps);
    await sleep(300, deps.setTimeoutImpl ?? setTimeout);
    spawnWorkerProcess(deps, env);
    if (!(await waitForCompatibleWorker(deps))) {
      return;
    }
  } else if (status === "down") {
    spawnWorkerProcess(deps, env);
    if (!(await waitForCompatibleWorker(deps))) {
      return;
    }
  }

  try {
    await fetchImpl(`${WORKER_BASE_URL}/wake`, {
      method: "POST",
      body: "{}",
      signal: createAbortSignal(WAKE_TIMEOUT_MS),
    });
  } catch {
    spawnWorkerProcess(deps, env);
  }
}

export async function notifyWorkerFlush(
  sessionDbId: number,
  deps: WorkerClientDeps = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const flushEnv = {
    ...env,
    CLAUDE_MNEMO_FLUSH_SESSION_ID: String(sessionDbId),
  } satisfies NodeJS.ProcessEnv;

  try {
    const response = await fetchImpl(`${WORKER_BASE_URL}/flush`, {
      method: "POST",
      body: JSON.stringify({
        session_id: sessionDbId,
      }),
      signal: createAbortSignal(FLUSH_TIMEOUT_MS),
    });

    if (response.ok) {
      return;
    }

    killStaleWorker(deps);
  } catch {
    // Fall through to a startup-flush worker spawn.
  }

  spawnWorkerProcess(deps, flushEnv);
}

async function waitForCompatibleWorker(
  deps: WorkerClientDeps = {},
): Promise<boolean> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const setTimeoutImpl = deps.setTimeoutImpl ?? setTimeout;
  const nowMs = deps.nowMsImpl ?? Date.now;
  const startedAt = nowMs();

  while (nowMs() - startedAt < HOOK_READINESS_TIMEOUT_MS) {
    const status = await isWorkerCompatible(fetchImpl, HOOK_HEALTH_TIMEOUT_MS);
    if (status === "compatible") {
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

  const status = await isWorkerCompatible(fetchImpl, HOOK_HEALTH_TIMEOUT_MS);

  if (status === "stale") {
    killStaleWorker(deps);
    await sleep(300, deps.setTimeoutImpl ?? setTimeout);
  }

  if (status !== "compatible") {
    spawnWorkerProcess(deps, env);
    const ready = await waitForCompatibleWorker(deps);
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
