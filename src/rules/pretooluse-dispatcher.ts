import {
  closeSync,
  constants,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";

import type { HookHandler, NormalizedHookInput } from "../hooks/types";
import { DATA_DIR } from "../shared/paths";
import {
  TRIGGER_INDEX_SLOT_LIMIT,
  triggerIndexSchema,
  type TriggerIndex,
  type TriggerSpec,
} from "./schema";
import { withHitSidecarLock } from "./sidecar-protocol";

const EVENT_HIT_LIMIT = 2;
const SESSION_LOCK_WAIT_MS = 35;
const STALE_SESSION_LOCK_MS = 30_000;
const lockWaitArray = new Int32Array(new SharedArrayBuffer(4));

export interface PreToolUseDispatcherDependencies {
  dataRoot?: string;
  nowMs?: () => number;
  randomUuid?: () => string;
}

interface SessionRuleState {
  version: 1;
  rule_ids: number[];
}

interface PromptHit {
  hit_id: string;
  content_session_id: string;
  event_type: "UserPromptSubmit";
  ts_ms: number;
  rule_id: number;
  prompt_summary: string;
}

type DispatcherHit = PromptHit;
/**
 * The one event mnemo dispatches from (裁决 22/23, ticket 15).
 *
 * `PreToolUse`/`PostToolUse` dispatchers used to exist here unregistered, and
 * `kind:"tool"` / `kind:"result"` rules were matched by them. Both were removed
 * with the rest of the tool-adjacent injection surface: a dispatcher's only
 * output is `additionalContext`, and Claude Code renders the tool-adjacent
 * events' context as a floating attachment re-rendered at request assembly,
 * which rewrites the previous turn's tail and destroys the message-side cache
 * breakpoint. The trigger VOCABULARY keeps both kinds — the rules subsystem's
 * schema, digest and authoring tool still speak them, and retiring those is a
 * separate decision — they simply have no delivery channel.
 */
type DispatcherEvent = "UserPromptSubmit";

export function resolveTriggerIndexPath(dataRoot = DATA_DIR): string {
  return join(dataRoot, "rules", "trigger-index.json");
}

export function resolveSessionStateDirectory(dataRoot = DATA_DIR): string {
  return join(dataRoot, "rules", "session-state");
}

function localDate(tsMs: number): string {
  const date = new Date(tsMs);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function resolveHitSidecarPath(
  dataRoot = DATA_DIR,
  tsMs = Date.now(),
): string {
  return join(dataRoot, "rules", `hits-${localDate(tsMs)}.jsonl`);
}

function sessionStatePath(dataRoot: string, sessionId: string): string {
  const digest = createHash("sha256").update(sessionId).digest("hex");
  return join(resolveSessionStateDirectory(dataRoot), `${digest}.json`);
}

function readIndex(dataRoot: string): TriggerIndex | undefined {
  try {
    return triggerIndexSchema.parse(
      JSON.parse(readFileSync(resolveTriggerIndexPath(dataRoot), "utf8")),
    );
  } catch {
    return undefined;
  }
}

function readState(dataRoot: string, sessionId: string): Set<number> {
  try {
    const parsed = JSON.parse(
      readFileSync(sessionStatePath(dataRoot, sessionId), "utf8"),
    ) as Partial<SessionRuleState>;
    if (parsed.version !== 1 || !Array.isArray(parsed.rule_ids)) return new Set();
    return new Set(
      parsed.rule_ids.filter(
        (id): id is number => Number.isInteger(id) && id > 0,
      ),
    );
  } catch {
    return new Set();
  }
}

function writeState(
  dataRoot: string,
  sessionId: string,
  ruleIds: ReadonlySet<number>,
): void {
  const path = sessionStatePath(dataRoot, sessionId);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(
    temporary,
    `${JSON.stringify({
      version: 1,
      rule_ids: [...ruleIds].sort((left, right) => left - right),
    } satisfies SessionRuleState)}\n`,
    { mode: 0o600 },
  );
  renameSync(temporary, path);
}

function acquireSessionLock(
  dataRoot: string,
  sessionId: string,
): { descriptor: number; path: string } | undefined {
  const statePath = sessionStatePath(dataRoot, sessionId);
  mkdirSync(dirname(statePath), { recursive: true });
  const path = `${statePath}.lock`;
  const deadline = performance.now() + SESSION_LOCK_WAIT_MS;
  while (performance.now() <= deadline) {
    try {
      return {
        descriptor: openSync(
          path,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
          0o600,
        ),
        path,
      };
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "EEXIST"
      ) {
        throw error;
      }
      try {
        if (Date.now() - statSync(path).mtimeMs > STALE_SESSION_LOCK_MS) {
          unlinkSync(path);
          continue;
        }
      } catch {
        continue;
      }
      Atomics.wait(lockWaitArray, 0, 0, 1);
    }
  }
  return undefined;
}

function releaseSessionLock(lock: { descriptor: number; path: string }): void {
  closeSync(lock.descriptor);
  try {
    unlinkSync(lock.path);
  } catch {
    // A stale-lock recovery may already have removed it.
  }
}

function appendHits(path: string, hits: DispatcherHit[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const descriptor = openSync(
    path,
    constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY,
    0o600,
  );
  try {
    writeFileSync(
      descriptor,
      `${hits.map((hit) => JSON.stringify(hit)).join("\n")}\n`,
    );
  } finally {
    closeSync(descriptor);
  }
}

function promptTriggerMatches(
  trigger: Extract<TriggerSpec, { kind: "prompt" }>,
  prompt: string,
): boolean {
  const normalizedPrompt = prompt.toLowerCase();
  const matches = trigger.keywords.map((keyword) =>
    normalizedPrompt.includes(keyword.toLowerCase()),
  );
  return trigger.match === "all" ? matches.every(Boolean) : matches.some(Boolean);
}

function triggerMatches(
  trigger: TriggerSpec,
  input: NormalizedHookInput,
): boolean {
  return (
    trigger.kind === "prompt" &&
    promptTriggerMatches(trigger, input.prompt ?? "")
  );
}

function hasRequiredIdentity(input: NormalizedHookInput): boolean {
  return Boolean(input.sessionId && input.cwd && input.prompt);
}

function summarizePrompt(prompt: string): string {
  return Array.from(prompt).slice(0, 200).join("");
}

function createHits(
  input: NormalizedHookInput,
  ruleIds: number[],
  timestamp: number,
  randomUuid: () => string,
): DispatcherHit[] {
  return ruleIds.map((ruleId) => ({
    hit_id: randomUuid(),
    content_session_id: input.sessionId!,
    event_type: "UserPromptSubmit" as const,
    ts_ms: timestamp,
    rule_id: ruleId,
    prompt_summary: summarizePrompt(input.prompt!),
  }));
}

function createDispatcher(
  eventName: DispatcherEvent,
  dependencies: PreToolUseDispatcherDependencies,
): HookHandler {
  const dataRoot = dependencies.dataRoot ?? DATA_DIR;
  const nowMs = dependencies.nowMs ?? Date.now;
  const randomUuid = dependencies.randomUuid ?? randomUUID;

  return (input) => {
    if (input.eventName !== eventName || !hasRequiredIdentity(input)) {
      return { continue: true };
    }
    const index = readIndex(dataRoot);
    if (!index) return { continue: true };

    const project = resolve(input.cwd!);
    const candidates = index.rules
      .filter(
        (rule) => rule.scope === "global" || resolve(rule.scope) === project,
      )
      .slice(0, TRIGGER_INDEX_SLOT_LIMIT)
      .filter((rule) => triggerMatches(rule.trigger, input));
    if (candidates.length === 0) return { continue: true };

    const lock = acquireSessionLock(dataRoot, input.sessionId!);
    if (!lock) return { continue: true };
    try {
      const pushed = readState(dataRoot, input.sessionId!);
      const matches = candidates
        .filter((rule) => !pushed.has(rule.id))
        .slice(0, EVENT_HIT_LIMIT);
      if (matches.length === 0) return { continue: true };

      const timestamp = nowMs();
      const hits = createHits(
        input,
        matches.map((rule) => rule.id),
        timestamp,
        randomUuid,
      );
      const previousPushed = new Set(pushed);
      for (const rule of matches) pushed.add(rule.id);
      writeState(dataRoot, input.sessionId!, pushed);
      try {
        withHitSidecarLock(
          dataRoot,
          () => appendHits(resolveHitSidecarPath(dataRoot, timestamp), hits),
          { waitMs: 35 },
        );
      } catch (error) {
        writeState(dataRoot, input.sessionId!, previousPushed);
        throw error;
      }

      return {
        continue: true,
        hookSpecificOutput: `## Mnemo Tips\n${matches
          .map((rule) => `- ${rule.claim}`)
          .join("\n")}`,
      };
    } finally {
      releaseSessionLock(lock);
    }
  };
}

export function createUserPromptSubmitDispatcher(
  dependencies: PreToolUseDispatcherDependencies = {},
): HookHandler {
  return createDispatcher("UserPromptSubmit", dependencies);
}
