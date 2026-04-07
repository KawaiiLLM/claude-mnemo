# Self-Contained Plugin Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make marketplace and source installs runnable without requiring a post-install local build for hook/MCP entrypoints.

**Architecture:** Treat `plugin/scripts/hook-command.cjs` and `plugin/scripts/mcp-server.cjs` as committed release artifacts. Keep the existing build pipeline, but stop ignoring the generated files, document the release model, and add a regression test that fails when the artifacts are not tracked.

**Tech Stack:** TypeScript, Bun test, esbuild, git-tracked generated artifacts

---

### Task 1: Add release-artifact regression coverage

**Files:**
- Create: `tests/shared/release-artifacts.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

describe("release artifacts", () => {
  test("tracks built plugin entrypoints in git", () => {
    const result = spawnSync(
      "git",
      [
        "ls-files",
        "--error-unmatch",
        "plugin/scripts/hook-command.cjs",
        "plugin/scripts/mcp-server.cjs",
      ],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `~/.bun/bin/bun test tests/shared/release-artifacts.test.ts`
Expected: FAIL because the `.cjs` artifacts are not yet tracked by git

### Task 2: Publish the built entrypoints

**Files:**
- Modify: `.gitignore`
- Modify: `README.md`
- Existing generated files to add: `plugin/scripts/hook-command.cjs`, `plugin/scripts/mcp-server.cjs`

- [ ] **Step 1: Stop ignoring release artifacts**

Remove this line from `.gitignore`:

```gitignore
plugin/scripts/*.cjs
```

- [ ] **Step 2: Document the release model**

Update `README.md` to explicitly state that:
- marketplace/source installs include prebuilt hook and MCP entrypoints
- `npm run build` refreshes those committed artifacts for contributors

- [ ] **Step 3: Refresh build outputs**

Run: `npm run build`
Expected: `plugin/scripts/hook-command.cjs` and `plugin/scripts/mcp-server.cjs` exist and are current

- [ ] **Step 4: Add release artifacts to git**

Run:

```bash
git add plugin/scripts/hook-command.cjs plugin/scripts/mcp-server.cjs
```

### Task 3: Verify the release contract

**Files:**
- Test: `tests/shared/release-artifacts.test.ts`

- [ ] **Step 1: Re-run the focused regression**

Run: `~/.bun/bin/bun test tests/shared/release-artifacts.test.ts`
Expected: PASS

- [ ] **Step 2: Run broader verification**

Run:

```bash
~/.bun/bin/bun test tests/shared/release-artifacts.test.ts tests/shared/logger.test.ts tests/hooks/stop.test.ts tests/hooks/compact.test.ts
npm run build
claude plugins validate plugin
```

Expected:
- tests pass
- build succeeds
- plugin validation succeeds
