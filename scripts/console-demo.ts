#!/usr/bin/env bun
/**
 * console-demo -- serve the REPO's console (shell + API) read-only, without
 * the worker.
 *
 * Purpose: eyeball unreleased console changes against real data before a
 * release, while the LIVE worker keeps serving the installed bundle on 37778.
 * This deliberately imports only the three console modules — none of the
 * worker core — so nothing here can dispatch an agent, write the database,
 * or touch settlement/dream/extraction: the connection is opened
 * `readonly: true` and the fetch handler knows exactly two route families.
 *
 *   bun scripts/console-demo.ts                # defaults below
 *   bun scripts/console-demo.ts --db /path/to/claude-mnemo.db --port 37901
 */
import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";

import { routeConsoleApiRequest, toConsoleApiResponse } from "../src/worker/console-api";
import { createConsoleReader } from "../src/worker/console-reader";
import { CONSOLE_SHELL_HTML } from "../src/worker/console-shell";

const args = process.argv.slice(2);
const argOf = (flag: string): string | undefined => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};

const dbPath = argOf("--db") ?? join(homedir(), ".claude-mnemo", "claude-mnemo.db");
const port = Number(argOf("--port") ?? 37901);

const db = new Database(dbPath, { readonly: true });
const reader = createConsoleReader(db);
const ctx = { buildId: "console-demo", nowMs: () => Date.now() };

Bun.serve({
  port,
  hostname: "127.0.0.1",
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/" || url.pathname === "/console") {
      return new Response(CONSOLE_SHELL_HTML, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    const result = routeConsoleApiRequest(url.pathname, reader, url, ctx);
    if (result) {
      return toConsoleApiResponse(result);
    }
    return new Response("not found", { status: 404 });
  },
});

console.log(`console-demo: http://127.0.0.1:${port}/console (db: ${dbPath}, read-only)`);
