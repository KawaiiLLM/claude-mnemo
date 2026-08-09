import type { Database } from "bun:sqlite";

import { runWriteTransaction } from "../db/database";
import {
  closeNoteDebtAsDeclined,
  closeNoteDebtAsNoted,
  getNoteDebt,
  type NoteDebtRecord,
} from "../db/note-debt";
import { getShadowNote, upsertShadowNote } from "../db/shadow-notes";
import { getTurn } from "../db/turns";
import { stripPrivateTags } from "../shared/tag-stripping";

type ToolTextResult = {
  content: Array<{
    type: "text";
    text: string;
  }>;
};

export interface NoteToolInput {
  turn?: unknown;
  title?: unknown;
  content?: unknown;
  insight?: unknown;
  skip?: unknown;
}

export interface NoteToolOptions {
  now?: () => number;
  env?: NodeJS.ProcessEnv;
  /** Injected for tests: lets a race with a concurrent reconcile be simulated. */
  runWriteTransaction?: typeof runWriteTransaction;
}

function textResult(text: string): ToolTextResult {
  return { content: [{ type: "text", text }] };
}

function parameterError(message: string): ToolTextResult {
  return textResult(`Parameter error: ${message}`);
}

/**
 * A note result is a successful write iff it opens with the "Noted …"
 * confirmation. Failures are `Parameter error: …`, matching isRememberSuccess.
 * A declined turn answers "Skipped …", which is a successful CALL but not a
 * note, so it deliberately reads as false here.
 */
export function isNoteSuccess(result: {
  content: Array<{ type: string; text?: string }>;
}): boolean {
  return (result.content?.[0]?.text ?? "").startsWith("Noted ");
}

// Spec D7/裁决 15: the ONLY address form a model ever writes is the fully
// qualified `S<session>/T<prompt_number>`. A bare `T<n>` is rejected rather than
// guessed at — the ambiguity that produced the 0.2.34 mis-citation bug came from
// resolving relative ids against an assumed session, and the fix is to require
// qualification, not to pick a default.
const TURN_ADDRESS_PATTERN = /^S(\d+)\/T(\d+)$/i;

interface TurnAddress {
  sessionId: number;
  promptNumber: number;
}

export function parseTurnAddress(value: string): TurnAddress | null {
  const match = TURN_ADDRESS_PATTERN.exec(value.trim());
  if (!match) {
    return null;
  }

  const sessionId = Number.parseInt(match[1]!, 10);
  const promptNumber = Number.parseInt(match[2]!, 10);
  if (!Number.isSafeInteger(sessionId) || !Number.isSafeInteger(promptNumber)) {
    return null;
  }

  return { sessionId, promptNumber };
}

// Mechanical provenance only (D4): a value is recorded when it is observed and
// left NULL otherwise. Claude Code passes the MCP server no model identity —
// not in the process environment (CLAUDE_CODE_SESSION_ID and friends are
// injected for Bash subprocesses only, and no variable anywhere names the
// model), and not in the MCP request, which carries no such field. So this
// reads an explicit override if the operator set one and returns null
// otherwise; the tool result states the miss rather than letting the trial
// analyse an invented bucket as fact.
const WRITER_MODEL_ENV_KEYS = [
  "CLAUDE_MNEMO_WRITER_MODEL",
  "ANTHROPIC_MODEL",
  "CLAUDE_CODE_MODEL",
] as const;

export function resolveWriterModel(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  for (const key of WRITER_MODEL_ENV_KEYS) {
    const value = env[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }

  return null;
}

/**
 * The turn the session is on right now — the turn the note is riding, as
 * opposed to the turn the note is ABOUT. Derived from the address's session, so
 * it needs no caller input and no session identity in the MCP process.
 */
function getRideTurnId(db: Database, sessionId: number): number | null {
  const row = db
    .query<{ id: number }, [number]>(
      "SELECT id FROM turns WHERE session_id = ? ORDER BY prompt_number DESC LIMIT 1",
    )
    .get(sessionId);

  return row?.id ?? null;
}

function requireText(
  value: unknown,
  field: string,
): { ok: true; value: string } | { ok: false; message: string } {
  if (typeof value !== "string") {
    return { ok: false, message: `${field} is required and must be a string.` };
  }
  if (value.trim().length === 0) {
    return { ok: false, message: `${field} must not be empty.` };
  }
  return { ok: true, value };
}

type NoteWriteOutcome =
  | { ok: true; existing: boolean }
  | { ok: false; message: string };

/**
 * May a note be written against this turn?
 *
 * An open debt, a note already on record (a rewrite), or a debt the agent itself
 * declined (裁决 24). The last one is the only closed state a note may reopen:
 * declining is the agent's judgement about its own turn, so a later note is a
 * revision rather than an override — and since the reminder never lists a
 * declined turn again, the only way one arrives is the agent deliberately
 * choosing to write it. `aged`, `rolled-back` and `closed` stay terminal.
 */
function mayWriteNote(
  hasExistingNote: boolean,
  debt: NoteDebtRecord | null,
): boolean {
  return (
    hasExistingNote ||
    debt?.status === "pending" ||
    (debt?.status === "skipped" && debt.reason === "declined")
  );
}

function debtOwesNoNoteMessage(
  address: TurnAddress,
  debt: NoteDebtRecord | null,
): string {
  return (
    `S${address.sessionId}/T${address.promptNumber} owes no note` +
    `${debt ? ` (its debt closed as ${debt.reason ?? debt.status})` : ""}.` +
    " Write notes only for turns listed in a pending-notes reminder, or rewrite a note you already wrote."
  );
}

type DeclineOutcome =
  | { kind: "declined" }
  | { kind: "already-noted" }
  | { kind: "already-settled"; settledAs: string }
  | { kind: "owes-nothing"; debt: NoteDebtRecord | null };

/**
 * `note(turn, skip: true)` — the agent declining a listed turn (裁决 24).
 *
 * A skip is an ANSWER, not silence. The reminder lists each debt exactly once,
 * so a turn the agent cannot honestly write about would otherwise sit open until
 * the 50-turn bound aged it out, occupying one of the backlog relief's five
 * oldest-debt slots the whole time — and a compact strands exactly those oldest
 * debts, which is the common case this exists for. Declining closes the debt now
 * and records WHY, so refusal is distinguishable from neglect.
 *
 * Same session anchor as a note: an MCP server is told nothing about which
 * session called it, so an open debt (or an existing note) is the only evidence
 * that this address belongs to the caller. Skipping a foreign or trivial turn is
 * therefore a parameter error, exactly as writing one is.
 */
function declineTurn(
  db: Database,
  address: TurnAddress,
  options: NoteToolOptions,
): ToolTextResult {
  const turn = getTurn(db, address.sessionId, address.promptNumber);
  if (!turn) {
    return parameterError(
      `no turn at S${address.sessionId}/T${address.promptNumber}. Use an address copied from a reminder or from injected context.`,
    );
  }

  const nowEpoch = options.now?.() ?? Math.floor(Date.now() / 1000);
  const writeTransaction = options.runWriteTransaction ?? runWriteTransaction;
  const ref = `S${turn.sessionId}/T${turn.promptNumber}`;

  // Fast path, same role as the note path's: it avoids opening a write
  // transaction for a plainly invalid address. The decision is re-taken inside.
  if (!getShadowNote(db, turn.id) && getNoteDebt(db, turn.id) === null) {
    return parameterError(debtOwesNoNoteMessage(address, null));
  }

  const outcome = writeTransaction(db, (): DeclineOutcome => {
    // A note already on record wins: the agent has answered this turn, and a
    // stray skip must not undo that.
    if (getShadowNote(db, turn.id) !== null) {
      return { kind: "already-noted" };
    }

    const debt = getNoteDebt(db, turn.id);
    if (debt === null) {
      return { kind: "owes-nothing", debt: null };
    }
    if (debt.status !== "pending") {
      return { kind: "already-settled", settledAs: debt.reason ?? debt.status };
    }

    closeNoteDebtAsDeclined(db, turn.id, nowEpoch);
    return { kind: "declined" };
  });

  switch (outcome.kind) {
    case "declined":
      return textResult(
        `Skipped ${ref}. Its debt is closed as declined and it will not be listed again;` +
          " send a real note for this turn if the material comes back.",
      );
    case "already-noted":
      return textResult(`Skipped ${ref} ignored: it already has a note.`);
    case "already-settled":
      return textResult(
        `Skipped ${ref} ignored: its debt already closed as ${outcome.settledAs}.`,
      );
    case "owes-nothing":
      return parameterError(debtOwesNoNoteMessage(address, outcome.debt));
  }
}

/**
 * `note` — the main agent's own turn note (spec D1), written to the P1 shadow
 * store. It never writes `turns`: the legacy extraction pipeline keeps sole
 * ownership of every turn column including status, which is what keeps the
 * trial's two summary sources independent enough to compare.
 */
export function noteTool(
  db: Database,
  rawInput: NoteToolInput,
  options: NoteToolOptions = {},
): ToolTextResult {
  if (typeof rawInput.turn !== "string") {
    return parameterError(
      'turn is required: a fully qualified "S<session>/T<prompt>" address, e.g. "S15069/T332".',
    );
  }

  const address = parseTurnAddress(rawInput.turn);
  if (!address) {
    return parameterError(
      `turn must be a fully qualified "S<session>/T<prompt>" address, e.g. "S15069/T332"; got "${rawInput.turn}".`,
    );
  }

  if (rawInput.skip !== undefined && typeof rawInput.skip !== "boolean") {
    return parameterError("skip must be a boolean when present.");
  }

  // 裁决 24: a declined turn needs `turn` alone. Everything a note would carry
  // is not merely optional here but meaningless — the whole point of the skip is
  // that there is nothing truthful to put in those fields — so they are ignored
  // rather than validated, and the tool never has to decide what a half-filled
  // skip meant.
  if (rawInput.skip === true) {
    return declineTurn(db, address, options);
  }

  const titleInput = requireText(rawInput.title, "title");
  if (!titleInput.ok) {
    return parameterError(titleInput.message);
  }

  const contentInput = requireText(rawInput.content, "content");
  if (!contentInput.ok) {
    return parameterError(contentInput.message);
  }

  if (
    rawInput.insight !== undefined &&
    rawInput.insight !== null &&
    typeof rawInput.insight !== "string"
  ) {
    return parameterError("insight must be a string when present.");
  }

  const turn = getTurn(db, address.sessionId, address.promptNumber);
  if (!turn) {
    return parameterError(
      `no turn at S${address.sessionId}/T${address.promptNumber}. Use an address copied from a reminder or from injected context.`,
    );
  }

  // Only a turn that owes a note, or one already noted, may be written to.
  //
  // This is the guard against a mistyped or borrowed address, and it is the only
  // one available: an MCP server is told nothing about which session is calling
  // it, so "is this my own turn?" cannot be asked directly. An open debt is the
  // session anchor instead — it exists only for turns of the session that ran
  // them — and it makes ride_turn coherent as a side effect, since ride_turn is
  // derived from the address's session. Without it, a note addressed at another
  // session's turn silently attributes itself to THAT session's newest turn.
  //
  // This read is a fast path only, not the authorising one: the hook-side
  // reconcile (Stop handler, PostToolUse capture) runs in another process and
  // can close this same debt — age it out, or close it as rolled-back —
  // between this read and the write transaction below. The re-check that
  // actually decides is the one taken inside that transaction; skipping the
  // fast path here would only cost an avoidable BEGIN IMMEDIATE for a plainly
  // invalid address.
  const fastExisting = getShadowNote(db, turn.id);
  const fastDebt = getNoteDebt(db, turn.id);
  if (!mayWriteNote(fastExisting !== null, fastDebt)) {
    return parameterError(debtOwesNoNoteMessage(address, fastDebt));
  }

  // Same removal the transcript capture path applies (D10). It runs at the
  // persistence boundary, not at the caller's discretion: instruction
  // discipline alone has no enforcement, and the strip is what makes the
  // guarantee a property of the write path.
  const rawTitle = titleInput.value;
  const rawContent = contentInput.value;
  const rawInsight =
    typeof rawInput.insight === "string" ? rawInput.insight : null;

  const title = stripPrivateTags(rawTitle);
  const content = stripPrivateTags(rawContent);
  const insight = rawInsight === null ? null : stripPrivateTags(rawInsight);

  const stripped =
    title !== rawTitle || content !== rawContent || insight !== rawInsight;

  const nowEpoch = options.now?.() ?? Math.floor(Date.now() / 1000);
  const writerModel = resolveWriterModel(options.env ?? process.env);
  const rideTurnId = getRideTurnId(db, turn.sessionId);
  const writeTransaction = options.runWriteTransaction ?? runWriteTransaction;

  // The debt validation, the note write and the debt's closure are one
  // transaction, and the validation inside it is the one that counts: an
  // IMMEDIATE transaction takes the write lock before either statement inside
  // it runs, so whatever this read observes is the state the write commits
  // against — there is no window left for a concurrent reconcile to close the
  // debt between "we checked it was open" and "we wrote against it". Without
  // this, that window let the note get written while its own closing UPDATE
  // (WHERE status = 'pending') quietly matched zero rows, leaving a note on
  // record for a debt whose ledger entry says anything but 'noted'.
  //
  // Age is still not consulted inside the transaction — see
  // closeNoteDebtAsNoted — only writability (open, already noted, or declined by
  // the agent itself), re-read live.
  const outcome = writeTransaction(db, (): NoteWriteOutcome => {
    const existing = getShadowNote(db, turn.id);
    const debt = getNoteDebt(db, turn.id);
    if (!mayWriteNote(existing !== null, debt)) {
      return { ok: false, message: debtOwesNoNoteMessage(address, debt) };
    }

    upsertShadowNote(db, {
      turnId: turn.id,
      title,
      content,
      insight,
      writerModel,
      rideTurnId,
      nowEpoch,
    });
    closeNoteDebtAsNoted(db, turn.id, nowEpoch);
    return { ok: true, existing: existing !== null };
  });

  if (!outcome.ok) {
    return parameterError(outcome.message);
  }

  const parts = [
    `Noted S${turn.sessionId}/T${turn.promptNumber}${
      outcome.existing ? " (replaced the previous note)" : ""
    }.`,
  ];
  parts.push(
    rideTurnId === null
      ? "ride_turn: unknown."
      : `ride_turn: S${turn.sessionId}/T${
          getRidePromptNumber(db, rideTurnId) ?? turn.promptNumber
        }.`,
  );
  parts.push(
    writerModel === null
      ? "writer_model: not recorded — this environment does not expose the model to the MCP server."
      : `writer_model: ${writerModel}.`,
  );
  if (stripped) {
    parts.push("Private-tagged content was removed before storing.");
  }

  return textResult(parts.join(" "));
}

function getRidePromptNumber(db: Database, turnId: number): number | null {
  return (
    db
      .query<{ promptNumber: number }, [number]>(
        "SELECT prompt_number AS promptNumber FROM turns WHERE id = ?",
      )
      .get(turnId)?.promptNumber ?? null
  );
}
