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
 *   leaves no duplicate in the database at all. The rate is therefore a lower
 *   bound, and the trial should read it as one.
 *
 *   `detectShiftCandidates` below approximates the missing half for the shadow
 *   channel: a note whose vocabulary matches a NEIGHBOUR turn's prompt+response
 *   clearly better than its own turn's is a shift candidate. Candidates, not
 *   victims. False positives: a dispatch turn's note legitimately shares
 *   vocabulary with the turn where the dispatched work lands, and any
 *   same-topic run inflates neighbour overlap. False negatives: a shift onto a
 *   turn beyond ±2, a note paraphrased away from the response's wording, and
 *   notes whose own turn has no captured response are not evaluated at all
 *   (reported as skipped, never as clean). The heuristic was validated on the
 *   S19773 chain — two consecutive notes each describing the next turn's work,
 *   found by eye first.
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

export const DEFAULT_SHIFT_MARGIN = 0.15;
export const DEFAULT_SHIFT_FLOOR = 0.35;
const SHIFT_NEIGHBOR_DISTANCE = 2;

export interface ShiftCandidate {
  turnId: number;
  turnRef: string;
  bestNeighborRef: string;
  ownOverlap: number;
  neighborOverlap: number;
  title: string;
}

export interface ShiftCandidateReport {
  margin: number;
  floor: number;
  neighborDistance: number;
  /** Notes actually evaluated — ones with tokens AND their own turn's text. */
  notesConsidered: number;
  /** Notes skipped for lack of either, so "0 flagged" cannot pose as clean. */
  notesSkipped: number;
  candidates: ShiftCandidate[];
}

/**
 * Words long enough to be discriminating: latin runs of four or more, and CJK
 * BIGRAMS. A whole CJK run as one token would only match when the two texts
 * share the entire run — Chinese has no spaces, so a shared phrase inside two
 * different sentences would never register; sliding bigrams are the standard
 * cure. Shorter latin tokens are shared by every turn of a session and would
 * flatten the overlap signal to noise.
 */
function overlapTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  const lowered = text.toLowerCase();
  for (const latin of lowered.match(/[a-z]{4,}/gu) ?? []) {
    tokens.add(latin);
  }
  for (const run of lowered.match(/[一-鿿]{2,}/gu) ?? []) {
    for (let index = 0; index + 2 <= run.length; index += 1) {
      tokens.add(run.slice(index, index + 2));
    }
  }
  return tokens;
}

function overlapShare(note: Set<string>, turn: Set<string>): number {
  if (note.size === 0) {
    return 0;
  }
  let shared = 0;
  for (const token of note) {
    if (turn.has(token)) {
      shared += 1;
    }
  }
  return shared / note.size;
}

/** The pure-shift complement of `detectMisattribution` — see the module doc. */
export function detectShiftCandidates(
  db: Database,
  options: { sessionId?: number; margin?: number; floor?: number } = {},
): ShiftCandidateReport {
  const margin = options.margin ?? DEFAULT_SHIFT_MARGIN;
  const floor = options.floor ?? DEFAULT_SHIFT_FLOOR;

  const hasShadowNotes =
    db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'shadow_notes'",
      )
      .get() !== null;
  if (!hasShadowNotes) {
    return {
      margin,
      floor,
      neighborDistance: SHIFT_NEIGHBOR_DISTANCE,
      notesConsidered: 0,
      notesSkipped: 0,
      candidates: [],
    };
  }

  interface NoteRow {
    turnId: number;
    sessionId: number;
    promptNumber: number;
    title: string;
    content: string;
  }
  const whereSession = options.sessionId === undefined ? "" : "AND t.session_id = ?";
  const noteSql = `
    SELECT t.id AS turnId, t.session_id AS sessionId,
           t.prompt_number AS promptNumber, n.title AS title, n.content AS content
    FROM shadow_notes n
    JOIN turns t ON t.id = n.turn_id AND ${agentAuthoredNotePredicate()}
    WHERE 1 = 1 ${whereSession}
    ORDER BY t.session_id ASC, t.prompt_number ASC`;
  const notes =
    options.sessionId === undefined
      ? db.query<NoteRow, []>(noteSql).all()
      : db.query<NoteRow, [number]>(noteSql).all(options.sessionId);

  // One turn-text lookup per session actually holding notes, not the whole
  // corpus: the neighbour window is ±2, so only sessions in play are loaded.
  const sessionIds = [...new Set(notes.map((note) => note.sessionId))];
  const turnTokens = new Map<string, Set<string>>();
  for (const sessionId of sessionIds) {
    const rows = db
      .query<
        { promptNumber: number; text: string },
        [number]
      >(
        `SELECT prompt_number AS promptNumber,
                COALESCE(user_prompt, '') || ' ' || COALESCE(assistant_response, '') AS text
         FROM turns WHERE session_id = ? AND assistant_response IS NOT NULL`,
      )
      .all(sessionId);
    for (const row of rows) {
      turnTokens.set(`${sessionId}/${row.promptNumber}`, overlapTokens(row.text));
    }
  }

  const candidates: ShiftCandidate[] = [];
  let evaluated = 0;
  let skipped = 0;
  for (const note of notes) {
    const tokens = overlapTokens(`${note.title} ${note.content}`);
    const own = turnTokens.get(`${note.sessionId}/${note.promptNumber}`);
    if (tokens.size === 0 || !own) {
      skipped += 1;
      continue;
    }
    evaluated += 1;
    const ownOverlap = overlapShare(tokens, own);

    let neighborOverlap = 0;
    let neighborPrompt: number | null = null;
    for (
      let distance = -SHIFT_NEIGHBOR_DISTANCE;
      distance <= SHIFT_NEIGHBOR_DISTANCE;
      distance += 1
    ) {
      if (distance === 0) {
        continue;
      }
      const other = turnTokens.get(
        `${note.sessionId}/${note.promptNumber + distance}`,
      );
      if (!other) {
        continue;
      }
      const share = overlapShare(tokens, other);
      if (share > neighborOverlap) {
        neighborOverlap = share;
        neighborPrompt = note.promptNumber + distance;
      }
    }

    if (
      neighborPrompt !== null &&
      neighborOverlap > floor &&
      neighborOverlap > ownOverlap + margin
    ) {
      candidates.push({
        turnId: note.turnId,
        turnRef: formatTurnAddress({
          sessionId: note.sessionId,
          promptNumber: note.promptNumber,
        }),
        bestNeighborRef: formatTurnAddress({
          sessionId: note.sessionId,
          promptNumber: neighborPrompt,
        }),
        ownOverlap,
        neighborOverlap,
        title: note.title,
      });
    }
  }

  return {
    margin,
    floor,
    neighborDistance: SHIFT_NEIGHBOR_DISTANCE,
    notesConsidered: evaluated,
    notesSkipped: skipped,
    candidates,
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
