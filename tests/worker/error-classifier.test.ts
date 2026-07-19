import { describe, expect, test } from "bun:test";

import {
  classifyWorkerError,
  createWorkerAbortError,
} from "../../src/worker/error-classifier";

describe("classifyWorkerError", () => {
  test("classifies SDK and platform connection failures as connection errors", () => {
    class APIConnectionError extends Error {}

    const codedErrors = [
      "ECONNRESET",
      "ENOTFOUND",
      "ETIMEDOUT",
      "EAI_AGAIN",
    ].map((code) => Object.assign(new Error(code), { code }));

    const errors = [
      new APIConnectionError("Connection error."),
      ...codedErrors,
      new TypeError("fetch failed"),
      new Error("request wrapper", { cause: codedErrors[0] }),
    ];

    for (const error of errors) {
      expect(classifyWorkerError(error)).toBe("connection");
    }
  });

  test("classifies marked stall and shutdown aborts as connection errors", () => {
    expect(classifyWorkerError(createWorkerAbortError("stall-watchdog"))).toBe(
      "connection",
    );
    expect(classifyWorkerError(createWorkerAbortError("shutdown"))).toBe(
      "connection",
    );
  });

  test("classifies agent stream api_error and server_error signals as connection errors", () => {
    expect(
      classifyWorkerError({
        type: "system",
        subtype: "api_error",
        error: new Error("Connection error."),
      }),
    ).toBe("connection");
    expect(
      classifyWorkerError({
        type: "assistant",
        error: "server_error",
        message: { content: [] },
      }),
    ).toBe("connection");
  });

  test("classifies retryable status before the deterministic status fallthrough", () => {
    const statusError = Object.assign(new Error("API status 503"), {
      name: "APIError",
      status: 503,
    });

    expect(classifyWorkerError(statusError)).toBe("connection");
  });

  test("conservatively classifies derailment, abort, and unknown errors as deterministic", () => {
    expect(classifyWorkerError(new Error("derailment floor"))).toBe(
      "deterministic",
    );
    expect(
      classifyWorkerError(
        Object.assign(new Error("aborted"), { name: "AbortError" }),
      ),
    ).toBe("deterministic");
    expect(classifyWorkerError(new Error("something unexpected"))).toBe(
      "deterministic",
    );
    expect(
      classifyWorkerError({
        type: "assistant",
        error: "unknown",
        message: { content: [] },
      }),
    ).toBe("deterministic");
    expect(classifyWorkerError("not even an Error")).toBe("deterministic");
  });
});
