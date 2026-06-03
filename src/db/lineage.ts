import type { Database } from "bun:sqlite";

import {
  collectOrderedPromptIds,
  readAllTranscriptEntries,
} from "../shared/transcript-parser";
import {
  getSession,
  setSessionLineageStatus,
  setSessionParent,
} from "./sessions";
import { getFirstTurn, setTurnParent } from "./turns";

export function linkIntraSessionChain(db: Database, sessionDbId: number): void {
  db.query(
    `UPDATE turns SET parent_turn_id = (
       SELECT p.id FROM turns p
       WHERE p.session_id = turns.session_id AND p.prompt_number < turns.prompt_number
       ORDER BY p.prompt_number DESC LIMIT 1
     )
     WHERE session_id = ? AND parent_turn_id IS NULL
       AND EXISTS (
         SELECT 1 FROM turns p
         WHERE p.session_id = turns.session_id AND p.prompt_number < turns.prompt_number
       )`,
  ).run(sessionDbId);
}

export type Ownership = "foreign" | "child" | "unknown";

export interface OwnerInfo {
  sessionId: number;
  turnId: number;
  promptNumber: number;
}

export interface PromptOwnership {
  ownership: Ownership;
  owners: OwnerInfo[];
}

// Batch size for the ownership IN(...) lookup. A --fork-session child copies
// long parent history, so the distinct-promptId count can grow large; chunking
// keeps each query under SQLite's bind-variable limit and bounds Stop-time cost.
const OWNERSHIP_QUERY_CHUNK = 500;

export function classifyPromptOwnership(
  db: Database,
  childSessionId: number,
  promptIds: string[],
): Map<string, PromptOwnership> {
  const result = new Map<string, PromptOwnership>();
  for (const p of promptIds) result.set(p, { ownership: "unknown", owners: [] });
  if (promptIds.length === 0) return result;

  // Run the lookup in batches and merge owners into the result Map; the Map is
  // already pre-populated with every input promptId as "unknown", so any id
  // with no matching row stays "unknown".
  for (let start = 0; start < promptIds.length; start += OWNERSHIP_QUERY_CHUNK) {
    const chunk = promptIds.slice(start, start + OWNERSHIP_QUERY_CHUNK);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = db
      .query<
        { content_prompt_id: string; session_id: number; turn_id: number; prompt_number: number },
        string[]
      >(
        `SELECT content_prompt_id, session_id, id AS turn_id, prompt_number
         FROM turns
         WHERE content_prompt_id IN (${placeholders}) AND content_prompt_id IS NOT NULL`,
      )
      .all(...chunk);

    for (const row of rows) {
      result.get(row.content_prompt_id)!.owners.push({
        sessionId: row.session_id,
        turnId: row.turn_id,
        promptNumber: row.prompt_number,
      });
    }
  }

  // Classify AFTER all chunks are merged so multi-owner detection sees every row.
  for (const [, e] of result) {
    if (e.owners.length === 0) {
      e.ownership = "unknown";
    } else if (e.owners.some((o) => o.sessionId !== childSessionId)) {
      e.ownership = "foreign";
    } else {
      e.ownership = "child";
    }
  }

  return result;
}

export interface LineageResolution {
  status: "resolved" | "unresolved" | "root";
  parentSessionId?: number;
  forkTurnId?: number;
}

// Confidence check (spec §2.1): the inherited prefix is a genuine leading
// inherited block only when its foreign hits form one contiguous run anchored
// at the start of the prefix. A scattered/lone foreign hit separated from the
// leading block by a gap is not trustworthy → demote to unresolved. A prefix
// with no foreign entry at all (empty or all-unknown) is not a foreign run.
export function isContiguousRun(prefixOwnerships: Ownership[]): boolean {
  const first = prefixOwnerships.indexOf("foreign");
  if (first === -1) return false;
  let last = first;
  for (let i = first; i < prefixOwnerships.length; i += 1) {
    if (prefixOwnerships[i] === "foreign") last = i;
  }
  // Every entry between the first and last foreign hit must also be foreign
  // (no gap → genuine contiguous block). Unknowns may trail after the block.
  for (let i = first; i <= last; i += 1) {
    if (prefixOwnerships[i] !== "foreign") return false;
  }
  return true;
}

// Tie-break (spec §2.1, round-5 #2) when a foreign promptId has multiple
// foreign owners (content_prompt_id is not globally unique):
//   (a) owner sharing the longest contiguous prefix overlap with the child's
//       inherited prefix;
//   (b) else owner whose createdAtEpoch is closest-but-earlier than the child;
//   (c) else null (caller treats as unresolved) — never pick by row order.
// `overlapBySession` maps an owner's sessionId → its contiguous-prefix-overlap
// length with the child's inherited prefix (0 when no signal). `childCreated`
// is the child session's createdAtEpoch.
export function pickForeignOwner(
  owners: OwnerInfo[],
  overlapBySession: Array<{ sessionId: number; overlap: number }>,
  childCreated: number,
  db?: Database,
): OwnerInfo | null {
  if (owners.length === 0) return null;
  if (owners.length === 1) return owners[0]!;

  // (a) longest contiguous prefix overlap.
  const overlapMap = new Map<number, number>();
  for (const { sessionId, overlap } of overlapBySession) {
    overlapMap.set(sessionId, Math.max(overlapMap.get(sessionId) ?? 0, overlap));
  }
  let bestOverlap = -1;
  let overlapWinners: OwnerInfo[] = [];
  for (const owner of owners) {
    const ov = overlapMap.get(owner.sessionId) ?? 0;
    if (ov > bestOverlap) {
      bestOverlap = ov;
      overlapWinners = [owner];
    } else if (ov === bestOverlap) {
      overlapWinners.push(owner);
    }
  }
  if (bestOverlap > 0 && overlapWinners.length === 1) {
    return overlapWinners[0]!;
  }
  const contenders = bestOverlap > 0 ? overlapWinners : owners;

  // (b) createdAt closest-but-earlier than the child.
  if (db) {
    let best: OwnerInfo | null = null;
    let bestCreated = -1;
    let tied = false;
    for (const owner of contenders) {
      const session = getSession(db, owner.sessionId);
      const created = session?.createdAtEpoch;
      if (created === undefined || created > childCreated) continue;
      if (created > bestCreated) {
        bestCreated = created;
        best = owner;
        tied = false;
      } else if (created === bestCreated) {
        tied = true;
      }
    }
    if (best && !tied) return best;
  }

  // (c) still tied / no signal → never pick by row order.
  return null;
}

// Zero-overlap fallback (spec §2.2): when no direct foreign match is found,
// follow a compact_boundary's logicalParentUuid one hop to the inherited entry
// with that uuid, take its promptId, and resolve if it is foreign-owned. Give
// up if the hop lands on another boundary or a non-foreign entry.
export function resolveViaLogicalParent(
  db: Database,
  transcriptPath: string,
  childSessionId: number,
  ownership: Map<string, PromptOwnership>,
): LineageResolution | null {
  const entries = readAllTranscriptEntries(transcriptPath);
  const byUuid = new Map<string, (typeof entries)[number]>();
  for (const e of entries) {
    if (e.uuid && !byUuid.has(e.uuid)) byUuid.set(e.uuid, e);
  }

  for (const boundary of entries) {
    if (boundary.subtype !== "compact_boundary") continue;
    const targetUuid = boundary.logicalParentUuid;
    if (!targetUuid) continue;
    const target = byUuid.get(targetUuid);
    if (!target) continue;
    // One hop only: don't chase a boundary that points at another boundary.
    if (target.subtype === "compact_boundary") continue;
    const promptId = target.promptId;
    if (!promptId) continue;
    const own =
      ownership.get(promptId) ?? classifyPromptOwnership(db, childSessionId, [promptId]).get(promptId);
    if (!own || own.ownership !== "foreign") continue;
    const owner = pickForeignOwner(
      own.owners.filter((o) => o.sessionId !== childSessionId),
      [],
      getSession(db, childSessionId)?.createdAtEpoch ?? Number.MAX_SAFE_INTEGER,
      db,
    );
    if (!owner) continue;
    return {
      status: "resolved",
      parentSessionId: owner.sessionId,
      forkTurnId: owner.turnId,
    };
  }
  return null;
}

export function resolveSessionLineage(
  db: Database,
  childSessionId: number,
  transcriptPath: string | null,
): LineageResolution {
  // 1. No transcript → unresolved (retryable; Step A still runs elsewhere).
  if (!transcriptPath) return { status: "unresolved" };

  // 2. Scan the child transcript + classify each promptId by ownership.
  const entries = readAllTranscriptEntries(transcriptPath);
  const ordered = collectOrderedPromptIds(entries);
  // No ordered prompts (missing/empty/unreadable transcript) → unresolved, not
  // a terminal root. `root` requires positive transcript evidence (the
  // session's own child-owned prompt); without it, stay retryable on the next
  // Stop so a transient empty transcript can't permanently freeze a fork.
  if (ordered.length === 0) return { status: "unresolved" };
  const own = classifyPromptOwnership(
    db,
    childSessionId,
    ordered.map((o) => o.promptId),
  );
  const hasBoundary = entries.some((e) => e.subtype === "compact_boundary");

  const ownershipOf = (promptId: string): Ownership =>
    own.get(promptId)?.ownership ?? "unknown";

  // 3. Boundary index = position in `ordered` of the first purely child-owned
  // promptId. Inherited prefix = ordered entries before it (whole list if none).
  let boundaryIndex = ordered.findIndex((o) => ownershipOf(o.promptId) === "child");
  if (boundaryIndex === -1) boundaryIndex = ordered.length;
  const prefix = ordered.slice(0, boundaryIndex);
  const prefixOwnerships = prefix.map((o) => ownershipOf(o.promptId));

  // 4. Partition the prefix.
  const foreignInPrefix = prefix.filter((o) => ownershipOf(o.promptId) === "foreign");
  const unknownInPrefix = prefix.filter((o) => ownershipOf(o.promptId) === "unknown");

  // 5. resolved — foreign in prefix that passes the confidence check. Pick the
  // foreign promptId at the LATEST index in the prefix (position-based, never
  // parent prompt_number). Disambiguate multi-owner via pickForeignOwner.
  if (foreignInPrefix.length > 0 && isContiguousRun(prefixOwnerships)) {
    const latestForeign = foreignInPrefix[foreignInPrefix.length - 1]!;
    const entry = own.get(latestForeign.promptId)!;
    const foreignOwners = entry.owners.filter((o) => o.sessionId !== childSessionId);

    // Overlap signal for the tie-break: how many contiguous prefix promptIds
    // (counting back from the fork point) does each candidate owner also own?
    const overlapBySession = computePrefixOverlap(prefix, foreignOwners, own, childSessionId);
    const childCreated = getSession(db, childSessionId)?.createdAtEpoch ?? Number.MAX_SAFE_INTEGER;
    const owner = pickForeignOwner(foreignOwners, overlapBySession, childCreated, db);

    if (owner) {
      return {
        status: "resolved",
        parentSessionId: owner.sessionId,
        forkTurnId: owner.turnId,
      };
    }
    // Multi-owner that couldn't be disambiguated → unresolved (never row order).
    return { status: "unresolved" };
  }

  // 6. logicalParentUuid fallback — no direct foreign match in the prefix.
  const viaLogical = resolveViaLogicalParent(db, transcriptPath, childSessionId, own);
  if (viaLogical) return viaLogical;

  // 7. root vs unresolved.
  // (a) clean start: no boundary AND no inherited foreign/unknown prefix.
  if (!hasBoundary && foreignInPrefix.length === 0 && unknownInPrefix.length === 0) {
    return { status: "root" };
  }
  // (b) proven in-place compact: a boundary present AND every prefix promptId is
  // child-owned (this session's own earlier turns). The prefix here contains no
  // foreign and no unknown (it would have returned/fallen through otherwise);
  // a non-empty all-child prefix is impossible (child-owned marks the boundary),
  // so proven-in-place is the empty-prefix-with-boundary case where the
  // boundary's pre-boundary prompts are this session's own turns.
  if (hasBoundary && foreignInPrefix.length === 0 && unknownInPrefix.length === 0) {
    return { status: "root" };
  }
  // Otherwise: boundary/foreign/unknown prefix that didn't resolve → unresolved.
  return { status: "unresolved" };
}

// Orchestrator run per-session at Stop (spec §4). Step A always chains the
// intra-session turns. Step B resolves the parent and atomically writes the
// first-turn edge + parent_session_id + lineage_status together, so a "resolved"
// session is never left in a partial state (edge-without-parent, etc).
// `lineage_status` is 4-state: only `resolved`/`root` are terminal; `unchecked`
// (default) and `unresolved` retry on later calls. `nowEpoch` is accepted for
// signature consistency with the Stop caller / future use (the setters write no
// timestamp today, so it is intentionally not referenced here).
export function relinkSessionLineage(
  db: Database,
  sessionDbId: number,
  transcriptPath: string | null,
  nowEpoch: number,
): void {
  void nowEpoch;
  linkIntraSessionChain(db, sessionDbId); // Step A (always)

  const session = getSession(db, sessionDbId);
  if (!session) return;
  // Terminal: never re-resolve a session whose lineage is already settled.
  if (session.lineageStatus === "resolved" || session.lineageStatus === "root") {
    return;
  }

  const res = resolveSessionLineage(db, sessionDbId, transcriptPath);

  // Step B — atomic: edge + parent + status commit (or roll back) together.
  db.transaction(() => {
    if (
      res.status === "resolved" &&
      res.forkTurnId != null &&
      res.parentSessionId != null
    ) {
      const first = getFirstTurn(db, sessionDbId);
      if (first) setTurnParent(db, first.id, res.forkTurnId);
      setSessionParent(db, sessionDbId, res.parentSessionId);
      setSessionLineageStatus(db, sessionDbId, "resolved");
    } else if (res.status === "root") {
      setSessionLineageStatus(db, sessionDbId, "root");
    } else {
      setSessionLineageStatus(db, sessionDbId, "unresolved");
    }
  })();
}

// Longest-contiguous-prefix-overlap signal for the multi-owner tie-break.
// Walking the inherited prefix backward from the fork point, count how many
// consecutive promptIds each candidate foreign owner's session also owns.
function computePrefixOverlap(
  prefix: Array<{ promptId: string; index: number }>,
  foreignOwners: OwnerInfo[],
  ownership: Map<string, PromptOwnership>,
  childSessionId: number,
): Array<{ sessionId: number; overlap: number }> {
  const candidateSessions = new Set(foreignOwners.map((o) => o.sessionId));
  const out: Array<{ sessionId: number; overlap: number }> = [];
  for (const sessionId of candidateSessions) {
    let overlap = 0;
    for (let i = prefix.length - 1; i >= 0; i -= 1) {
      const own = ownership.get(prefix[i]!.promptId);
      const ownedByCandidate =
        own?.owners.some(
          (o) => o.sessionId === sessionId && sessionId !== childSessionId,
        ) ?? false;
      if (ownedByCandidate) overlap += 1;
      else break;
    }
    out.push({ sessionId, overlap });
  }
  return out;
}
