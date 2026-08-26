import { stripPrivateTags } from "../shared/tag-stripping";
import {
  containsToolCallSyntax,
  recordToolCallSyntaxRejection,
  toolCallSyntaxLoopMessage,
  toolCallSyntaxMessage,
} from "../shared/tool-call-syntax";

/**
 * The ONE field-mode vocabulary (write-mode-edit-semantics spec D1/D3/D4/D10/
 * D14), extracted so both write surfaces read it from the same place rather
 * than each carrying its own rules.
 *
 * Ticket 07 (spec D12, "结算面与主 agent 完全一致"): settlement's write facade
 * (`worker/note-settlement-turn-facade.ts`) was the first consumer; `mcp/note.ts`
 * has since folded its byte-identical copy into this module too —
 * `FieldMode`/`FieldEditMode`/`isFieldEditMode`/`parseModeMap`/
 * `resolveStringField`/`resolveFieldEdit`/`resolveClear`/`modeRequiredMessage`
 * all live here now, with `note.ts` importing what it still calls directly and
 * re-exporting the two types for its own existing importers. `note.ts`'s
 * `NoteValidationError` extends `FieldModeError` (not `Error`) so its catch
 * sites, which test `instanceof FieldModeError`, keep catching both what its
 * own `fail()` throws and what this module's throws.
 *
 * `decodeHtmlEntities` (with `HTML_ENTITY_MAP`) lives here too; `note.ts`
 * re-exports it (`export { decodeHtmlEntities } from "./field-mode"`) so
 * `mcp/remember.ts`'s existing import keeps working.
 *
 * `tests/mcp/field-mode-parity.test.ts` now compares this module against
 * itself through `note.ts`'s own call — the signal it was written to wait for.
 */

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/**
 * `write` replaces the field whole (clear included); the edit form carries its
 * own payload, since there is nowhere else on the call to put it. `append` and
 * `overwrite` retired outright — `RETIRED_FIELD_MODE_REPLACEMENT` below is what
 * a caller still sending either gets instead of a generic error.
 */
export type FieldMode = "write" | FieldEditMode;
export interface FieldEditMode {
  mode: "edit";
  oldString: string;
  newString: string;
}

export function isFieldEditMode(mode: FieldMode | undefined): mode is FieldEditMode {
  return typeof mode === "object" && mode !== null;
}

// Spec D14 (write-mode-edit-semantics): the retired mode literals, each
// naming its own replacement.
//
// settlement-ergonomics ticket 01 (spec D1) removed "overwrite"/"append"
// from `fieldModeValueShape`'s union in `mcp/definitions.ts` outright — the
// model-visible schema no longer offers a word it always refuses. Because
// `settlementNoteInputShape.mode` REUSES that same union object
// (`noteInputShape.mode`, not a copy), settlement's raw-shape registration
// with the SDK's `tool()` narrows for free too, even though it still has no
// `superRefine` layer of its own: for any call that actually goes through
// zod validation — `note`'s wrapped schema or `remember`'s raw shape alike —
// this map is unreachable, the value fails the union before either surface's
// handler runs. It stays live for the one path zod never sees: a caller that
// bypasses the schema entirely, e.g. a restored transcript replaying an old
// tool-use payload the model imitates, or a direct hand-rolled call (most of
// this codebase's own tests reach `noteTool()`/`evaluateSettlementTurnWrite()`
// this way). Spec D1 calls this a deliberate diagnosability trade-off, not
// dead code — the schema no longer teaches the word, but a caller who
// already typed it still gets told what to use instead.
export const RETIRED_FIELD_MODE_REPLACEMENT: Record<string, string> = {
  overwrite: 'use "write" instead.',
  append:
    'use "write" to replace the field whole, or the edit form ({ mode: "edit", oldString, newString }) to change part of it.',
};

// Spec D4: type/tags are set fields — "part of a list" is not a span an
// oldString/newString pair can name, so the edit form is refused on them
// outright, not given a set-flavoured meaning of its own.
export const SET_MODE_FIELDS: readonly string[] = ["type", "tags"];

/** Every field of every addressing surface that carries a mode (spec D5a). */
export const MODE_FIELDS = ["title", "content", "insight", "type", "tags"] as const;

/**
 * Thrown by everything below. Each write surface catches it at its own
 * boundary and renders it in that surface's own rejection shape (a
 * `Parameter error:` result for the note tool, an `{ ok: false, message }`
 * evaluation for the settlement facade).
 */
export class FieldModeError extends Error {}

/**
 * The tool-call-syntax rejection, distinguished from every other field-mode
 * refusal by its own class rather than by its wording (write-gate-hardening
 * ticket 01). Two things need to tell it apart: the loop counter below, and
 * nothing else — so the class carries the field and the offending text and
 * builds its own shape-echo message, and every existing `instanceof
 * FieldModeError` catch site keeps catching it unchanged.
 */
export class ToolCallSyntaxError extends FieldModeError {
  constructor(
    readonly field: string,
    readonly text: string,
  ) {
    super(toolCallSyntaxMessage(field, text));
  }
}

function fail(message: string): never {
  throw new FieldModeError(message);
}

function failToolCallSyntax(field: string, text: string): never {
  throw new ToolCallSyntaxError(field, text);
}

/**
 * Render a field-mode rejection at a surface boundary that knows WHICH address
 * the rejected call was writing — the one place the consecutive-rejection
 * counter can be keyed correctly, since the guard itself (`resolveStringField`,
 * `parseModeMap`) sees a field name and a string and nothing else.
 *
 * `address === null` means the surface has not resolved an address for this
 * call yet (settlement parses its mode map before its address branch): the
 * rejection still renders, it just cannot be counted against anything, and
 * counting it under a wrong key would be worse than not counting it.
 *
 * Non-syntax rejections pass through untouched AND do not reset the run: the
 * counter tracks consecutive TOOL-CALL-SYNTAX rejections, and only a
 * successful write clears it (`clearToolCallSyntaxRejections`).
 */
export function fieldModeErrorMessage(
  error: FieldModeError,
  address: string | null,
): string {
  if (address === null || !(error instanceof ToolCallSyntaxError)) {
    return error.message;
  }
  const count = recordToolCallSyntaxRejection(address);
  if (count < 2) {
    return error.message;
  }
  return `${error.message} ${toolCallSyntaxLoopMessage(address, count)}`;
}

export function modeRequiredMessage(field: string): string {
  return (
    `${field} is not empty; declare mode.${field} as "write" (replace it ` +
    'whole) or the edit form ({ mode: "edit", oldString, newString }) ' +
    "(change part of it) — omitting the mode is not allowed on a field " +
    "that already holds something."
  );
}

export function editValueConflictMessage(field: string): string {
  return (
    `${field} was supplied together with mode.${field}'s edit form — the new ` +
    `text belongs in mode.${field}.newString, not in ${field} itself.`
  );
}

const MODE_SHAPE_MESSAGE =
  'must be "write" or an edit form ({ mode: "edit", oldString, newString }).';

// ---------------------------------------------------------------------------
// HTML entity decoding
// ---------------------------------------------------------------------------

const HTML_ENTITY_MAP: Record<string, string> = { lt: "<", gt: ">", amp: "&" };

// The memory agent sometimes emits HTML-escaped text even though every field
// here is plain text; decode once at the persistence boundary. Single-pass so
// `&amp;lt;` decodes to `&lt;`, never `<`.
export function decodeHtmlEntities(value: string): string {
  return value.replace(/&(lt|gt|amp);/g, (_match, name: string) => HTML_ENTITY_MAP[name]!);
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parses `mode.<field>` into the discriminated union `FieldMode` — the one
 * place every trap the vocabulary exists to close is checked in a single pass:
 * a retired literal names its replacement (D14), an edit form on a set field is
 * refused (D4), and the edit form's own hygiene (decode, tool-call-syntax,
 * private-tag strip) runs once here rather than being duplicated across every
 * prose field's own resolver.
 *
 * `allowed` is the caller's own field list: a mode naming a field THIS call
 * does not carry is rejected by name rather than silently ignored.
 */
export function parseModeMap(
  raw: unknown,
  allowed: readonly string[],
): Partial<Record<string, FieldMode>> {
  if (raw === undefined) {
    return {};
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fail(`mode ${MODE_SHAPE_MESSAGE}`);
  }
  const result: Partial<Record<string, FieldMode>> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!allowed.includes(key)) {
      fail(`mode.${key} names a field this call does not accept a mode for.`);
    }
    if (typeof value === "string") {
      if (value === "write") {
        result[key] = "write";
        continue;
      }
      const replacement = RETIRED_FIELD_MODE_REPLACEMENT[value];
      if (replacement) {
        fail(`mode.${key}: "${value}" has retired — ${replacement}`);
      }
      fail(`mode.${key} ${MODE_SHAPE_MESSAGE}`);
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      fail(`mode.${key} ${MODE_SHAPE_MESSAGE}`);
    }
    const editRaw = value as Record<string, unknown>;
    if (editRaw.mode !== "edit") {
      fail(`mode.${key} ${MODE_SHAPE_MESSAGE}`);
    }
    if (SET_MODE_FIELDS.includes(key)) {
      fail(
        `mode.${key}: the edit form has no meaning on a set field — oldString/newString cannot ` +
          `target part of a list; use mode.${key}: "write" with the full replacement set instead.`,
      );
    }
    if (typeof editRaw.oldString !== "string" || editRaw.oldString === "") {
      fail(`mode.${key}.oldString is required and must be a non-empty string.`);
    }
    if (typeof editRaw.newString !== "string") {
      fail(`mode.${key}.newString is required (use "" to delete the matched text).`);
    }
    const oldString = decodeHtmlEntities(editRaw.oldString);
    const newStringRaw = decodeHtmlEntities(editRaw.newString);
    if (containsToolCallSyntax(oldString)) {
      failToolCallSyntax(`mode.${key}.oldString`, oldString);
    }
    if (newStringRaw !== "" && containsToolCallSyntax(newStringRaw)) {
      failToolCallSyntax(`mode.${key}.newString`, newStringRaw);
    }
    const newString = newStringRaw === "" ? "" : stripPrivateTags(newStringRaw);
    result[key] = { mode: "edit", oldString, newString };
  }
  return result;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export type FieldResolution<T> = { value: T };

/**
 * The one string-field resolver, shared by every prose field of every
 * addressing surface (spec D5a: one mode vocabulary, no field gets a mechanism
 * of its own).
 *
 * `nullable: false` rejects both an explicit `null` and an empty string — for a
 * column whose schema requires it non-null, "clearing" is not an operation the
 * surface can express; the caller supplies a replacement or leaves the field
 * alone. `nullable: true` treats an empty string as a plain synonym for `null`
 * and both route through the same mode-gated clear.
 */
export function resolveStringField(
  field: string,
  provided: unknown,
  existing: string | null,
  mode: FieldMode | undefined,
  opts: { nullable: boolean },
): FieldResolution<string | null> {
  // Spec D10: the edit form's payload lives entirely in `mode.<field>` — the
  // field's own value is not also supplied. Routed here before anything else
  // so the "value + edit form together" combo is caught regardless of which
  // branch below would otherwise have handled `provided`.
  if (isFieldEditMode(mode)) {
    if (provided !== undefined) {
      fail(editValueConflictMessage(field));
    }
    return resolveFieldEdit(field, existing, mode, opts);
  }
  if (provided === null) {
    if (!opts.nullable) {
      fail(`${field} cannot be cleared; supply a replacement value instead of null.`);
    }
    return resolveClear(field, existing, mode);
  }
  if (typeof provided !== "string") {
    fail(`${field} must be a string${opts.nullable ? " or null" : ""} when present.`);
  }
  const decoded = decodeHtmlEntities(provided);
  if (decoded.trim() === "") {
    if (opts.nullable) {
      return resolveClear(field, existing, mode);
    }
    fail(`${field} must not be empty.`);
  }
  if (containsToolCallSyntax(decoded)) {
    failToolCallSyntax(field, decoded);
  }
  const isEmpty = existing === null || existing.trim() === "";
  // `mode` here can only be `undefined` or `"write"` (edit is routed away
  // above) — falling through to `return { value: decoded }` is a full
  // replacement either way, exactly as spec D2 defines `write`.
  if (!isEmpty && mode === undefined) {
    fail(modeRequiredMessage(field));
  }
  return { value: decoded };
}

/**
 * Spec D3: the edit form's three-state contract, ported from the segment
 * surface's `replaceInSegmentWorkingStateField` (db/segments.ts) — unique hit
 * succeeds, no hit rejects naming `oldString`, more than one hit rejects naming
 * the count. `newString: ""` deletes the matched span; a non-nullable field
 * edited down to empty is refused rather than silently landing an empty string.
 */
export function resolveFieldEdit(
  field: string,
  existing: string | null,
  edit: FieldEditMode,
  opts: { nullable: boolean },
): FieldResolution<string | null> {
  const current = existing ?? "";
  const occurrences = current === "" ? 0 : current.split(edit.oldString).length - 1;
  if (occurrences === 0) {
    fail(`oldString ${JSON.stringify(edit.oldString)} not found in ${field}.`);
  }
  if (occurrences > 1) {
    fail(
      `oldString ${JSON.stringify(edit.oldString)} matches ${occurrences} times in ${field} — narrow it so it matches exactly once.`,
    );
  }
  const replaced = current.split(edit.oldString).join(edit.newString);
  if (replaced.trim() === "") {
    if (opts.nullable) {
      return { value: null };
    }
    fail(`${field} cannot be edited down to empty; supply a replacement instead of deleting all of it.`);
  }
  return { value: replaced };
}

export function resolveClear(
  field: string,
  existing: string | null,
  mode: FieldMode | undefined,
): FieldResolution<string | null> {
  const isEmpty = existing === null || existing.trim() === "";
  if (isEmpty) {
    return { value: null };
  }
  if (mode === undefined) {
    fail(modeRequiredMessage(field));
  }
  // `mode` is guaranteed `"write"` here — the edit form is routed away by
  // `resolveStringField` before this function is ever reached.
  return { value: null };
}

/**
 * The set-field half of the same rule (spec D4), factored out of what
 * `mcp/note.ts`'s `resolveTypeField`/`resolveTagsField` do at their tails: a
 * non-empty set always needs `mode.<field>: "write"` and always means the full
 * replacement set. The edit form never reaches here — `parseModeMap` refuses it
 * on a set field first.
 */
export function requireSetFieldMode(
  field: string,
  existing: readonly string[],
  mode: FieldMode | undefined,
): void {
  if (existing.length > 0 && mode === undefined) {
    fail(modeRequiredMessage(field));
  }
}
