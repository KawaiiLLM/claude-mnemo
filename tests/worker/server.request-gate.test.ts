import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { createWorkerFetchHandler, evaluateRequestGate } from "../../src/worker/server";

/**
 * The DNS-rebinding request gate (memory-console spec, "Security posture";
 * ticket 02). Two layers, both exercised: the pure function directly (every
 * header combination the spec names), and the identical verdicts reached
 * through the REAL fetch handler against an existing GET route (/health) and
 * an existing POST route (/flush) -- proving the gate actually sits in front
 * of dispatch, not merely that the pure function is correct in isolation.
 */

const TEST_PORT = 41999;

describe("evaluateRequestGate (pure function: headers + port -> verdict)", () => {
  test("Host: exact loopback forms pass; absent, wrong port, portless and foreign hosts are rejected as 'host'", () => {
    expect(
      evaluateRequestGate(new Headers({ host: `127.0.0.1:${TEST_PORT}` }), TEST_PORT),
    ).toEqual({ allowed: true });
    expect(
      evaluateRequestGate(new Headers({ host: `localhost:${TEST_PORT}` }), TEST_PORT),
    ).toEqual({ allowed: true });

    expect(evaluateRequestGate(new Headers(), TEST_PORT)).toEqual({
      allowed: false,
      reason: "host",
    });
    expect(
      evaluateRequestGate(new Headers({ host: `127.0.0.1:9999` }), TEST_PORT),
    ).toEqual({ allowed: false, reason: "host" });
    expect(
      evaluateRequestGate(new Headers({ host: "127.0.0.1" }), TEST_PORT),
    ).toEqual({ allowed: false, reason: "host" });
    // The DNS-rebinding shape itself: a browser that resolved a hostile
    // domain to 127.0.0.1 still sends that domain's name as Host.
    expect(
      evaluateRequestGate(
        new Headers({ host: `attacker.example:${TEST_PORT}` }),
        TEST_PORT,
      ),
    ).toEqual({ allowed: false, reason: "host" });
  });

  test("Origin: absent passes, exact loopback origin passes, any other origin is rejected as 'origin'", () => {
    expect(
      evaluateRequestGate(new Headers({ host: `127.0.0.1:${TEST_PORT}` }), TEST_PORT),
    ).toEqual({ allowed: true });

    for (const origin of [
      `http://127.0.0.1:${TEST_PORT}`,
      `http://localhost:${TEST_PORT}`,
    ]) {
      expect(
        evaluateRequestGate(
          new Headers({ host: `127.0.0.1:${TEST_PORT}`, origin }),
          TEST_PORT,
        ),
      ).toEqual({ allowed: true });
    }

    for (const origin of [
      "http://evil.example.com",
      `https://127.0.0.1:${TEST_PORT}`, // https, not http -- the loopback server is http-only
      `http://127.0.0.1:9999`, // right host, wrong port
      "null",
    ]) {
      expect(
        evaluateRequestGate(
          new Headers({ host: `127.0.0.1:${TEST_PORT}`, origin }),
          TEST_PORT,
        ),
      ).toEqual({ allowed: false, reason: "origin" });
    }
  });

  test("Sec-Fetch-Site: absent/same-origin/none pass, cross-site (and same-site) are rejected as 'sec-fetch-site'", () => {
    const validHost = `127.0.0.1:${TEST_PORT}`;

    expect(
      evaluateRequestGate(new Headers({ host: validHost }), TEST_PORT),
    ).toEqual({ allowed: true });
    expect(
      evaluateRequestGate(
        new Headers({ host: validHost, "sec-fetch-site": "same-origin" }),
        TEST_PORT,
      ),
    ).toEqual({ allowed: true });
    expect(
      evaluateRequestGate(
        new Headers({ host: validHost, "sec-fetch-site": "none" }),
        TEST_PORT,
      ),
    ).toEqual({ allowed: true });

    for (const secFetchSite of ["cross-site", "same-site"]) {
      expect(
        evaluateRequestGate(
          new Headers({ host: validHost, "sec-fetch-site": secFetchSite }),
          TEST_PORT,
        ),
      ).toEqual({ allowed: false, reason: "sec-fetch-site" });
    }
  });
});

describe("the gate through the REAL fetch handler, before any route dispatch", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  function handlerAt(port: number): (req: Request) => Promise<Response> {
    return createWorkerFetchHandler({
      db,
      port,
      handleFlushImpl: async () => {},
    });
  }

  const CASES: ReadonlyArray<{
    name: string;
    headers: Record<string, string>;
    allowed: boolean;
  }> = [
    {
      name: "valid loopback host, no Origin, no Sec-Fetch-Site",
      headers: { host: `127.0.0.1:${TEST_PORT}` },
      allowed: true,
    },
    {
      name: "valid localhost host form",
      headers: { host: `localhost:${TEST_PORT}` },
      allowed: true,
    },
    {
      name: "valid host + exact loopback Origin + same-origin Sec-Fetch-Site",
      headers: {
        host: `127.0.0.1:${TEST_PORT}`,
        origin: `http://127.0.0.1:${TEST_PORT}`,
        "sec-fetch-site": "same-origin",
      },
      allowed: true,
    },
    {
      name: "valid host + Sec-Fetch-Site none",
      headers: { host: `127.0.0.1:${TEST_PORT}`, "sec-fetch-site": "none" },
      allowed: true,
    },
    { name: "missing Host header", headers: {}, allowed: false },
    {
      name: "foreign Host (DNS-rebinding shape)",
      headers: { host: `attacker.example:${TEST_PORT}` },
      allowed: false,
    },
    {
      name: "valid host, foreign Origin",
      headers: { host: `127.0.0.1:${TEST_PORT}`, origin: "http://evil.example.com" },
      allowed: false,
    },
    {
      name: "valid host, cross-site Sec-Fetch-Site",
      headers: { host: `127.0.0.1:${TEST_PORT}`, "sec-fetch-site": "cross-site" },
      allowed: false,
    },
  ];

  for (const scenario of CASES) {
    test(`GET /health -- ${scenario.name}`, async () => {
      const handler = handlerAt(TEST_PORT);
      const response = await handler(
        new Request(`http://127.0.0.1:${TEST_PORT}/health`, {
          headers: scenario.headers,
        }),
      );

      expect(response.status).toBe(scenario.allowed ? 200 : 403);
      // Never emitted, allowed or not (spec: no Access-Control-Allow-Origin, ever).
      expect(response.headers.get("access-control-allow-origin")).toBeNull();

      if (scenario.allowed) {
        expect(await response.json()).toMatchObject({ ok: true });
      } else {
        expect(await response.json()).toMatchObject({
          error: { code: "forbidden" },
        });
      }
    });

    test(`POST /flush -- ${scenario.name}`, async () => {
      const handler = handlerAt(TEST_PORT);
      const response = await handler(
        new Request(`http://127.0.0.1:${TEST_PORT}/flush`, {
          method: "POST",
          headers: scenario.headers,
          body: JSON.stringify({ session_id: 1 }),
        }),
      );

      expect(response.status).toBe(scenario.allowed ? 200 : 403);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    });
  }

  test("the default port (no explicit deps.port) is the server's own bound port, 37778", async () => {
    const handler = createWorkerFetchHandler({ db, handleFlushImpl: async () => {} });

    const good = await handler(
      new Request("http://127.0.0.1:37778/health", {
        headers: { host: "127.0.0.1:37778" },
      }),
    );
    expect(good.status).toBe(200);

    const bad = await handler(
      new Request("http://127.0.0.1:37778/health", {
        headers: { host: "127.0.0.1:9999" },
      }),
    );
    expect(bad.status).toBe(403);
  });
});
