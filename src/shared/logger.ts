import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { DATA_DIR } from "./paths";

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
): void {
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    component,
    message,
    context: context ?? null,
  });

  try {
    ensureLogDir();
    appendFileSync(LOG_PATH, `${line}\n`);
  } catch {
    // Fall back to stderr if file write fails
    process.stderr.write(`${line}\n`);
  }
}

export function createLogger(component: LoggerComponent) {
  return {
    debug(message: string, context?: Record<string, unknown>) {
      writeLog("debug", component, message, context);
    },
    info(message: string, context?: Record<string, unknown>) {
      writeLog("info", component, message, context);
    },
    warn(message: string, context?: Record<string, unknown>) {
      writeLog("warn", component, message, context);
    },
    error(message: string, context?: Record<string, unknown>) {
      writeLog("error", component, message, context);
    },
  };
}
