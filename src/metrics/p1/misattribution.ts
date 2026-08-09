import type { Database } from "bun:sqlite";

import { agentAuthoredNotePredicate } from "../../db/shadow-notes";
import { formatTurnAddress } from "../../hooks/note-reminder";

/**
 * Metric (c): how often a piece of text ends up attached to a turn that did not
 * produce it — the failure the trial exists to remove (spec's Problem Statement:
 * nine measured mis-attachments in S15069, all of them an observer guessing
 * ownership from a transcript stream after the fact).
 *
 * Detection rule, and what it can and cannot see:
 *
 *   Within one session, two turns whose text is identical — or where one is a
 *   long prefix of the other — cannot both be original. The earliest turn is
 *   taken as the owner and every later member of the cluster is counted as a
 *   victim, so the unit of the rate is "wrongly attributed turns", the same unit
 *   as the nine-mis-attachment baseline.
 *
 *   This catches the RE-ATTACH class (the same response written onto a second
 *   turn) and the TRUNCATED re-attach (a prefix). It does NOT catch a pure SHIFT
 *   — every response landing one turn late, each appearing exactly once — which
 *   leaves no duplicate in the database at all and can only be found by
 *   re-deriving ownership from the transcript. The rate is therefore a lower
 *   bound, and the trial should read it as one.
 *
 * Three channels share the rule so the numbers are comparable:
 *   - `response`     turns.assistant_response, the transcript-derived capture;
 *   - `legacy-note`  turns.title + content, what the old pipeline wrote;
 *   - `shadow-note`  shadow_notes.title + content, the agent's own notes, which
 *                    are structurally immune (the note names its own turn id) —
 *                    a hit there means the agent wrote the same note twice, not
 *                    that the system mis-attributed anything.
 *
 * Rolled-back and interrupted turns produce legitimate near-repeats (a retry
 * re-answers the same prompt), so they are annotated rather than filtered: the
 * report carries both the raw victim count and the count that survives
 * discounting them, and the caller decides which one the baseline compares to.
 */

export type MisattributionChannel = "response" | "legacy-note" | "shadow-note";

export const MISATTRIBUTION_CHANNELS: MisattributionChannel[] = [
  "response",
  "legacy-note",
  "shadow-note",
];

export const DEFAULT_MIN_CHARACTERS = 80;
export const DEFAULT_PREFIX_RATIO = 0.5;
const PREFIX_KEY_CHARACTERS = 64;

export interface MisattributionOptions {
  sessionId?: number;
  minCharacters?: number;
  prefixRatio?: number;
  channels?: MisattributionChannel[];
}

export interface DuplicateMember {
  turnId: number;
  turnRef: string;
  promptNumber: number;
  characters: number;
  wasInterrupted: boolean;
  wasRolledBack: boolean;
}

export interface DuplicateCluster {
  channel: MisattributionChannel;
  sessionId: number;
  kind: "exact" | "prefix";
  members: DuplicateMember[];
  /** Victims = every member after the earliest one. */
  victims: number;
  sample: string;
}

export interface ChannelReport {
  channel: MisattributionChannel;
  eligible: number;
  clusters: number;
  victims: number;
  /** Victims left after discounting rolled-back / interrupted turns. */
  victimsExcludingRetries: number;
  rate: number | null;
  rateExcludingRetries: number | null;
}

export interface MisattributionReport {
  minCharacters: number;
  prefixRatio: number;
  channels: ChannelReport[];
  clusters: DuplicateCluster[];
  missingChannels: MisattributionChannel[];
}

interface TextRow {
  turnId: number;
  sessionId: number;
  promptNumber: number;
  text: string | null;
  wasInterrupted: number;
  wasRolledBack: number;
}

export function normalizeForSignature(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

function channelSql(channel: MisattributionChannel): string {
  const source =
    channel === "response"
      ? "t.assistant_response"
      : channel === "legacy-note"
        ? "COALESCE(t.title, '') || ' ' || COALESCE(t.content, '')"
        : "COALESCE(n.title, '') || ' ' || COALESCE(n.content, '')";

  const join =
    channel === "shadow-note"
      ? `JOIN shadow_notes n ON n.turn_id = t.id AND ${agentAuthoredNotePredicate()}`
      : "";

  return `
    SELECT
      t.id AS turnId,
      t.session_id AS sessionId,
      t.prompt_number AS promptNumber,
      ${source} AS text,
      t.was_interrupted AS wasInterrupted,
      t.was_rolled_back AS wasRolledBack
    FROM turns t
    ${join}
    __WHERE__
    ORDER BY t.session_id ASC, t.prompt_number ASC
  `;
}

function loadChannel(
  db: Database,
  channel: MisattributionChannel,
  sessionId?: number,
): TextRow[] {
  const sql = channelSql(channel).replace(
    "__WHERE__",
    sessionId === undefined ? "" : "WHERE t.session_id = ?",
  );

  return sessionId === undefined
    ? db.query<TextRow, []>(sql).all()
    : db.query<TextRow, [number]>(sql).all(sessionId);
}

interface Candidate {
  row: TextRow;
  text: string;
}

class UnionFind {
  private readonly parent: number[];

  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, index) => index);
  }

  find(node: number): number {
    let root = node;
    while (this.parent[root] !== root) {
      root = this.parent[root]!;
    }
    let cursor = node;
    while (this.parent[cursor] !== root) {
      const next = this.parent[cursor]!;
      this.parent[cursor] = root;
      cursor = next;
    }
    return root;
  }

  union(left: number, right: number): void {
    const leftRoot = this.find(left);
    const rightRoot = this.find(right);
    if (leftRoot !== rightRoot) {
      this.parent[rightRoot] = leftRoot;
    }
  }
}

/**
 * Cluster one session's texts. Bucketing on the first 64 characters is what
 * keeps this near-linear: a prefix relation between two texts that are both at
 * least `minCharacters` long implies an identical 64-character head, so no
 * candidate pair can fall in two different buckets.
 */
function clusterSession(
  candidates: Candidate[],
  minCharacters: number,
  prefixRatio: number,
): Candidate[][] {
  const buckets = new Map<string, number[]>();
  candidates.forEach((candidate, index) => {
    const key = candidate.text.slice(0, PREFIX_KEY_CHARACTERS);
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.push(index);
    } else {
      buckets.set(key, [index]);
    }
  });

  const unionFind = new UnionFind(candidates.length);

  for (const bucket of buckets.values()) {
    if (bucket.length < 2) {
      continue;
    }

    const ordered = [...bucket].sort(
      (left, right) =>
        candidates[left]!.text.length - candidates[right]!.text.length,
    );

    for (let i = 0; i < ordered.length; i += 1) {
      const shorter = candidates[ordered[i]!]!.text;
      for (let j = i + 1; j < ordered.length; j += 1) {
        const longer = candidates[ordered[j]!]!.text;
        // Lengths ascend, so once the shorter text is too small a share of the
        // longer one, it is too small for every remaining candidate too.
        if (shorter.length < prefixRatio * longer.length) {
          break;
        }
        if (shorter.length >= minCharacters && longer.startsWith(shorter)) {
          unionFind.union(ordered[i]!, ordered[j]!);
        }
      }
    }
  }

  const groups = new Map<number, Candidate[]>();
  candidates.forEach((candidate, index) => {
    const root = unionFind.find(index);
    const group = groups.get(root);
    if (group) {
      group.push(candidate);
    } else {
      groups.set(root, [candidate]);
    }
  });

  return [...groups.values()].filter((group) => group.length > 1);
}

function toCluster(
  channel: MisattributionChannel,
  group: Candidate[],
): DuplicateCluster {
  const ordered = [...group].sort(
    (left, right) => left.row.promptNumber - right.row.promptNumber,
  );
  const distinct = new Set(ordered.map((candidate) => candidate.text));

  return {
    channel,
    sessionId: ordered[0]!.row.sessionId,
    kind: distinct.size === 1 ? "exact" : "prefix",
    members: ordered.map((candidate) => ({
      turnId: candidate.row.turnId,
      turnRef: formatTurnAddress({
        sessionId: candidate.row.sessionId,
        promptNumber: candidate.row.promptNumber,
      }),
      promptNumber: candidate.row.promptNumber,
      characters: candidate.text.length,
      wasInterrupted: candidate.row.wasInterrupted === 1,
      wasRolledBack: candidate.row.wasRolledBack === 1,
    })),
    victims: ordered.length - 1,
    sample: ordered[0]!.text.slice(0, 120),
  };
}

export function detectMisattribution(
  db: Database,
  options: MisattributionOptions = {},
): MisattributionReport {
  const minCharacters = options.minCharacters ?? DEFAULT_MIN_CHARACTERS;
  const prefixRatio = options.prefixRatio ?? DEFAULT_PREFIX_RATIO;
  const requested = options.channels ?? MISATTRIBUTION_CHANNELS;

  const hasShadowNotes =
    db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'shadow_notes'",
      )
      .get() !== null;

  const channels: ChannelReport[] = [];
  const clusters: DuplicateCluster[] = [];
  const missingChannels: MisattributionChannel[] = [];

  for (const channel of requested) {
    if (channel === "shadow-note" && !hasShadowNotes) {
      missingChannels.push(channel);
      continue;
    }

    const rows = loadChannel(db, channel, options.sessionId);
    const bySession = new Map<number, Candidate[]>();
    let eligible = 0;

    for (const row of rows) {
      const text = normalizeForSignature(row.text ?? "");
      if (text.length < minCharacters) {
        continue;
      }
      eligible += 1;
      const bucket = bySession.get(row.sessionId);
      if (bucket) {
        bucket.push({ row, text });
      } else {
        bySession.set(row.sessionId, [{ row, text }]);
      }
    }

    let victims = 0;
    let victimsExcludingRetries = 0;
    let clusterCount = 0;

    for (const candidates of bySession.values()) {
      for (const group of clusterSession(
        candidates,
        minCharacters,
        prefixRatio,
      )) {
        const cluster = toCluster(channel, group);
        clusters.push(cluster);
        clusterCount += 1;
        victims += cluster.victims;
        victimsExcludingRetries += cluster.members
          .slice(1)
          .filter((member) => !member.wasRolledBack && !member.wasInterrupted)
          .length;
      }
    }

    channels.push({
      channel,
      eligible,
      clusters: clusterCount,
      victims,
      victimsExcludingRetries,
      rate: eligible > 0 ? victims / eligible : null,
      rateExcludingRetries:
        eligible > 0 ? victimsExcludingRetries / eligible : null,
    });
  }

  clusters.sort(
    (left, right) =>
      right.victims - left.victims ||
      left.sessionId - right.sessionId ||
      left.members[0]!.promptNumber - right.members[0]!.promptNumber,
  );

  return {
    minCharacters,
    prefixRatio,
    channels,
    clusters,
    missingChannels,
  };
}
