import type { Database } from "bun:sqlite";

import { runWriteTransaction } from "./database";
import { hasMigrationReceipt, writeMigrationReceipt } from "./lanes";
import { setSegmentTags } from "./segments";

/**
 * The one-tag migration (lane-model-v12 spec D3e, ticket 14).
 *
 * RECEIPT NAME, deliberately outside the `lane-declaration-` family: an
 * existing end-to-end test reads that prefix as the lane REGISTRY's phase set
 * (`LANE_REGISTRY_PHASE_RECEIPTS`, db/lanes.ts), and a v12 phase joining it
 * would silently change what "the registry has settled" means.
 *
 * WHAT IT DOES, and why it is mostly naming rather than shrinking. Measured
 * read-only on the live database before writing this: of the OPEN containers,
 * exactly two carry one curated tag each with zero collisions against any
 * other segment (E60 `claude-mnemo`, E9 `card-extraction-pipeline`); the rest
 * carry none. Every 29/21/18-tag monster and every globally colliding word
 * (`scene-data-v2` across four segments, `san11-spec-mvp-scope` across four…)
 * sits in a delivered / closed / abandoned segment. So:
 *
 *   - a segment that takes no new members (any status but `open`) has its
 *     derived list CLEARED. Uniqueness is meaningless for a container nothing
 *     can join, and a 29-element list makes derivation — "which segment's tag
 *     is this?" — unanswerable. Those words are still on the member turns
 *     themselves, so no information leaves the database.
 *   - an OPEN segment holding exactly one uncontested word KEEPS it: that word
 *     is now its identity, and membership derives from it.
 *   - an OPEN segment holding none, or several, or a word an earlier segment
 *     already holds, is left with NO tag and recorded as PENDING HUMAN NAMING.
 *     A name is a judgement about what the container is for; generating one
 *     would put a machine's guess into the position derivation reads.
 *
 * WHAT IT DOES NOT DO: it does not rewrite `segment_members`. Derivation
 * governs writes from here on (`deriveTurnSegmentMembership`, db/segments.ts);
 * applying it retroactively would evict the ~1085 E60 members whose notes
 * predate the tag (measured: 1670 members, 585 carrying `claude-mnemo`) and
 * conscript the ~101 turns carrying the word without the membership. Existing
 * memberships are grandfathered exactly as the legacy free-form tag VALUES are
 * (spec D3b), and for the same reason: neither is something a migration can
 * decide correctly.
 *
 * The unique index is created in the SAME transaction as the clearing, and can
 * only be created there: on today's database it would fail outright before the
 * duplicates are gone, which is why it lives here and not in `SCHEMA_SQL`.
 */
export const SEGMENT_ONE_TAG_RECEIPT = "lane-model-v12-segment-one-tag";

/** A container that now has a name, and derives its members from it. */
export interface SegmentOneTagNamed {
  segmentId: number;
  tag: string;
}

/** A container left unnamed. `clearedTags` is what it used to carry — empty means it never carried anything. */
export interface SegmentOneTagPending {
  segmentId: number;
  status: string;
  clearedTags: string[];
  reason: "none" | "several" | "collision";
  /** For `collision` only: the segment that keeps the contested word. */
  heldBy?: number;
}

/** A container that takes no new members; its derived list is emptied. */
export interface SegmentOneTagRetired {
  segmentId: number;
  status: string;
  clearedTags: string[];
}

export interface SegmentOneTagReceipt {
  named: SegmentOneTagNamed[];
  pendingNaming: SegmentOneTagPending[];
  retired: SegmentOneTagRetired[];
}

interface SegmentTagRow {
  id: number;
  status: string;
  tags: string;
}

function parseTags(raw: string | null): string[] {
  if (raw === null) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === "string") : [];
  } catch {
    return [];
  }
}

/**
 * `segments.tags` holds 0 or 1 element from here on, and the element is
 * globally unique. Expression index rather than a column CHECK: adding a CHECK
 * needs a 12-step rebuild of a table half the codebase reads, while the half
 * of the rule that has to be STRUCTURAL is uniqueness — "at most one" is
 * enforced by the write face (`setSegmentTag`) and by this migration, and a
 * legacy multi-tag row could only appear on a database mid-upgrade, where the
 * index still pins its first element.
 */
export const SEGMENT_TAG_UNIQUE_INDEX_DDL = `
  CREATE UNIQUE INDEX IF NOT EXISTS idx_segments_tag_unique
    ON segments(json_extract(tags, '$[0]'))
    WHERE json_array_length(tags) >= 1
`;

export function runSegmentOneTagMigration(
  db: Database,
  nowEpoch: number = Math.floor(Date.now() / 1000),
): void {
  runWriteTransaction(db, () => {
    if (hasMigrationReceipt(db, SEGMENT_ONE_TAG_RECEIPT)) {
      return;
    }

    const rows = db
      .query<SegmentTagRow, []>("SELECT id, status, tags FROM segments ORDER BY id")
      .all();

    const named: SegmentOneTagNamed[] = [];
    const pendingNaming: SegmentOneTagPending[] = [];
    const retired: SegmentOneTagRetired[] = [];
    const claimed = new Map<string, number>();
    // Through `setSegmentTags`, not a raw UPDATE: a segment is FTS-indexed
    // WITH its tags, so a cleared row that skipped the reindex would leave
    // `tags:` search answering from a vocabulary that no longer exists.
    const clear = (segmentId: number): void => {
      setSegmentTags(db, segmentId, [], nowEpoch);
    };

    for (const row of rows) {
      const tags = parseTags(row.tags);

      if (row.status !== "open") {
        if (tags.length > 0) {
          clear(row.id);
          retired.push({ segmentId: row.id, status: row.status, clearedTags: tags });
        }
        continue;
      }

      if (tags.length === 0) {
        pendingNaming.push({
          segmentId: row.id,
          status: row.status,
          clearedTags: [],
          reason: "none",
        });
        continue;
      }

      if (tags.length > 1) {
        clear(row.id);
        pendingNaming.push({
          segmentId: row.id,
          status: row.status,
          clearedTags: tags,
          reason: "several",
        });
        continue;
      }

      const tag = tags[0]!;
      const holder = claimed.get(tag);
      if (holder !== undefined) {
        clear(row.id);
        pendingNaming.push({
          segmentId: row.id,
          status: row.status,
          clearedTags: tags,
          reason: "collision",
          heldBy: holder,
        });
        continue;
      }
      claimed.set(tag, row.id);
      named.push({ segmentId: row.id, tag });
    }

    // After the clearing, never before: on the live database the duplicates
    // above are what would make this statement throw.
    db.exec(SEGMENT_TAG_UNIQUE_INDEX_DDL);

    const receipt: SegmentOneTagReceipt = { named, pendingNaming, retired };
    writeMigrationReceipt(db, SEGMENT_ONE_TAG_RECEIPT, nowEpoch, receipt);
  });
}
