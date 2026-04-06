type LoggerComponent = "HOOK" | "MCP" | "DB" | "MNEMOSYNE";
type LoggerLevel = "debug" | "info" | "warn" | "error";

function writeLog(
  level: LoggerLevel,
  component: LoggerComponent,
  message: string,
  context?: Record<string, unknown>,
): void {
  const payload = {
    timestamp: new Date().toISOString(),
    level,
    component,
    message,
    context: context ?? null,
  };

  process.stderr.write(`${JSON.stringify(payload)}\n`);
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
