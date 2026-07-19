import { describe, expect, mock, spyOn, test } from "bun:test";
import * as nodeFs from "node:fs";

import { createLogger } from "../../src/shared/logger";

describe("logger", () => {
  test("writes structured JSON lines via appendFileSync", () => {
    const appendSpy = spyOn(nodeFs, "appendFileSync").mockImplementation(
      () => {},
    );
    const mkdirSpy = spyOn(nodeFs, "mkdirSync").mockImplementation(
      () => undefined as any,
    );

    const log = createLogger("MNEMOSYNE");
    log.info("extraction complete", {
      hook: "stop",
      turns: 3,
      cacheHitPct: 87,
    });

    expect(appendSpy).toHaveBeenCalledTimes(1);

    const [filePath, content] = appendSpy.mock.calls[0] as [string, string];
    expect(filePath).toContain("claude-mnemo.log");

    const entry = JSON.parse(content.trim());
    expect(entry.level).toBe("info");
    expect(entry.component).toBe("MNEMOSYNE");
    expect(entry.message).toBe("extraction complete");
    expect(entry.context.hook).toBe("stop");
    expect(entry.context.turns).toBe(3);
    expect(entry.context.cacheHitPct).toBe(87);
    expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    appendSpy.mockRestore();
    mkdirSpy.mockRestore();
  });

  test("falls back to stderr when file write fails", () => {
    const appendSpy = spyOn(nodeFs, "appendFileSync").mockImplementation(
      () => {
        throw new Error("disk full");
      },
    );
    const mkdirSpy = spyOn(nodeFs, "mkdirSync").mockImplementation(
      () => undefined as any,
    );
    const stderrSpy = spyOn(process.stderr, "write").mockImplementation(
      () => true,
    );

    const log = createLogger("HOOK");
    log.error("something broke");

    expect(stderrSpy).toHaveBeenCalledTimes(1);
    const output = stderrSpy.mock.calls[0]?.[0] as string;
    const entry = JSON.parse(output.trim());
    expect(entry.level).toBe("error");
    expect(entry.message).toBe("something broke");

    appendSpy.mockRestore();
    mkdirSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  test("redacts snapshot secrets, URL userinfo, and structured header values", () => {
    const appendSpy = spyOn(nodeFs, "appendFileSync").mockImplementation(
      () => {},
    );
    const mkdirSpy = spyOn(nodeFs, "mkdirSync").mockImplementation(
      () => undefined as any,
    );
    const token = "sk-ant-logger-secret";
    const proxyPassword = "proxy-password-secret";
    const log = createLogger("MNEMOSYNE", {
      sensitiveEnv: {
        ANTHROPIC_AUTH_TOKEN: token,
        HTTPS_PROXY: `http://proxy-user:${proxyPassword}@proxy.example:8080`,
        ANTHROPIC_CUSTOM_HEADERS: "x-gateway-secret: custom-secret-value",
      },
    });

    log.error("remote failure", {
      error: {
        status: 400,
        body: `authorization: Bearer ${token}\ncookie: sid=${token}\n` +
          `proxy=http://proxy-user:${proxyPassword}@proxy.example:8080\n` +
          `x-gateway-secret: custom-secret-value`,
      },
    });

    const serialized = String(appendSpy.mock.calls[0]?.[1]);
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain(proxyPassword);
    expect(serialized).not.toContain("custom-secret-value");
    expect(serialized).toContain("[REDACTED]");

    appendSpy.mockRestore();
    mkdirSpy.mockRestore();
  });
});
