import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { DATA_DIR } from "./paths";
import {
  sanitizeLogValue,
  sanitizeSecretString,
  type SensitiveEnv,
} from "./error-sanitizer";

type LoggerComponent = "HOOK" | "MCP" | "DB" | "MNEMOSYNE";
type LoggerLevel = "debug" | "info" | "warn" | "error";

const LOG_PATH = join(DATA_DIR, "claude-mnemo.log");

let dirEnsured = false;

function ensureLogDir(): void {
  if (!dirEnsured) {
    mkdirSync(DATA_DIR, { recursive: true });
    dirEnsured = true;
  }
}

function writeLog(
  level: LoggerLevel,
  component: LoggerComponent,
  message: string,
  context?: Record<string, unknown>,
  sensitiveEnv: SensitiveEnv = process.env,
): void {
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    component,
    message: sanitizeSecretString(message, sensitiveEnv),
    context: context ? sanitizeLogValue(context, sensitiveEnv) : null,
  });

  try {
    ensureLogDir();
    appendFileSync(LOG_PATH, `${line}\n`);
  } catch {
    // Fall back to stderr if file write fails
    process.stderr.write(`${line}\n`);
  }
}

export interface CreateLoggerOptions {
  sensitiveEnv?: SensitiveEnv;
}

export function createLogger(
  component: LoggerComponent,
  options: CreateLoggerOptions = {},
) {
  const sensitiveEnv = options.sensitiveEnv ?? process.env;
  return {
    debug(message: string, context?: Record<string, unknown>) {
      writeLog("debug", component, message, context, sensitiveEnv);
    },
    info(message: string, context?: Record<string, unknown>) {
      writeLog("info", component, message, context, sensitiveEnv);
    },
    warn(message: string, context?: Record<string, unknown>) {
      writeLog("warn", component, message, context, sensitiveEnv);
    },
    error(message: string, context?: Record<string, unknown>) {
      writeLog("error", component, message, context, sensitiveEnv);
    },
  };
}
