#!/usr/bin/env bun
/**
 * Blind judge runner for the P1 pair export (ticket 04). Model and endpoint come
 * from the environment; the key file is never read here.
 *
 *   P1_JUDGE_MODEL=... bun scripts/p1-judge.ts --pairs p.jsonl --out v.jsonl
 */
import { judgeMain } from "../src/metrics/p1/judge-cli";

process.exit(await judgeMain(process.argv.slice(2)));
