import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import type { BlindPair } from "../../src/metrics/p1/blind-pairs";
import { toJsonl } from "../../src/metrics/p1/blind-pairs";
import { judgeMain } from "../../src/metrics/p1/judge-cli";
import {
  buildJudgePrompt,
  createHttpJudgeInvoke,
  parseVerdict,
  readJudgeConfigFromEnv,
  runJudge,
  type JudgeInvocation,
} from "../../src/metrics/p1/judge-runner";

const PAIRS: BlindPair[] = [
  {
    pairId: "p0001",
    prompt: "make the watchdog stop resuming forever",
    tools: ["Read", "Edit"],
    a: { title: "fix+watchdog: activity clock", content: "Replaced the frozen timestamp." },
    b: { title: "watchdog fix", content: "Changed the watchdog." },
  },
  {
    pairId: "p0002",
    prompt: "export the pairs",
    tools: ["Bash"],
    a: { title: "one", content: "first" },
    b: { title: "two", content: "second" },
  },
];

const CONFIG = {
  model: "test-judge-model",
  apiUrl: "https://example.invalid/v1/messages",
  apiKey: "key-123",
  maxTokens: 256,
  anthropicVersion: "2023-06-01",
};

describe("P1 judge runner", () => {
  test("takes the model and endpoint from the environment", () => {
    const config = readJudgeConfigFromEnv({
      P1_JUDGE_MODEL: "some-model",
      ANTHROPIC_API_KEY: "fallback-key",
    });

    expect(config).toMatchObject({
      model: "some-model",
      apiKey: "fallback-key",
      apiUrl: "https://api.anthropic.com/v1/messages",
      maxTokens: 512,
    });

    expect(() => readJudgeConfigFromEnv({ ANTHROPIC_API_KEY: "k" })).toThrow(
      /P1_JUDGE_MODEL/u,
    );
    expect(() => readJudgeConfigFromEnv({ P1_JUDGE_MODEL: "m" })).toThrow(
      /API_KEY/u,
    );
  });

  test("the prompt shows both sides and forbids guessing the author", () => {
    const { system, user } = buildJudgePrompt(PAIRS[0]!);

    expect(user).toContain("SUMMARY A title: fix+watchdog: activity clock");
    expect(user).toContain("SUMMARY B body: Changed the watchdog.");
    expect(user).toContain("TOOLS USED: Read, Edit");
    expect(system).toContain("Do not speculate about");
    expect(system).not.toContain("mnemo");
  });

  test("calls the injected transport once per pair with the configured model", async () => {
    const seen: JudgeInvocation[] = [];

    const result = await runJudge({
      pairs: PAIRS,
      config: CONFIG,
      invoke: async (invocation) => {
        seen.push(invocation);
        return '{"winner":"A","reason":"more specific"}';
      },
    });

    expect(seen).toHaveLength(2);
    expect(seen[0]!.config.model).toBe("test-judge-model");
    expect(seen[0]!.user).toContain("SUMMARY A");
    expect(result.verdicts).toEqual([
      { pairId: "p0001", winner: "A", reason: "more specific" },
      { pairId: "p0002", winner: "A", reason: "more specific" },
    ]);
    expect(result.failures).toHaveLength(0);
  });

  test("records a failure instead of guessing when a verdict will not parse", async () => {
    const result = await runJudge({
      pairs: PAIRS,
      config: CONFIG,
      limit: 1,
      invoke: async () => "I prefer the first one, honestly",
    });

    expect(result.verdicts).toHaveLength(0);
    expect(result.failures[0]!.pairId).toBe("p0001");
    expect(result.failures[0]!.error).toContain("unparseable");
  });

  test("survives a transport error on one pair", async () => {
    const result = await runJudge({
      pairs: PAIRS,
      config: CONFIG,
      invoke: async ({ user }) =>
        user.includes("export the pairs")
          ? '{"winner":"tie"}'
          : Promise.reject(new Error("429 slow down")),
    });

    expect(result.verdicts).toEqual([{ pairId: "p0002", winner: "tie", reason: undefined }]);
    expect(result.failures).toEqual([{ pairId: "p0001", error: "429 slow down" }]);
  });

  test("parses a verdict wrapped in prose and rejects a bad winner", () => {
    expect(parseVerdict("p1", 'Here you go: {"winner":"B","reason":"tighter"} ')).toEqual({
      pairId: "p1",
      winner: "B",
      reason: "tighter",
    });
    expect(parseVerdict("p1", '{"winner":"C"}')).toBeNull();
    expect(parseVerdict("p1", "no json here")).toBeNull();
  });

  test("the HTTP transport posts the documented shape", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const invoke = createHttpJudgeInvoke((async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return {
        ok: true,
        json: async () => ({ content: [{ type: "text", text: '{"winner":"A"}' }] }),
      };
    }) as unknown as typeof fetch);

    const text = await invoke({ config: CONFIG, system: "sys", user: "usr" });

    expect(text).toBe('{"winner":"A"}');
    expect(calls[0]!.url).toBe(CONFIG.apiUrl);
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.headers).toMatchObject({
      "x-api-key": "key-123",
      "anthropic-version": "2023-06-01",
    });
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({
      model: "test-judge-model",
      max_tokens: 256,
      system: "sys",
      messages: [{ role: "user", content: "usr" }],
    });
  });
});

describe("P1 judge CLI", () => {
  function makeIo() {
    const out: string[] = [];
    const err: string[] = [];
    return {
      io: { stdout: (line: string) => out.push(line), stderr: (line: string) => err.push(line) },
      out,
      err,
    };
  }

  test("writes verdicts through the injected transport and never reads a key", async () => {
    const directory = mkdtempSync(join(tmpdir(), "p1-judge-"));
    const pairsPath = join(directory, "pairs.jsonl");
    const outPath = join(directory, "verdicts.jsonl");
    await Bun.write(pairsPath, toJsonl(PAIRS));

    const { io, out } = makeIo();
    const code = await judgeMain(["--pairs", pairsPath, "--out", outPath], {
      io,
      env: { P1_JUDGE_MODEL: "stub-model", P1_JUDGE_API_KEY: "k" },
      invoke: async () => '{"winner":"B","reason":"ok"}',
    });

    expect(code).toBe(0);
    expect(readFileSync(outPath, "utf8").trim().split("\n")).toHaveLength(2);
    expect(out.join("\n")).toContain("stub-model");
  });

  test("--dry-run prints a prompt and calls nothing", async () => {
    const directory = mkdtempSync(join(tmpdir(), "p1-judge-"));
    const pairsPath = join(directory, "pairs.jsonl");
    await Bun.write(pairsPath, toJsonl(PAIRS));

    const { io, out } = makeIo();
    const code = await judgeMain(["--pairs", pairsPath, "--dry-run"], {
      io,
      env: {},
      invoke: async () => {
        throw new Error("must not be called");
      },
    });

    expect(code).toBe(0);
    expect(out.join("\n")).toContain("SUMMARY A title");
  });

  test("a judge that answers only some pairs fails, and names the gap", async () => {
    // The pairs a judge cannot answer are not a random sample of the pairs, so a
    // verdict file covering most of them is a biased measurement wearing a
    // clean face. The exit code has to say so.
    const directory = mkdtempSync(join(tmpdir(), "p1-judge-"));
    const pairsPath = join(directory, "pairs.jsonl");
    const outPath = join(directory, "verdicts.jsonl");
    await Bun.write(pairsPath, toJsonl(PAIRS));

    const { io, err } = makeIo();
    const code = await judgeMain(["--pairs", pairsPath, "--out", outPath], {
      io,
      env: { P1_JUDGE_MODEL: "stub-model", P1_JUDGE_API_KEY: "k" },
      invoke: async ({ user }) =>
        user.includes("export the pairs")
          ? "I prefer the first one, honestly"
          : '{"winner":"A"}',
    });

    expect(code).toBe(1);
    expect(err.join("\n")).toContain("incomplete judging — 1/2 pairs");
    expect(err.join("\n")).toContain("failed: p0002");
    expect(err.join("\n")).toContain("no verdict: p0002");
    // The partial file is still written; the operator decides what to do with it.
    expect(readFileSync(outPath, "utf8").trim().split("\n")).toHaveLength(1);
  });

  test("an explicitly limited run is complete on its own terms", async () => {
    const directory = mkdtempSync(join(tmpdir(), "p1-judge-"));
    const pairsPath = join(directory, "pairs.jsonl");
    const outPath = join(directory, "verdicts.jsonl");
    await Bun.write(pairsPath, toJsonl(PAIRS));

    const { io, out } = makeIo();
    const code = await judgeMain(
      ["--pairs", pairsPath, "--out", outPath, "--limit", "1"],
      {
        io,
        env: { P1_JUDGE_MODEL: "stub-model", P1_JUDGE_API_KEY: "k" },
        invoke: async () => '{"winner":"A"}',
      },
    );

    expect(code).toBe(0);
    expect(out.join("\n")).toContain("judged 1/1 pairs");
  });

  test("--limit 0 or negative is a hard error, not a vacuous success", async () => {
    const directory = mkdtempSync(join(tmpdir(), "p1-judge-"));
    const pairsPath = join(directory, "pairs.jsonl");
    const outPath = join(directory, "verdicts.jsonl");
    await Bun.write(pairsPath, toJsonl(PAIRS));

    for (const limit of ["0", "-1", "1.5", "not-a-number"]) {
      const { io, err } = makeIo();
      const code = await judgeMain(
        ["--pairs", pairsPath, "--out", outPath, "--limit", limit],
        {
          io,
          env: { P1_JUDGE_MODEL: "stub-model", P1_JUDGE_API_KEY: "k" },
          invoke: async () => {
            throw new Error("must not be called");
          },
        },
      );

      expect(code, limit).toBe(1);
      expect(err.join("\n"), limit).toContain("positive integer");
    }
  });

  test("an empty pairs file is a hard failure, not a 0/0 success", async () => {
    const directory = mkdtempSync(join(tmpdir(), "p1-judge-"));
    const pairsPath = join(directory, "pairs.jsonl");
    const outPath = join(directory, "verdicts.jsonl");
    // Header only — no pairs at all.
    await Bun.write(
      pairsPath,
      toJsonl([{ kind: "blind-pairs-header", version: 1 }]),
    );

    const { io, err } = makeIo();
    const code = await judgeMain(["--pairs", pairsPath, "--out", outPath], {
      io,
      env: { P1_JUDGE_MODEL: "stub-model", P1_JUDGE_API_KEY: "k" },
      invoke: async () => {
        throw new Error("must not be called");
      },
    });

    expect(code).toBe(1);
    expect(err.join("\n")).toContain("No pairs to judge.");
  });

  test("the declaration header is skipped, and a stray line is not", async () => {
    const directory = mkdtempSync(join(tmpdir(), "p1-judge-"));
    const pairsPath = join(directory, "pairs.jsonl");
    await Bun.write(
      pairsPath,
      toJsonl([{ kind: "blind-pairs-header", version: 1 }, ...PAIRS]),
    );

    const { io, out } = makeIo();
    expect(
      await judgeMain(["--pairs", pairsPath, "--dry-run"], {
        io,
        env: {},
        invoke: async () => "{}",
      }),
    ).toBe(0);
    expect(out.join("\n")).toContain("make the watchdog stop resuming forever");

    // A line that is neither header nor pair would otherwise vanish and reappear
    // later as a missing verdict with no cause attached.
    const strayPath = join(directory, "stray.jsonl");
    await Bun.write(strayPath, toJsonl([{ notAPair: true }]));
    const { io: strayIo, err } = makeIo();
    expect(
      await judgeMain(["--pairs", strayPath, "--dry-run"], {
        io: strayIo,
        env: {},
        invoke: async () => "{}",
      }),
    ).toBe(1);
    expect(err.join("\n")).toContain("neither a pair nor the header");
  });

  test("refuses to run without a model", async () => {
    const directory = mkdtempSync(join(tmpdir(), "p1-judge-"));
    const pairsPath = join(directory, "pairs.jsonl");
    await Bun.write(pairsPath, toJsonl(PAIRS));

    const { io, err } = makeIo();
    const code = await judgeMain(
      ["--pairs", pairsPath, "--out", join(directory, "v.jsonl")],
      { io, env: {}, invoke: async () => "{}" },
    );

    expect(code).toBe(1);
    expect(err.join("\n")).toContain("P1_JUDGE_MODEL");
  });
});
