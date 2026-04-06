#!/usr/bin/env node

import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

function getBunExecutable() {
  const envPath = process.env.BUN_BIN;
  if (envPath && existsSync(envPath)) {
    return envPath;
  }

  const defaultPath = join(homedir(), ".bun", "bin", "bun");
  if (existsSync(defaultPath)) {
    return defaultPath;
  }

  const probe = spawnSync("bun", ["--version"], { stdio: "ignore" });
  if (probe.status === 0) {
    return "bun";
  }

  return null;
}

function installBun() {
  const installer = spawnSync("sh", ["-lc", "curl -fsSL https://bun.sh/install | bash"], {
    stdio: "inherit",
    env: process.env,
  });

  if (installer.status !== 0) {
    process.exit(installer.status ?? 1);
  }
}

function main() {
  const [, , scriptPath, ...scriptArgs] = process.argv;

  if (!scriptPath) {
    console.error("bun-runner.js requires a target script path.");
    process.exit(1);
  }

  let bun = getBunExecutable();

  if (!bun) {
    installBun();
    bun = getBunExecutable();
  }

  if (!bun) {
    console.error("Failed to locate Bun after installation.");
    process.exit(1);
  }

  const result = spawnSync(bun, [scriptPath, ...scriptArgs], {
    stdio: "inherit",
    env: process.env,
  });

  process.exit(result.status ?? 1);
}

main();
