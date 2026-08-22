#!/usr/bin/env bun
/**
 * lane-check -- read-only lane checker CLI (rubric-v10 ticket 06).
 *
 * The real logic lives in src/cli/lane-check-cli.ts (same split as
 * scripts/p1-judge.ts's own thin-wrapper-over-a-testable-module pattern),
 * so this file stays a two-line entry point.
 *
 *   bun scripts/lane-check.ts --session 15069 --range 900-1001
 *   bun scripts/lane-check.ts --segment 42
 *   bun scripts/lane-check.ts --lane default:ownership,decision
 */
import { runLaneCheckCli } from "../src/cli/lane-check-cli";

process.exit(runLaneCheckCli(process.argv.slice(2)));
