import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("SessionStart diary backfill also runs when a session resumes", () => {
  const config = JSON.parse(
    readFileSync(join(process.cwd(), "plugin", "hooks", "hooks.json"), "utf8"),
  ) as {
    hooks: { SessionStart: Array<{ matcher: string }> };
  };

  expect(config.hooks.SessionStart[0]?.matcher.split("|")).toContain("resume");
});
