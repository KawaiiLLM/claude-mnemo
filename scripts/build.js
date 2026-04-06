#!/usr/bin/env node

import { chmodSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import esbuild from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(__dirname);
const pluginScriptsDirectory = join(projectRoot, "plugin", "scripts");
const packageJson = await import(join(projectRoot, "package.json"), {
  with: { type: "json" },
});

const defaultVersion = packageJson.default.version;

const builds = [
  {
    entryPoint: join(projectRoot, "src", "hooks", "hook-command.ts"),
    outputFile: join(pluginScriptsDirectory, "hook-command.cjs"),
  },
  {
    entryPoint: join(projectRoot, "src", "mcp", "server.ts"),
    outputFile: join(pluginScriptsDirectory, "mcp-server.cjs"),
  },
];

mkdirSync(pluginScriptsDirectory, { recursive: true });

for (const build of builds) {
  await esbuild.build({
    entryPoints: [build.entryPoint],
    outfile: build.outputFile,
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node18",
    banner: {
      js: "#!/usr/bin/env node",
    },
    define: {
      __DEFAULT_PACKAGE_VERSION__: JSON.stringify(defaultVersion),
    },
    external: ["bun:sqlite", "@anthropic-ai/claude-agent-sdk"],
  });

  chmodSync(build.outputFile, 0o755);
}
chmodSync(join(projectRoot, "plugin", "scripts", "bun-runner.js"), 0o755);
