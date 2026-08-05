#!/usr/bin/env bun
/**
 * Token economics analysis for Mnemosyne memory agent sessions.
 *
 * - Auto-detects each message's model and applies the matching pricing.
 * - Dedupes entries that share a `message.id` so one API response counts once.
 * - Separates 5m and 1h cache writes (priced differently).
 *
 * Usage:
 *   bun scripts/token-economics.ts [--from YYYY-MM-DD] [--to YYYY-MM-DD]
 *
 * Dates are inclusive, interpreted as UTC day boundaries.
 */

import { readdir, readFile } from "fs/promises";
import { join, basename, relative } from "path";

// Mnemo worker transcripts live under DATA_DIR (~/.claude-mnemo) encoded.
// The dev-project dir only has Task-spawned subagents from working on mnemo
// itself, not mnemo's own memory-agent sessions.
const BASE_DIR =
  "/Users/zhaoqixuan/.claude/projects/-Users-zhaoqixuan--claude-mnemo";

// Per-million-token USD pricing snapshot.
// Source: https://www.anthropic.com/pricing  (verify before publishing figures)
const PRICING_SNAPSHOT_DATE = "2026-04-15";
const PRICING_SOURCE_URL = "https://www.anthropic.com/pricing";

interface Pricing {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
}

const PRICING_TABLE: Array<{ match: RegExp; price: Pricing }> = [
  {
    // Opus 5 / Fable 5 — same pricing tier
    match: /^claude-(?:opus|fable)-5/,
    price: {
      input: 5,
      output: 25,
      cacheWrite5m: 6.25,
      cacheWrite1h: 10,
      cacheRead: 0.5,
    },
  },
  {
    // Sonnet 5
    match: /^claude-sonnet-5/,
    price: {
      input: 3,
      output: 15,
      cacheWrite5m: 3.75,
      cacheWrite1h: 6,
      cacheRead: 0.3,
    },
  },
  {
    // Opus 4.5 / 4.6 — same pricing tier
    match: /^claude-opus-4-[56]/,
    price: {
      input: 15,
      output: 75,
      cacheWrite5m: 18.75,
      cacheWrite1h: 30,
      cacheRead: 1.5,
    },
  },
  {
    // Sonnet 4.5 / 4.6 — same pricing tier
    match: /^claude-sonnet-4-[56]/,
    price: {
      input: 3,
      output: 15,
      cacheWrite5m: 3.75,
      cacheWrite1h: 6,
      cacheRead: 0.3,
    },
  },
  {
    // Haiku 4.5
    match: /^claude-haiku-4-5/,
    price: {
      input: 1,
      output: 5,
      cacheWrite5m: 1.25,
      cacheWrite1h: 2,
      cacheRead: 0.1,
    },
  },
];

function pricingFor(model: string): Pricing | null {
  for (const entry of PRICING_TABLE) {
    if (entry.match.test(model)) return entry.price;
  }
  return null;
}

interface SessionStats {
  file: string;
  shortName: string;
  date: string;
  timestamp: Date;
  apiTurns: number;
  inputTokens: number;
  outputTokens: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheReadTokens: number;
  cost: number;
  models: Set<string>;
  isCompact: boolean;
  isTopLevel: boolean; // true for worker's own long-lived transcripts (depth 1)
  spawnedBy: string; // meaningful only when !isTopLevel: outer session that spawned this subagent
  unknownModelTurns: number; // entries whose model had no pricing row
}

async function findTranscriptFiles(dir: string): Promise<string[]> {
  // Accept both top-level UUID-named worker transcripts and nested
  // `agent-*.jsonl` compact subagent transcripts.
  const results: string[] = [];

  async function walk(d: string) {
    const entries = await readdir(d, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        results.push(full);
      }
    }
  }

  await walk(dir);
  return results.sort();
}

function entryCost(usage: any, pricing: Pricing): number {
  const input = usage.input_tokens || 0;
  const output = usage.output_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  const cacheCreation = usage.cache_creation || {};
  const write5m = cacheCreation.ephemeral_5m_input_tokens || 0;
  const write1h = cacheCreation.ephemeral_1h_input_tokens || 0;
  const totalCreate = usage.cache_creation_input_tokens || 0;
  // Older transcripts only have the aggregate field. Default the unattributed
  // remainder to 5m pricing (the historical default TTL).
  const residual = Math.max(0, totalCreate - write5m - write1h);
  const effective5m = write5m + residual;
  return (
    (input / 1_000_000) * pricing.input +
    (output / 1_000_000) * pricing.output +
    (effective5m / 1_000_000) * pricing.cacheWrite5m +
    (write1h / 1_000_000) * pricing.cacheWrite1h +
    (cacheRead / 1_000_000) * pricing.cacheRead
  );
}

async function analyzeFile(filePath: string): Promise<SessionStats | null> {
  const content = await readFile(filePath, "utf-8");
  const lines = content.trim().split("\n");

  // Top-level means "directly under BASE_DIR" — the worker's own long-lived
  // agent transcript, where sessionId refers to itself and is NOT a parent.
  // Anything deeper (e.g. subagents/agent-*.jsonl) has sessionId pointing at
  // the outer session that spawned it.
  const rel = relative(BASE_DIR, filePath);
  const isTopLevel = !rel.includes("/");

  let firstTimestamp: Date | null = null;
  let apiTurns = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheWrite5m = 0;
  let cacheWrite1h = 0;
  let cacheReadTokens = 0;
  let cost = 0;
  let unknownModelTurns = 0;
  let spawnedBy = "";
  const models = new Set<string>();

  // Two-layer dedupe — matches the pattern in
  // docs/plans/2026-04-10-transcript-resume-dedup.md and the claude-powerline
  // cache-hit pipeline:
  //   1. entry.uuid — each JSONL line has a globally unique uuid. If Claude
  //      Code was --resumed, the whole entry (including uuid) is replayed
  //      verbatim, which would otherwise multiply cost by 2x–N×.
  //   2. message.id — one logical API response can emit multiple entries
  //      (thinking + text, text + tool_use) with identical usage.
  // Entries lacking both fields fall through unmodified (conservative).
  const seenUuids = new Set<string>();
  const seenMessageKeys = new Set<string>();

  for (const line of lines) {
    if (!line.trim()) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    // Layer 1: drop resume replays by entry uuid, before anything else.
    if (typeof entry.uuid === "string") {
      if (seenUuids.has(entry.uuid)) continue;
      seenUuids.add(entry.uuid);
    }

    if (!firstTimestamp && entry.timestamp) {
      firstTimestamp = new Date(entry.timestamp);
    }
    // Only record spawnedBy for nested subagent files. For top-level worker
    // transcripts, sessionId is the file's own id and carries no parent info.
    if (!isTopLevel && !spawnedBy && entry.sessionId) {
      spawnedBy = entry.sessionId;
    }

    const usage = entry.message?.usage;
    if (!usage) continue;

    // Layer 2: collapse multi-entry API responses by message.id.
    const dedupeKey =
      entry.message?.id ?? entry.requestId ?? `line:${line}`;
    if (seenMessageKeys.has(dedupeKey)) continue;
    seenMessageKeys.add(dedupeKey);

    const model = entry.message?.model ?? "";
    if (model) models.add(model);

    const pricing = model ? pricingFor(model) : null;
    if (!pricing) {
      // Synthetic or unrecognized model — skip cost but still count the turn.
      unknownModelTurns++;
      apiTurns++;
      continue;
    }

    apiTurns++;
    inputTokens += usage.input_tokens || 0;
    outputTokens += usage.output_tokens || 0;
    const cc = usage.cache_creation || {};
    const write5m = cc.ephemeral_5m_input_tokens || 0;
    const write1h = cc.ephemeral_1h_input_tokens || 0;
    const totalCreate = usage.cache_creation_input_tokens || 0;
    const residual = Math.max(0, totalCreate - write5m - write1h);
    cacheWrite5m += write5m + residual;
    cacheWrite1h += write1h;
    cacheReadTokens += usage.cache_read_input_tokens || 0;
    cost += entryCost(usage, pricing);
  }

  if (apiTurns === 0) return null;

  const shortName = basename(filePath);
  const isCompact = shortName.includes("compact");

  return {
    file: filePath,
    shortName,
    date: firstTimestamp
      ? firstTimestamp.toISOString().slice(0, 10)
      : "unknown",
    timestamp: firstTimestamp || new Date(0),
    apiTurns,
    inputTokens,
    outputTokens,
    cacheWrite5m,
    cacheWrite1h,
    cacheReadTokens,
    cost,
    models,
    isCompact,
    isTopLevel,
    spawnedBy,
    unknownModelTurns,
  };
}

function pad(s: string, n: number, align: "left" | "right" = "right"): string {
  if (align === "left") return s.padEnd(n);
  return s.padStart(n);
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return n.toString();
}

function fmtCost(n: number): string {
  return "$" + n.toFixed(4);
}

function parseArgs(argv: string[]): { from: Date | null; to: Date | null } {
  let from: Date | null = null;
  let to: Date | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if ((arg === "--from" || arg === "--since") && i + 1 < argv.length) {
      from = new Date(argv[++i] + "T00:00:00Z");
    } else if ((arg === "--to" || arg === "--until") && i + 1 < argv.length) {
      to = new Date(argv[++i] + "T23:59:59Z");
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: bun scripts/token-economics.ts [--from YYYY-MM-DD] [--to YYYY-MM-DD]",
      );
      process.exit(0);
    }
  }
  if (from && Number.isNaN(from.getTime())) {
    console.error(`Invalid --from date`);
    process.exit(2);
  }
  if (to && Number.isNaN(to.getTime())) {
    console.error(`Invalid --to date`);
    process.exit(2);
  }
  return { from, to };
}

function summarizeModel(models: Set<string>): string {
  if (models.size === 0) return "-";
  if (models.size === 1) return [...models][0].replace(/^claude-/, "");
  return `${models.size} mixed`;
}

async function main() {
  const { from, to } = parseArgs(process.argv.slice(2));
  const rangeLabel =
    from || to
      ? `[${from ? from.toISOString().slice(0, 10) : "*"}..${to ? to.toISOString().slice(0, 10) : "*"}]`
      : "[all time]";

  const files = await findTranscriptFiles(BASE_DIR);
  const allSessions: SessionStats[] = [];
  for (const f of files) {
    const s = await analyzeFile(f);
    if (s) allSessions.push(s);
  }

  const sessions = allSessions.filter((s) => {
    if (from && s.timestamp < from) return false;
    if (to && s.timestamp > to) return false;
    return true;
  });

  console.log(`Found ${files.length} transcript JSONL files`);
  console.log(
    `In range ${rangeLabel}: ${sessions.length} sessions with API turns`,
  );
  console.log(
    `Pricing snapshot: ${PRICING_SNAPSHOT_DATE} (source: ${PRICING_SOURCE_URL})\n`,
  );

  sessions.sort((a, b) => {
    const d = a.timestamp.getTime() - b.timestamp.getTime();
    return d !== 0 ? d : a.shortName.localeCompare(b.shortName);
  });

  const cols = [
    { name: "Date", w: 12 },
    { name: "Session File", w: 42 },
    { name: "Model", w: 14 },
    { name: "Type", w: 8 },
    { name: "Turns", w: 7 },
    { name: "Input", w: 10 },
    { name: "Output", w: 10 },
    { name: "CW 5m", w: 10 },
    { name: "CW 1h", w: 10 },
    { name: "CacheRead", w: 12 },
    { name: "Cost", w: 10 },
  ];

  const header = cols.map((c) => pad(c.name, c.w, "left")).join(" | ");
  const sep = cols.map((c) => "-".repeat(c.w)).join("-+-");
  console.log("=== PER-SESSION TOKEN ECONOMICS ===\n");
  console.log(header);
  console.log(sep);

  for (const s of sessions) {
    const row = [
      pad(s.date, 12, "left"),
      pad(s.shortName, 42, "left"),
      pad(summarizeModel(s.models), 14, "left"),
      pad(s.isCompact ? "compact" : "agent", 8, "left"),
      pad(s.apiTurns.toString(), 7),
      pad(fmtTokens(s.inputTokens), 10),
      pad(fmtTokens(s.outputTokens), 10),
      pad(fmtTokens(s.cacheWrite5m), 10),
      pad(fmtTokens(s.cacheWrite1h), 10),
      pad(fmtTokens(s.cacheReadTokens), 12),
      pad(fmtCost(s.cost), 10),
    ];
    console.log(row.join(" | "));
  }

  const totalTurns = sessions.reduce((a, s) => a + s.apiTurns, 0);
  const totalInput = sessions.reduce((a, s) => a + s.inputTokens, 0);
  const totalOutput = sessions.reduce((a, s) => a + s.outputTokens, 0);
  const totalW5m = sessions.reduce((a, s) => a + s.cacheWrite5m, 0);
  const totalW1h = sessions.reduce((a, s) => a + s.cacheWrite1h, 0);
  const totalCacheRead = sessions.reduce((a, s) => a + s.cacheReadTokens, 0);
  const totalCost = sessions.reduce((a, s) => a + s.cost, 0);
  const unknownModel = sessions.reduce(
    (a, s) => a + s.unknownModelTurns,
    0,
  );

  console.log(sep);
  const totalRow = [
    pad("TOTAL", 12, "left"),
    pad("", 42, "left"),
    pad("", 14, "left"),
    pad("", 8, "left"),
    pad(totalTurns.toString(), 7),
    pad(fmtTokens(totalInput), 10),
    pad(fmtTokens(totalOutput), 10),
    pad(fmtTokens(totalW5m), 10),
    pad(fmtTokens(totalW1h), 10),
    pad(fmtTokens(totalCacheRead), 12),
    pad(fmtCost(totalCost), 10),
  ];
  console.log(totalRow.join(" | "));

  console.log(`\n=== SUMMARY ${rangeLabel} ===`);
  console.log(`  Sessions:            ${sessions.length}`);
  console.log(`  Total API turns:     ${totalTurns}`);
  if (unknownModel > 0) {
    console.log(
      `    (of which ${unknownModel} had unrecognized model — counted as turns but not costed)`,
    );
  }
  console.log(`  Input tokens:        ${fmtTokens(totalInput)}`);
  console.log(`  Output tokens:       ${fmtTokens(totalOutput)}`);
  console.log(`  Cache write 5m:      ${fmtTokens(totalW5m)}`);
  console.log(`  Cache write 1h:      ${fmtTokens(totalW1h)}`);
  console.log(`  Cache read:          ${fmtTokens(totalCacheRead)}`);
  console.log(`  Total cost:          ${fmtCost(totalCost)}`);
  if (sessions.length > 0) {
    console.log(
      `  Avg cost/session:    ${fmtCost(totalCost / sessions.length)}`,
    );
  }
  if (totalTurns > 0) {
    console.log(`  Avg cost/turn:       ${fmtCost(totalCost / totalTurns)}`);
  }

  const topLevel = sessions.filter((s) => s.isTopLevel);
  const nested = sessions.filter((s) => !s.isTopLevel);
  if (topLevel.length > 0 && nested.length > 0) {
    const topCost = topLevel.reduce((a, s) => a + s.cost, 0);
    const topTurns = topLevel.reduce((a, s) => a + s.apiTurns, 0);
    const nestedCost = nested.reduce((a, s) => a + s.cost, 0);
    const nestedTurns = nested.reduce((a, s) => a + s.apiTurns, 0);
    console.log(
      `\n  Split: worker ${topLevel.length} sess / ${topTurns} turns / ${fmtCost(topCost)}`,
    );
    console.log(
      `         subagent ${nested.length} sess / ${nestedTurns} turns / ${fmtCost(nestedCost)}`,
    );
  }

  // Nested subagents can be grouped by the outer session that spawned them
  // (captured in `spawnedBy`). Top-level worker transcripts have no meaningful
  // parent — they are listed individually in the main table above.
  if (nested.length > 0) {
    console.log("\n\n=== SUBAGENTS GROUPED BY SPAWNING SESSION ===");
    console.log(
      "(Top-level worker transcripts are listed individually in the main table.)",
    );
    const bySpawner = new Map<string, SessionStats[]>();
    for (const s of nested) {
      const key = s.spawnedBy || "(unknown spawner)";
      if (!bySpawner.has(key)) bySpawner.set(key, []);
      bySpawner.get(key)!.push(s);
    }

    const spawnerHeader = [
      pad("Spawned By (outer session id)", 40, "left"),
      pad("Date", 12, "left"),
      pad("Subagents", 10),
      pad("Compacts", 9),
      pad("Turns", 7),
      pad("Cost", 10),
    ].join(" | ");
    const spawnerSep = [40, 12, 10, 9, 7, 10]
      .map((w) => "-".repeat(w))
      .join("-+-");

    console.log(spawnerHeader);
    console.log(spawnerSep);

    const spawnerEntries = [...bySpawner.entries()].sort((a, b) => {
      const aDate = a[1][0].timestamp.getTime();
      const bDate = b[1][0].timestamp.getTime();
      return aDate - bDate;
    });

    for (const [spawner, subs] of spawnerEntries) {
      const agents = subs.filter((s) => !s.isCompact);
      const compacts = subs.filter((s) => s.isCompact);
      const turns = subs.reduce((a, s) => a + s.apiTurns, 0);
      const cost = subs.reduce((a, s) => a + s.cost, 0);
      const label =
        spawner.length > 38 ? spawner.slice(0, 38) + ".." : spawner;
      const row = [
        pad(label, 40, "left"),
        pad(subs[0].date, 12, "left"),
        pad(agents.length.toString(), 10),
        pad(compacts.length.toString(), 9),
        pad(turns.toString(), 7),
        pad(fmtCost(cost), 10),
      ];
      console.log(row.join(" | "));
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
