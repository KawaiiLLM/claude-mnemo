import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import {
  AGENT_READ_DOC_MAX_BYTES,
  createDiaryAgentToolHandlers,
} from "../../src/worker/diary-agent-tools";

describe("shared SDK agent tools", () => {
  let db: Database;
  let dataRoot: string;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    dataRoot = mkdtempSync(join(tmpdir(), "claude-mnemo-agent-tools-"));
    mkdirSync(join(dataRoot, "diary"));
    mkdirSync(join(dataRoot, "persona"));
    writeFileSync(join(dataRoot, "diary", "2026-07-10.md"), "diary text");
    writeFileSync(join(dataRoot, "persona", "user-profile.md"), "persona text");
    writeFileSync(join(dataRoot, "mnemo.db"), "database");
    mkdirSync(join(dataRoot, "persona", "operations", "op-1"), { recursive: true });
    writeFileSync(join(dataRoot, "persona", "operations", "op-1", "checkpoint.md"), "internal");
  });

  afterEach(() => {
    db.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });

  test("reads Markdown documents from the allowed diary and persona subtrees", async () => {
    const handlers = createDiaryAgentToolHandlers({
      db,
      dataRoot,
      allowedDocumentSubtrees: new Set(["diary", "persona"]),
    });
    expect(await handlers.readDoc("diary/2026-07-10.md")).toBe("diary text");
    expect(await handlers.readDoc("persona/user-profile.md")).toBe("persona text");
  });

  test("rejects paths outside document scope and database files", async () => {
    const handlers = createDiaryAgentToolHandlers({
      db,
      dataRoot,
      allowedDocumentSubtrees: new Set(["diary", "persona"]),
    });
    await expect(handlers.readDoc("../config.json")).rejects.toThrow("outside");
    await expect(handlers.readDoc("mnemo.db")).rejects.toThrow("outside");
    await expect(handlers.readDoc("diary/../config.md")).rejects.toThrow("outside");
    await expect(
      handlers.readDoc("persona/operations/op-1/checkpoint.md"),
    ).rejects.toThrow("Operation artifacts");
  });

  test("rejects symlink roots and symlink targets", async () => {
    const target = join(dataRoot, "target.md");
    writeFileSync(target, "target");
    symlinkSync(target, join(dataRoot, "diary", "linked.md"));
    let handlers = createDiaryAgentToolHandlers({
      db,
      dataRoot,
      allowedDocumentSubtrees: new Set(["diary"]),
    });
    await expect(handlers.readDoc("diary/linked.md")).rejects.toThrow("symlink");

    rmSync(join(dataRoot, "persona"), { recursive: true });
    symlinkSync(join(dataRoot, "diary"), join(dataRoot, "persona"));
    handlers = createDiaryAgentToolHandlers({
      db,
      dataRoot,
      allowedDocumentSubtrees: new Set(["persona"]),
    });
    await expect(handlers.readDoc("persona/2026-07-10.md")).rejects.toThrow("symlink");
  });

  test("rejects oversized and invalid UTF-8 documents", async () => {
    writeFileSync(join(dataRoot, "diary", "large.md"), Buffer.alloc(AGENT_READ_DOC_MAX_BYTES + 1));
    writeFileSync(join(dataRoot, "diary", "invalid.md"), new Uint8Array([0xff]));
    const handlers = createDiaryAgentToolHandlers({
      db,
      dataRoot,
      allowedDocumentSubtrees: new Set(["diary"]),
    });
    await expect(handlers.readDoc("diary/large.md")).rejects.toThrow("exceeds");
    await expect(handlers.readDoc("diary/invalid.md")).rejects.toThrow("UTF-8");
  });

  test("rebuild scope cannot see the persona subtree", async () => {
    const handlers = createDiaryAgentToolHandlers({
      db,
      dataRoot,
      allowedDocumentSubtrees: new Set(["diary"]),
    });
    await expect(handlers.readDoc("persona/user-profile.md")).rejects.toThrow("outside");
  });
});
