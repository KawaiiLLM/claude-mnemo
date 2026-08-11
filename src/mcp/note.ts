import type { Database } from "bun:sqlite";

import { runWriteTransaction } from "../db/database";
import {
  closeNoteDebtAsDeclined,
  closeNoteDebtAsNoted,
  getNoteDebt,
  recordDeclinedNoteDebt,
  type NoteDebtRecord,
} from "../db/note-debt";
import { getShadowNote, upsertShadowNote } from "../db/shadow-notes";
import { getTurn, promoteTurnFromNote } from "../db/turns";
import { isSegmentEra } from "../segment-era";
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
  replace?: unknown;
  crossSession?: unknown;
}

export interface NoteToolOptions {
  now?: () => number;
  env?: NodeJS.ProcessEnv;
  /** Injected for tests: lets a race with a concurrent reconcile be simulated. */
  runWriteTransaction?: typeof runWriteTransaction;
  /**
   * P2 era boundary (spec D11/D12), resolved by the handler layer and never
   * read from config here — `loadConfig` hits the filesystem on every call and
   * a tool call must not pay for that. Absent or `null` = every turn is legacy,
   * which is the P1 behaviour (shadow row only) and the rollback.
   */
  eraCutoffEpoch?: number | null;
  /**
   * The mnemo session the caller belongs to (spec D2), resolved ONLY by the
   * MCP process's direct-execution entry point (server.ts) from the process
   * env var through `process_session_map`. Every other construction path —
   * worker tool channels included, which inherit a hook's environment and
   * would otherwise "look like" whatever session that hook belonged to — must
   * leave this absent. Absent or null both mean "unknown", and unknown always
   * admits: a wrong rejection here silently stops a turn's notes forever,
   * which spec D2 rules out as the one unacceptable failure mode.
   */
  callerSessionId?: number | null;
}

function textResult(text: string): ToolTextResult {
  return { content: [{ type: "text", text }] };
}

function parameterError(message: string): ToolTextResult {
  return textResult(`Parameter error: ${message}`);
}

/**
 * A note result is a successful write iff it opens with "Noted " (a first
 * write) or "Updated " (spec D5's replace) — the two receipts a real write
 * can produce. Failures are `Parameter error: …`, matching isRememberSuccess.
 * A declined turn answers "Skipped …", which is a successful CALL but not a
 * note, so it deliberately reads as false here.
 *
 * Trial metrics read this predicate directly: widen it whenever the receipt
 * wording changes, or every write under the new wording counts as a failure.
 */
export function isNoteSuccess(result: {
  content: Array<{ type: string; text?: string }>;
}): boolean {
  const text = result.content?.[0]?.text ?? "";
  return text.startsWith("Noted ") || text.startsWith("Updated ");
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
// no environment variable anywhere names the model, and the MCP request
// carries no such field either. So this reads an explicit override if the
// operator set one and returns null otherwise; the tool result states the
// miss rather than letting the trial analyse an invented bucket as fact.
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
 *
 * `undone` rows are excluded: a sidechain prompt's row is born `undone` and
 * outranks the root turn in prompt order for the whole delegation window; it
 * is neither a valid ride nor a turn the session is "on". `status` is returned
 * so the current-turn admission below can additionally require a LIVE turn.
 */
function getSessionCurrentTurn(
  db: Database,
  sessionId: number,
): { id: number; status: string } | null {
  const row = db
    .query<{ id: number; status: string }, [number]>(
      `SELECT id, status FROM turns
       WHERE session_id = ? AND status != 'undone'
       ORDER BY prompt_number DESC LIMIT 1`,
    )
    .get(sessionId);

  return row ?? null;
}

/**
 * Is this turn the one its session is living right now (裁决 25)?
 *
 * Latest is not enough on its own: every idle session has a latest turn, its
 * address is one recall query away, and admitting it debtless would leave every
 * session's last turn permanently writable from anywhere. Requiring the row to
 * still be live (`active`/`provisional` — the same pair the completion-evidence
 * predicate treats as unfinished) shrinks the exposure to sessions that are
 * mid-turn at this instant, which is the only time the current-turn protocol
 * has any business writing. The anchor stays best-effort — the MCP process
 * cannot ask "is this my own session?" — and the instruction-side rule (only
 * ids seen in injected context) carries the rest.
 */
function isSessionCurrentTurn(
  current: { id: number; status: string } | null,
  turnId: number,
): boolean {
  return (
    current !== null &&
    current.id === turnId &&
    (current.status === "active" || current.status === "provisional")
  );
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
 * The session's current turn (裁决 25 — its debt does not exist yet, because
 * debts only open at classification after the turn ends), an open debt, a note
 * already on record (a rewrite), or a debt the agent itself declined (裁决 24).
 * The declined state is the only closed one a note may reopen: declining is the
 * agent's judgement about its own turn, so a later note is a revision rather
 * than an override — and since no channel lists a declined turn again, the only
 * way one arrives is the agent deliberately choosing to write it. `aged`,
 * `rolled-back` and `closed` stay terminal.
 */
function mayWriteNote(
  hasExistingNote: boolean,
  debt: NoteDebtRecord | null,
  isCurrentTurn: boolean,
): boolean {
  return (
    isCurrentTurn ||
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
    " Write notes for the current turn (the mnemo current-turn line's address), for turns listed in a backlog relief, or rewrite a note you already wrote."
  );
}

/**
 * Overwrite must be declared (spec D3). A repeat write to an address that
 * already has a note is presumptively a mistake — the wrong address copied
 * from a stale reminder line, most often — and a caller that genuinely means
 * to revise says so with `replace: true` rather than silently clobbering.
 */
function overwriteRequiredMessage(address: TurnAddress): string {
  return (
    `S${address.sessionId}/T${address.promptNumber} already has a note.` +
    " Resend with replace: true to confirm you want to overwrite it."
  );
}

/**
 * Cross-session write must be declared (spec D4). No legitimate use exists
 * today — every address a caller ever has came from its own session's
 * current-turn line or backlog relief — so this fires only on a mistyped or
 * borrowed address, and only when the caller's identity is actually known
 * (spec D2: unknown always admits, so this is skipped entirely otherwise).
 */
function crossSessionRequiredMessage(
  address: TurnAddress,
  callerSessionId: number,
): string {
  return (
    `S${address.sessionId}/T${address.promptNumber} belongs to a different session` +
    ` than this call (S${callerSessionId}).` +
    " Resend with crossSession: true to confirm the cross-session write."
  );
}

/**
 * Does this call know an identity, and does it disagree with the address?
 * `callerSessionId` is `undefined`/`null` on every path except the MCP
 * direct-execution entry, and even there it is null whenever the process
 * session has no recorded mapping yet — both read as "unknown" here, which is
 * the only reading spec D2 allows a miss to have.
 */
function isCrossSessionWrite(
  callerSessionId: number | null | undefined,
  addressSessionId: number,
): boolean {
  return (
    typeof callerSessionId === "number" && callerSessionId !== addressSessionId
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
 * Same session anchor as a note: caller identity is best-effort and often
 * unknown (spec D2), so an open debt (or an existing note) stays the primary
 * evidence that this address belongs to the caller. When identity IS known,
 * the cross-session check below adds a second, independent guard on top of it
 * — it does not replace it. Skipping a foreign or trivial turn is therefore a
 * parameter error, exactly as writing one is.
 */
function declineTurn(
  db: Database,
  address: TurnAddress,
  options: NoteToolOptions,
  crossSession: boolean,
): ToolTextResult {
  const turn = getTurn(db, address.sessionId, address.promptNumber);
  if (!turn) {
    return parameterError(
      `no turn at S${address.sessionId}/T${address.promptNumber}. Use an address copied from a reminder or from injected context.`,
    );
  }

  // spec D4: a foreign-session address is rejected before any debt-state
  // reasoning runs — identity, when known, outranks the debt-based anchor.
  if (
    isCrossSessionWrite(options.callerSessionId, turn.sessionId) &&
    !crossSession
  ) {
    return parameterError(
      crossSessionRequiredMessage(address, options.callerSessionId as number),
    );
  }

  const nowEpoch = options.now?.() ?? Math.floor(Date.now() / 1000);
  const writeTransaction = options.runWriteTransaction ?? runWriteTransaction;
  const ref = `S${turn.sessionId}/T${turn.promptNumber}`;

  // The current turn may be declined before its debt exists (裁决 25), exactly
  // as it may be noted: classification has not run because the turn has not
  // ended, and the refusal must not be rejected for being early.
  const isCurrentTurn = isSessionCurrentTurn(
    getSessionCurrentTurn(db, turn.sessionId),
    turn.id,
  );

  // Fast path, same role as the note path's: it avoids opening a write
  // transaction for a plainly invalid address. The decision is re-taken inside.
  if (
    !isCurrentTurn &&
    !getShadowNote(db, turn.id) &&
    getNoteDebt(db, turn.id) === null
  ) {
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
      // Born-closed decline for the current turn; anything else with no debt
      // row is a trivial turn or a borrowed address, and owes nothing.
      if (isCurrentTurn && recordDeclinedNoteDebt(db, turn, nowEpoch)) {
        return { kind: "declined" };
      }
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
 * `note` — the main agent's own turn note (spec D1).
 *
 * Two behaviours, chosen per turn by the era predicate (spec D11/D12, ticket
 * 09). A turn created before the cutoff keeps the P1 arrangement exactly: the
 * note lands in the shadow store and `turns` is not touched at all, because the
 * legacy extraction pipeline still owns every column of those rows including
 * status. A turn created at or after it is promoted — the note becomes the
 * official record. The shadow row is written either way: it is the provenance
 * of who authored the text, and the trial's metrics read it.
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
  if (rawInput.replace !== undefined && typeof rawInput.replace !== "boolean") {
    return parameterError("replace must be a boolean when present.");
  }
  if (
    rawInput.crossSession !== undefined &&
    typeof rawInput.crossSession !== "boolean"
  ) {
    return parameterError("crossSession must be a boolean when present.");
  }
  const replace = rawInput.replace === true;
  const crossSession = rawInput.crossSession === true;

  // 裁决 24: a declined turn needs `turn` alone. Everything a note would carry
  // is not merely optional here but meaningless — the whole point of the skip is
  // that there is nothing truthful to put in those fields — so they are ignored
  // rather than validated, and the tool never has to decide what a half-filled
  // skip meant. `crossSession` is the one flag a skip still reads (spec D4
  // applies to every write, and a decline is one); `replace` has nothing to do
  // with a skip and is silently ignored like title/content/insight are.
  if (rawInput.skip === true) {
    return declineTurn(db, address, options, crossSession);
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

  // Only the current turn, a turn that owes a note, or one already noted may be
  // written to.
  //
  // This is the guard against a mistyped or borrowed address, and — whenever
  // caller identity is unknown, which spec D2 makes the common case — it is
  // the only one available: "is this my own turn?" cannot be asked directly
  // without it. An open debt — or being the addressed session's newest
  // STILL-LIVE turn, the address the current-turn line hands out (裁决 25; see
  // isSessionCurrentTurn for why "latest" alone would leave every idle
  // session's last turn writable) — is the session anchor instead, and it
  // makes ride_turn coherent as a side effect, since ride_turn is derived from
  // the address's session. Without it, a note addressed at another session's
  // turn silently attributes itself to THAT session's newest turn. When
  // identity IS known, the explicit cross-session check below adds a second,
  // independent guard on top of this one rather than replacing it.
  //
  // This read is a fast path only, not the authorising one: the hook-side
  // reconcile (Stop handler, PostToolUse capture) runs in another process and
  // can close this same debt — age it out, or close it as rolled-back —
  // between this read and the write transaction below. The re-check that
  // actually decides is the one taken inside that transaction; skipping the
  // fast path here would only cost an avoidable BEGIN IMMEDIATE for a plainly
  // invalid address.
  //
  // `isCurrentTurn` is deliberately NOT recomputed inside the transaction. The
  // benign race — a new prompt lands between this read and the commit — would
  // otherwise reject a note that was composed while its turn genuinely was the
  // current one, and lose it; the stale answer admits it, which is the same
  // grace every late-but-honest note gets. Nothing widens: the value was true
  // of a live turn of the addressed session moments ago, and the debt-based
  // admissions are re-read fresh inside the transaction as before.
  const current = getSessionCurrentTurn(db, turn.sessionId);
  const isCurrentTurn = isSessionCurrentTurn(current, turn.id);
  const fastExisting = getShadowNote(db, turn.id);
  const fastDebt = getNoteDebt(db, turn.id);

  // spec D4, and BEFORE any debt-state reasoning — the same order `declineTurn`
  // uses, for the same reason: identity, when known, outranks the debt-based
  // anchor. Behind the debt check this guard was unreachable for the commonest
  // foreign address of all, another session's finished turn, which owes nothing
  // and so was refused as "owes no note" — a true statement that names the
  // wrong problem and, worse, one that `crossSession: true` could not get past,
  // leaving the documented escape hatch inoperable for that whole class.
  //
  // No race window exists to protect against (the caller's identity and the
  // address's session are both fixed for the duration of this call), so unlike
  // D3 below this is not re-checked inside the transaction.
  if (isCrossSessionWrite(options.callerSessionId, turn.sessionId) && !crossSession) {
    return parameterError(
      crossSessionRequiredMessage(address, options.callerSessionId as number),
    );
  }

  if (!mayWriteNote(fastExisting !== null, fastDebt, isCurrentTurn)) {
    return parameterError(debtOwesNoNoteMessage(address, fastDebt));
  }

  // spec D3: fast-path half of the overwrite guard — same role as the
  // mayWriteNote check above, an early exit that avoids opening a write
  // transaction for a call that is going to be rejected anyway. The
  // authorising check is the one inside the transaction below, because a
  // concurrent note to this same address can flip "no existing note" to
  // "existing note" between this read and that one.
  if (fastExisting !== null && !replace) {
    return parameterError(overwriteRequiredMessage(address));
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
  const rideTurnId = current?.id ?? null;
  const writeTransaction = options.runWriteTransaction ?? runWriteTransaction;
  const promotesTurnRecord = isSegmentEra(
    turn.createdAtEpoch,
    options.eraCutoffEpoch,
  );

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
    if (!mayWriteNote(existing !== null, debt, isCurrentTurn)) {
      return { ok: false, message: debtOwesNoNoteMessage(address, debt) };
    }
    // spec D3, authoritative half: re-read fresh, exactly like the debt check
    // just above it — a concurrent note between the fast-path read and this
    // transaction's write lock must not be silently clobbered by a caller who
    // never declared they meant to overwrite anything.
    if (existing !== null && !replace) {
      return { ok: false, message: overwriteRequiredMessage(address) };
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

    // The cutover itself (裁决 27): in the new era this note is not a shadow
    // record beside the official one, it IS the official one. It shares the
    // transaction with the shadow row and the debt closure rather than
    // following them, so no reader can observe a turn whose record, whose
    // provenance and whose ledger disagree about whether it was noted.
    if (promotesTurnRecord) {
      promoteTurnFromNote(db, turn.id, {
        title,
        content,
        insight,
        updatedAtEpoch: nowEpoch,
      });
    }

    return { ok: true, existing: existing !== null };
  });

  if (!outcome.ok) {
    return parameterError(outcome.message);
  }

  // spec D5: the verb itself carries new-vs-update, not just the trailing
  // clause — a caller (or a trial metric skimming just the first word) can
  // tell them apart without parsing the rest of the sentence.
  const parts = [
    `${outcome.existing ? "Updated" : "Noted"} S${turn.sessionId}/T${turn.promptNumber}${
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
