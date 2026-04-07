# Self-Contained Plugin Release Design

## Goal

Make `claude-mnemo` installable via Claude Code plugin marketplace or source checkout without requiring a post-install local build to produce runtime entrypoints.

## Problem

The installed plugin currently expects these runtime files to exist:
- `plugin/scripts/hook-command.cjs`
- `plugin/scripts/mcp-server.cjs`

`plugin/hooks/hooks.json` and `plugin/.mcp.json` reference them directly, but the repo currently ignores `plugin/scripts/*.cjs`. Marketplace installs therefore receive source code plus `bun-runner.js`, but not the required built entrypoints.

## Chosen Approach

Treat the `.cjs` files in `plugin/scripts/` as release artifacts and commit them to the repository.

This keeps the installation contract simple:
- marketplace/source installs are immediately runnable
- `npm run build` refreshes the committed artifacts
- hooks and MCP config continue to point at stable file paths

## Alternatives Considered

### 1. Commit built artifacts
Recommended.

Pros:
- smallest change
- fixes current install breakage directly
- no install-time build dependency for users

Cons:
- committed generated files must stay in sync with source

### 2. Add Setup/smart-install build step
Not chosen for now.

Pros:
- more flexible for future dependency installation

Cons:
- more moving parts
- longer install path
- still requires a successful post-install build

## Required Changes

1. Stop ignoring `plugin/scripts/*.cjs` in `.gitignore`.
2. Ensure `npm run build` produces fresh `hook-command.cjs` and `mcp-server.cjs`.
3. Add the generated `.cjs` files to git.
4. Update README installation/development notes to make the release model explicit.
5. Add a regression test or verification step that checks the expected runtime files exist after build.

## Non-Goals

- No new Setup hook.
- No runtime smart installer.
- No change to hook command paths.
- No change to MCP server wiring.

## Verification

Minimum verification before completion:
- `npm run build`
- confirm `plugin/scripts/hook-command.cjs` exists
- confirm `plugin/scripts/mcp-server.cjs` exists
- `claude plugins validate plugin`
