#!/usr/bin/env bun
/**
 * P1 trial metrics (spec D12, ticket 04): compliance, blind-eval pairs and the
 * mis-attribution signature. Read-only; see src/metrics/p1/database.ts.
 *
 *   bun scripts/p1-metrics.ts --db ~/.claude-mnemo/memory.db
 */
import { main } from "../src/metrics/p1/cli";

process.exit(await main(process.argv.slice(2)));
