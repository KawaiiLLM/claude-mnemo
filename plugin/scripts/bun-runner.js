#!/usr/bin/env node
/**
 * Bun Runner - Finds and executes Bun even when not in PATH
 *
 * This script solves the fresh install problem where:
 * 1. smart-install.js installs Bun to ~/.bun/bin/bun
 * 2. But Bun isn't in PATH until terminal restart
 * 3. Subsequent hooks fail because they can't find `bun`
 *
 * Usage: node bun-runner.js <script> [args...]
 *
 * Fixes #818: Worker fails to start on fresh install
 */
import { spawnSync, spawn } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';

const IS_WINDOWS = process.platform === 'win32';

// Self-resolve plugin root when CLAUDE_PLUGIN_ROOT is not set by Claude Code.
// Upstream bug: anthropics/claude-code#24529 — Stop hooks (and on Linux, all hooks)
// don't receive CLAUDE_PLUGIN_ROOT, causing script paths to resolve to /scripts/...
// which doesn't exist. This fallback derives the plugin root from bun-runner.js's
// own filesystem location (this file lives in <plugin-root>/scripts/).
const __bun_runner_dirname = dirname(fileURLToPath(import.meta.url));
const RESOLVED_PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || resolve(__bun_runner_dirname, '..');

/**
 * Fix script path arguments that were broken by empty CLAUDE_PLUGIN_ROOT.
 * When CLAUDE_PLUGIN_ROOT is empty, "${CLAUDE_PLUGIN_ROOT}/scripts/foo.cjs"
 * expands to "/scripts/foo.cjs" which doesn't exist. Detect this and rewrite
 * the path using our self-resolved plugin root.
 */
function fixBrokenScriptPath(argPath) {
  if (argPath.startsWith('/scripts/') && !existsSync(argPath)) {
    const fixedPath = join(RESOLVED_PLUGIN_ROOT, argPath);
    if (existsSync(fixedPath)) {
      return fixedPath;
    }
  }
  return argPath;
}

/**
 * Find Bun executable - checks PATH first, then common install locations
 */
function findBun() {
  // Try PATH first
  const pathCheck = spawnSync(IS_WINDOWS ? 'where' : 'which', ['bun'], {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: IS_WINDOWS
  });

  if (pathCheck.status === 0 && pathCheck.stdout.trim()) {
    return 'bun'; // Found in PATH
  }

  // Check common installation paths (handles fresh installs before PATH reload)
  // Windows: Bun installs to ~/.bun/bin/bun.exe (same as smart-install.js)
  // Unix: Check default location plus common package manager paths
  const bunPaths = IS_WINDOWS
    ? [join(homedir(), '.bun', 'bin', 'bun.exe')]
    : [
        join(homedir(), '.bun', 'bin', 'bun'),
        '/usr/local/bin/bun',
        '/opt/homebrew/bin/bun',
        '/home/linuxbrew/.linuxbrew/bin/bun'
      ];

  for (const bunPath of bunPaths) {
    if (existsSync(bunPath)) {
      return bunPath;
    }
  }

  return null;
}

export function shouldBufferStdinForScript(scriptPath) {
  return scriptPath.endsWith('/hook-command.cjs') || scriptPath.endsWith('\\hook-command.cjs');
}

// Early exit if plugin is disabled in Claude Code settings (#781).
// Sync read + JSON parse — fastest possible check before spawning Bun.
export function isPluginDisabledInClaudeSettings(
  env = process.env,
  deps = {
    existsSyncImpl: existsSync,
    readFileSyncImpl: readFileSync,
  },
) {
  try {
    const configDir = env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
    const settingsPath = join(configDir, 'settings.json');
    if (!deps.existsSyncImpl(settingsPath)) return false;
    const settings = JSON.parse(deps.readFileSyncImpl(settingsPath, 'utf-8'));
    return settings?.enabledPlugins?.['claude-mnemo@zhaoqixuan'] === false;
  } catch {
    return false;
  }
}

if (isPluginDisabledInClaudeSettings()) {
  process.exit(0);
}

// Fix #646: Buffer hook stdin in Node.js before passing to Bun.
// On Linux, Bun's libuv calls fstat() on inherited pipe fds and crashes with
// EINVAL when the pipe comes from Claude Code's hook system. Hooks receive a
// single JSON payload, so we can safely buffer until we have a complete JSON
// object and then replay it into Bun through a fresh pipe. MCP server traffic
// is streaming JSON-RPC and must continue to use inherited stdio.
export function collectHookStdinFromStream(
  stdin = process.stdin,
  { timeoutMs = 5000 } = {},
) {
  return new Promise((resolve, reject) => {
    if (stdin.isTTY) {
      resolve(null);
      return;
    }

    const chunks = [];
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      stdin.removeListener('data', onData);
      stdin.removeListener('end', onEnd);
      stdin.removeListener('error', onError);
    };

    const bufferedText = () => Buffer.concat(chunks).toString('utf8').trim();

    const tryResolveCompleteJson = () => {
      const text = bufferedText();
      if (text === '') {
        return false;
      }

      try {
        JSON.parse(text);
        settled = true;
        cleanup();
        resolve(Buffer.from(text));
        return true;
      } catch {
        return false;
      }
    };

    const onData = (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      tryResolveCompleteJson();
    };

    const onEnd = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(chunks.length > 0 ? Buffer.concat(chunks) : null);
    };

    const onError = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(null);
    };

    const timer = setTimeout(() => {
      if (settled) {
        return;
      }

      if (chunks.length === 0) {
        settled = true;
        cleanup();
        resolve(null);
        return;
      }

      if (tryResolveCompleteJson()) {
        return;
      }

      settled = true;
      cleanup();
      reject(new Error('Timed out waiting for complete hook JSON on stdin'));
    }, timeoutMs);

    stdin.on('data', onData);
    stdin.on('end', onEnd);
    stdin.on('error', onError);
  });
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length === 0) {
    console.error('Usage: node bun-runner.js <script> [args...]');
    return 1;
  }

  const args = [...argv];
  args[0] = fixBrokenScriptPath(args[0]);

  const bunPath = findBun();

  if (!bunPath) {
    console.error('Error: Bun not found. Please install Bun: https://bun.sh');
    console.error('After installation, restart your terminal.');
    return 1;
  }

  const stdinData = shouldBufferStdinForScript(args[0])
    ? await collectHookStdinFromStream(process.stdin)
    : null;

  const child = spawn(bunPath, args, {
    stdio: [
      shouldBufferStdinForScript(args[0]) ? (stdinData ? 'pipe' : 'ignore') : 'inherit',
      'inherit',
      'inherit'
    ],
    windowsHide: true,
    env: process.env
  });

  if (stdinData && child.stdin) {
    child.stdin.write(stdinData);
    child.stdin.end();
  }

  return await new Promise((resolve) => {
    child.on('error', (err) => {
      console.error(`Failed to start Bun: ${err.message}`);
      resolve(1);
    });

    child.on('close', (code) => {
      resolve(code || 0);
    });
  });
}

const isDirectExecution =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isDirectExecution) {
  const exitCode = await main();
  process.exit(exitCode);
}
