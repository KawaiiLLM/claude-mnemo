#!/usr/bin/env bun
/**
 * lane-controls -- read-only attribution controls (lane-model-v12 ticket 13).
 *
 * The real logic lives in src/cli/lane-controls-cli.ts (the same
 * thin-wrapper-over-a-testable-module split scripts/lane-check.ts and
 * scripts/p1-judge.ts already use), so this file stays a two-line entry point.
 *
 *   bun scripts/lane-controls.ts
 *   bun scripts/lane-controls.ts --segment 60 --export /tmp/sample.json
 *   bun scripts/lane-controls.ts --graded /tmp/sample.graded.json
 */
import { runLaneControlsCli } from "../src/cli/lane-controls-cli";

process.exit(runLaneControlsCli(process.argv.slice(2)));
