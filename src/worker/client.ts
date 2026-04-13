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

interface WorkerHealthBody {
  ok?: boolean;
  buildId?: string;
  pid?: number;
}

type WorkerHealthState =
  | { status: "compatible"; pid?: number }
  | { status: "stale"; pid?: number }
  | { status: "down" };

async function readWorkerHealth(
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<WorkerHealthState> {
  try {
    const response = await fetchImpl(`${WORKER_BASE_URL}/health`, {
      method: "GET",
      signal: createAbortSignal(timeoutMs),
    });

    if (!response.ok) {
      return { status: "down" };
    }

    let body: WorkerHealthBody;
    try {
      body = (await response.json()) as WorkerHealthBody;
    } catch {
      return { status: "compatible" };
    }

    if (body.buildId && body.buildId !== BUILD_ID) {
      return {
        status: "stale",
        pid: typeof body.pid === "number" && body.pid > 0 ? body.pid : undefined,
      };
    }

    return {
      status: "compatible",
      pid: typeof body.pid === "number" && body.pid > 0 ? body.pid : undefined,
    };
  } catch {
    return { status: "down" };
  }
}

function readWorkerPidFallback(deps: WorkerClientDeps = {}): number | null {
  const pidPath = deps.pidPath ?? WORKER_PID_PATH;
  const existsSyncImpl = deps.existsSyncImpl ?? existsSync;

  if (!existsSyncImpl(pidPath)) {
    return null;
  }

  try {
    const pid = Number(readFileSync(pidPath, "utf8").trim());
    if (Number.isInteger(pid) && pid > 0) {
      return pid;
    }
  } catch {
    // Ignore unreadable or invalid pid files.
  }

  return null;
}

function killWorkerPid(pid: number): void {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // If the worker is already gone or we lack permission, continue.
  }
}

function logUnrecoverableStaleWorker(): void {
  console.error("stale worker detected but no pid handle is available");
}

function resolveStaleWorkerPid(
  health: WorkerHealthState,
  deps: WorkerClientDeps = {},
): number | null {
  if (health.status !== "stale") {
    return null;
  }

  if (typeof health.pid === "number") {
    return health.pid;
  }

  return readWorkerPidFallback(deps);
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

async function waitForWorkerDown(
  deps: WorkerClientDeps = {},
): Promise<boolean> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const setTimeoutImpl = deps.setTimeoutImpl ?? setTimeout;
  const nowMs = deps.nowMsImpl ?? Date.now;
  const startedAt = nowMs();

  while (nowMs() - startedAt < HOOK_READINESS_TIMEOUT_MS) {
    const health = await readWorkerHealth(fetchImpl, HOOK_HEALTH_TIMEOUT_MS);
    if (health.status === "down") {
      return true;
    }
    await sleep(100, setTimeoutImpl);
  }

  return false;
}

async function waitForCompatibleWorker(
  deps: WorkerClientDeps = {},
): Promise<boolean> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const setTimeoutImpl = deps.setTimeoutImpl ?? setTimeout;
  const nowMs = deps.nowMsImpl ?? Date.now;
  const startedAt = nowMs();

  while (nowMs() - startedAt < HOOK_READINESS_TIMEOUT_MS) {
    const health = await readWorkerHealth(fetchImpl, HOOK_HEALTH_TIMEOUT_MS);
    if (health.status === "compatible") {
      return true;
    }
    await sleep(100, setTimeoutImpl);
  }

  return false;
}

type WorkerAvailability = "compatible" | "down" | "unrecoverable-stale";

async function ensureCompatibleWorker(
  deps: WorkerClientDeps = {},
): Promise<WorkerAvailability> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const health = await readWorkerHealth(fetchImpl, HOOK_HEALTH_TIMEOUT_MS);

  if (health.status === "compatible") {
    return "compatible";
  }

  if (health.status === "down") {
    return "down";
  }

  const pid = resolveStaleWorkerPid(health, deps);
  if (!pid) {
    return "unrecoverable-stale";
  }

  killWorkerPid(pid);
  if (!(await waitForWorkerDown(deps))) {
    return "unrecoverable-stale";
  }

  return "down";
}

export async function notifyWorkerWake(
  deps: WorkerClientDeps = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const status = await ensureCompatibleWorker(deps);

  if (status === "unrecoverable-stale") {
    logUnrecoverableStaleWorker();
    return;
  }

  if (status === "down") {
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

  const status = await ensureCompatibleWorker(deps);

  if (status === "unrecoverable-stale") {
    logUnrecoverableStaleWorker();
    return;
  }

  if (status === "down") {
    spawnWorkerProcess(deps, flushEnv);
    return;
  }

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
  } catch {
    // Fall through to a startup-flush worker spawn.
  }

  spawnWorkerProcess(deps, flushEnv);
}

export async function notifyWorkerCompact(
  sessionDbId: number,
  transcriptPath: string | undefined,
  deps: WorkerClientDeps = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const status = await ensureCompatibleWorker(deps);

  if (status === "unrecoverable-stale") {
    logUnrecoverableStaleWorker();
    throw new Error("Stale worker detected but no pid handle is available for restart.");
  }

  if (status === "down") {
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
