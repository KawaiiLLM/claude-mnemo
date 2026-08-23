// spec E2 / ticket 03: reject prose that carries raw tool-call markup rather
// than silently storing it. Measured against production: 99 rows carry
// parameter-tag fragments inside `content` — almost all of them the shape
// "content's text, then a closing tag named `content`, then the next
// parameter's opening tag", i.e. a tool call whose closing tag was written
// wrong (the field's own name instead of the parameter closing tag), so the
// SDK's own parser glued the NEXT parameter's opening tag and value onto this
// one's text instead of routing it. The failure is silent today: the `insight`
// a caller thought it sent never lands anywhere, and the malformed fragment
// gets stored as if it were prose. Detecting it at the write boundary turns
// that into a loud, readable rejection instead.
//
// write-gate-hardening ticket 01 adds the two things a bare rejection could
// not do:
//
//   1. SHAPE ECHO — the rejection recovery-parses the glued tail and says, in
//      prose, which closing tag was written wrong and which parameters rode in
//      as literal text and therefore did not land. RED LINE: no message this
//      module produces ever reproduces angle-bracket markup verbatim. The
//      message returns into the caller's own context, and every quoted
//      fragment is one more exemplar feeding the attractor that produced the
//      malformed call in the first place. `containsToolCallSyntax` applied to
//      any message from this module must be false — pinned by test, not by
//      this comment.
//   2. LOOP NAMING — once a malformed call sits in a session's context, every
//      retry reproduces it (exemplar lock-in: the model is copying its own
//      last attempt). A per-process counter keyed by the address being written
//      lets the SECOND consecutive rejection say so and tell the caller to
//      stop retrying. Per-process in-memory is the correct scope: the callers
//      that can loop are exactly the ones this process is serving.
//
// Deliberately NOT built (ruled at S15069/T1428-T1429): server-side
// un-gluing. The recovery parse below exists to DESCRIBE the damage, never to
// repair it — a write gate that quietly accepts a malformed call teaches the
// caller that the malformed call works.
const TOOL_CALL_SYNTAX_PATTERN =
  /<\/?(?:parameter|invoke|function_calls|antml:[a-z_]+)\b/i;

export function containsToolCallSyntax(text: string): boolean {
  return TOOL_CALL_SYNTAX_PATTERN.test(text);
}

// ---------------------------------------------------------------------------
// Recovery parse
// ---------------------------------------------------------------------------

export interface GluedToolCallShape {
  /**
   * The name the fake closing tag was written after — the field's own name for
   * a plain field, the last dotted segment for a nested one (`mode.content.
   * oldString` drifts into a tag named `oldString`).
   */
  closingTagName: string;
  /** Parameter names that arrived as literal text, first to last, deduped. */
  gluedParameters: string[];
}

const PARAMETER_OPEN =
  /^\s*<(?:antml:)?parameter\s+name="([A-Za-z_][A-Za-z0-9_.-]*)"\s*>/;
const PARAMETER_CLOSE = /<\/(?:antml:)?parameter>/;
const PARAMETER_NEXT_OPEN = /<(?:antml:)?parameter\b/;
const CALL_END = /^\s*<\/(?:antml:)?(?:invoke|function_calls)>/;

/**
 * Where one glued parameter's value stops: whichever comes first of its own
 * fake closing tag (the same drift again, one field further on), a real
 * parameter closing tag, or the next parameter's opening tag. `null` means the
 * value runs to the end of the glued text — the ordinary single-glue case,
 * where the parser consumed the FIRST real closing tag it found as this
 * field's own and the tail simply ends unclosed.
 *
 * Returns the offset just past the boundary token, so the caller can resume
 * scanning for the next parameter block there.
 */
function gluedValueEnd(rest: string, parameterName: string): number | null {
  const boundaries: Array<{ start: number; resumeAt: number }> = [];
  const fakeClosing = `</${parameterName}>`;
  const fake = rest.indexOf(fakeClosing);
  if (fake >= 0) {
    boundaries.push({ start: fake, resumeAt: fake + fakeClosing.length });
  }
  const close = PARAMETER_CLOSE.exec(rest);
  if (close) {
    boundaries.push({ start: close.index, resumeAt: close.index + close[0].length });
  }
  const nextOpen = PARAMETER_NEXT_OPEN.exec(rest);
  if (nextOpen) {
    // The next block's opening tag is a boundary but is NOT consumed — the
    // loop above has to see it to read the parameter's name.
    boundaries.push({ start: nextOpen.index, resumeAt: nextOpen.index });
  }
  if (boundaries.length === 0) {
    return null;
  }
  return boundaries.reduce((best, candidate) =>
    candidate.start < best.start ? candidate : best,
  ).resumeAt;
}

/**
 * STRICT recovery parse of one rejected field's glued tail: split the text at
 * the first closing tag named after the field itself, then read the remainder
 * as a run of parameter blocks followed by an optional call end. Anything that
 * does not parse cleanly returns `null`, and the caller falls back to the
 * generic message — a misattributed echo ("your `insight` did not land" when it
 * did) is worse than no echo, because the caller would rewrite a field that was
 * never the problem.
 */
export function parseGluedToolCall(
  field: string,
  text: string,
): GluedToolCallShape | null {
  const closingTagName = field.split(".").pop() ?? field;
  const marker = `</${closingTagName}>`;
  const at = text.indexOf(marker);
  if (at < 0) {
    return null;
  }
  let rest = text.slice(at + marker.length);
  const gluedParameters: string[] = [];
  for (;;) {
    const open = PARAMETER_OPEN.exec(rest);
    if (!open) {
      break;
    }
    const parameterName = open[1]!;
    if (!gluedParameters.includes(parameterName)) {
      gluedParameters.push(parameterName);
    }
    rest = rest.slice(open[0].length);
    const end = gluedValueEnd(rest, parameterName);
    rest = end === null ? "" : rest.slice(end);
  }
  for (;;) {
    const end = CALL_END.exec(rest);
    if (!end) {
      break;
    }
    rest = rest.slice(end[0].length);
  }
  if (rest.trim() !== "" || gluedParameters.length === 0) {
    return null;
  }
  return { closingTagName, gluedParameters };
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

function formatNameList(names: readonly string[]): string {
  if (names.length === 1) {
    return names[0]!;
  }
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]!}`;
}

function gluedToolCallMessage(field: string, shape: GluedToolCallShape): string {
  const names = formatNameList(shape.gluedParameters);
  const many = shape.gluedParameters.length > 1;
  return (
    `${field} contains tool-call syntax. The call closed ${field} with a tag ` +
    `named after ${shape.closingTagName} rather than with the parameter ` +
    `closing tag, so the parser stopped routing there: ${names} ` +
    `${many ? "were" : "was"} carried into ${field} as literal text and ` +
    `${many ? "were" : "was"} never received as ${many ? "parameters" : "a parameter"} ` +
    "at all. Nothing was stored. Send the call again, closing every parameter " +
    "with the parameter closing tag instead of with the field's own name."
  );
}

/**
 * The rejection a caller reads. `text` is the offending field's own value; pass
 * it whenever the call site has it, and the shape echo above replaces the
 * generic wording. Pure — the loop counter below is a separate, explicit call.
 */
export function toolCallSyntaxMessage(field: string, text?: string): string {
  const shape = text === undefined ? null : parseGluedToolCall(field, text);
  if (shape) {
    return gluedToolCallMessage(field, shape);
  }
  return (
    `${field} contains tool-call syntax — a raw parameter or invoke tag sitting ` +
    "in the prose. That is almost always a malformed tool call whose closing " +
    "tag was written wrong, so the parser glued the next parameter onto this " +
    "field's text instead of routing it. Nothing was stored; resend with " +
    "well-formed prose."
  );
}

export function toolCallSyntaxLoopMessage(address: string, count: number): string {
  return (
    `This is rejection ${count} in a row for ${address}, every one of them the ` +
    "same malformed serialization: the broken call is now part of this " +
    "context and each retry copies it, so retrying again will fail the same " +
    "way. Stop rewriting this note — leave it to settlement, or write it once " +
    "after a compact has cleared the broken call out of the context."
  );
}

// ---------------------------------------------------------------------------
// Consecutive-rejection counter
// ---------------------------------------------------------------------------

const consecutiveRejections = new Map<string, number>();

/** Counts this rejection against `address` and returns the new run length. */
export function recordToolCallSyntaxRejection(address: string): number {
  const next = (consecutiveRejections.get(address) ?? 0) + 1;
  consecutiveRejections.set(address, next);
  return next;
}

/** A successful write on `address` ends the run — call it on every success. */
export function clearToolCallSyntaxRejections(address: string): void {
  consecutiveRejections.delete(address);
}

/**
 * Test seam only. The counter is process-global by design (see this module's
 * header), which means one test's run length would otherwise leak into the
 * next test in the same process.
 */
export function resetToolCallSyntaxRejectionsForTests(): void {
  consecutiveRejections.clear();
}
