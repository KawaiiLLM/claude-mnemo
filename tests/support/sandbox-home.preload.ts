// Tests must never touch real user data. This preload runs before any test
// module loads and pins the home directory to a throwaway sandbox, so every
// os.homedir()-derived path (e.g. src/shared/paths' DATA_DIR = ~/.claude-mnemo,
// the diary staging dir, MEMORY.md) resolves inside the sandbox instead of the
// developer's real home.
//
// Note: Bun resolves os.homedir() from the launch environment and caches it, so
// mutating process.env.HOME at runtime does NOT change homedir(). We therefore
// override the node:os module itself via mock.module (env vars are set too, for
// any code that reads process.env.HOME directly).
import { mock } from "bun:test";
import * as realOs from "node:os";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";

const sandboxHome = mkdtempSync(join(realOs.tmpdir(), "claude-mnemo-test-home-"));
process.env.HOME = sandboxHome;
process.env.USERPROFILE = sandboxHome;

mock.module("node:os", () => ({
  ...realOs,
  default: { ...realOs, homedir: () => sandboxHome },
  homedir: () => sandboxHome,
}));
