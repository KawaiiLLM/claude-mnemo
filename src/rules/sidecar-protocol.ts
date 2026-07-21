import { randomUUID } from "node:crypto";
import {
  linkSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { stripPrivateTags } from "../shared/tag-stripping";

const INPUT_SUMMARY_LIMIT = 200;
const SIDECAR_LOCK_WAIT_MS = 5_000;
const lockWaitArray = new Int32Array(new SharedArrayBuffer(4));

interface SidecarLockOwner {
  pid: number;
  token: string;
}

export interface HitSidecarLockOptions {
  waitMs?: number;
}

function isErrorCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as Error & { code?: string }).code === code
  );
}

export function resolveHitSidecarLockPath(dataRoot: string): string {
  return join(dataRoot, "rules", "hits.lock");
}

export function summarizeToolInput(value: unknown): string {
  const serialized =
    typeof value === "string" ? value : JSON.stringify(value) ?? "null";
  return Array.from(stripPrivateTags(serialized))
    .slice(0, INPUT_SUMMARY_LIMIT)
    .join("");
}

function readLockOwner(path: string): SidecarLockOwner | null {
  try {
    const value = JSON.parse(
      readFileSync(path, "utf8"),
    ) as Partial<SidecarLockOwner>;
    return Number.isInteger(value.pid) &&
      value.pid! > 0 &&
      typeof value.token === "string"
      ? { pid: value.pid!, token: value.token }
      : null;
  } catch {
    return null;
  }
}

function ownerIsAlive(owner: SidecarLockOwner | null): boolean {
  if (!owner) return true;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    return !isErrorCode(error, "ESRCH");
  }
}

/** Call only while the caller holds the ingestion DB write transaction. */
export function recoverDeadHitSidecarLock(dataRoot: string): boolean {
  const path = resolveHitSidecarLockPath(dataRoot);
  const owner = readLockOwner(path);
  if (ownerIsAlive(owner)) return false;
  try {
    unlinkSync(path);
    return true;
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return false;
    throw error;
  }
}

export function withHitSidecarLock<T>(
  dataRoot: string,
  operation: () => T,
  options: HitSidecarLockOptions = {},
): T {
  const path = resolveHitSidecarLockPath(dataRoot);
  mkdirSync(dirname(path), { recursive: true });
  const waitMs = options.waitMs ?? SIDECAR_LOCK_WAIT_MS;
  if (!Number.isFinite(waitMs) || waitMs < 0) {
    throw new Error("waitMs must be a non-negative finite number");
  }
  const owner = { pid: process.pid, token: randomUUID() };
  const temporary = `${path}.${owner.pid}.${owner.token}.tmp`;
  writeFileSync(temporary, JSON.stringify(owner), { mode: 0o600 });
  const deadline = performance.now() + waitMs;
  let acquired = false;
  try {
    while (performance.now() <= deadline) {
      try {
        linkSync(temporary, path);
        acquired = true;
        break;
      } catch (error) {
        if (!isErrorCode(error, "EEXIST")) throw error;
        Atomics.wait(lockWaitArray, 0, 0, 1);
      }
    }
    if (!acquired) {
      throw new Error("timed out waiting for the hit sidecar lock");
    }

    return operation();
  } finally {
    try {
      unlinkSync(temporary);
    } catch (error) {
      if (!isErrorCode(error, "ENOENT")) throw error;
    }
    if (acquired && readLockOwner(path)?.token === owner.token) {
      try {
        unlinkSync(path);
      } catch (error) {
        if (!isErrorCode(error, "ENOENT")) throw error;
      }
    }
  }
}
