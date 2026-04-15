import { describe, expect, test } from "bun:test";

import { detectCacheTtl, detectCacheTtlFromLines } from "../../src/worker/cache-ttl";

describe("worker cache ttl detection", () => {
  test("detectCacheTtlFromLines returns 5m when ephemeral_5m_input_tokens is present", () => {
    expect(
      detectCacheTtlFromLines([
        JSON.stringify({
          message: {
            usage: {
              cache_creation: {
                ephemeral_5m_input_tokens: 123,
                ephemeral_1h_input_tokens: 0,
              },
            },
          },
        }),
      ]),
    ).toBe(300_000);
  });

  test("detectCacheTtlFromLines returns 1h when ephemeral_1h_input_tokens is present", () => {
    expect(
      detectCacheTtlFromLines([
        JSON.stringify({
          message: {
            usage: {
              cache_creation: {
                ephemeral_5m_input_tokens: 0,
                ephemeral_1h_input_tokens: 456,
              },
            },
          },
        }),
      ]),
    ).toBe(3_600_000);
  });

  test("detectCacheTtl keeps prior state when the transcript file is missing", async () => {
    expect(await detectCacheTtl("missing-session", "/tmp/definitely-missing-project")).toBeNull();
  });

  test("detectCacheTtl reads the worker top-level transcript path", async () => {
    expect(
      await detectCacheTtl("agent-session", "/tmp/project", 30, {
        resolveTranscriptPathImpl: (_projectPath, _agentSessionId) =>
          "/tmp/fake-transcript.jsonl",
        existsSyncImpl: (path) => path === "/tmp/fake-transcript.jsonl",
        readFileSyncImpl: (path) => {
          expect(path).toBe("/tmp/fake-transcript.jsonl");
          return [
            JSON.stringify({
              message: {
                usage: {
                  cache_creation: {
                    ephemeral_5m_input_tokens: 0,
                    ephemeral_1h_input_tokens: 42,
                  },
                },
              },
            }),
          ].join("\n");
        },
      }),
    ).toBe(3_600_000);
  });
});
