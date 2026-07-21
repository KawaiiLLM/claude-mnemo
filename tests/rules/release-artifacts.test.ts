import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { build } from "esbuild";

describe("rule index release artifact guard", () => {
  test("bundles the renderer together with the index schema only", async () => {
    const output = mkdtempSync(join(tmpdir(), "mnemo-rule-index-build-"));
    try {
      const result = await build({
        entryPoints: ["src/rules/trigger-index.ts"],
        outfile: join(output, "rule-index-renderer.cjs"),
        bundle: true,
        format: "cjs",
        platform: "node",
        target: "node18",
        external: ["bun:sqlite"],
        metafile: true,
      });
      const inputs = Object.keys(result.metafile.inputs).map((path) =>
        relative(process.cwd(), path),
      );
      expect(inputs).toContain("src/rules/trigger-index.ts");
      expect(inputs).toContain("src/rules/schema.ts");
      expect(inputs).not.toContain("src/hooks/hook-command.ts");
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });

  test("bundles the PreToolUse dispatcher into the released hook command", async () => {
    const output = mkdtempSync(join(tmpdir(), "mnemo-rule-dispatcher-build-"));
    try {
      const result = await build({
        entryPoints: ["src/hooks/hook-command.ts"],
        outfile: join(output, "hook-command.cjs"),
        bundle: true,
        format: "cjs",
        platform: "node",
        target: "node18",
        external: ["bun:sqlite"],
        metafile: true,
      });
      const inputs = Object.keys(result.metafile.inputs).map((path) =>
        relative(process.cwd(), path),
      );
      expect(inputs).toContain("src/rules/pretooluse-dispatcher.ts");
      expect(inputs).toContain("src/rules/schema.ts");
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });
});
