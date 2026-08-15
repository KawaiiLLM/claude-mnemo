// spec E2 / ticket 03: reject prose that carries raw tool-call markup rather
// than silently storing it. Measured against production: 99 rows carry
// `<parameter name="…">` fragments inside `content` — almost all of them the
// shape `…</content>\n<parameter name="insight">…`, i.e. a tool call whose
// closing tag was written wrong (`</content>` instead of `</parameter>`), so
// the SDK's own parser glued the NEXT parameter's opening tag and value onto
// this one's text instead of routing it. The failure is silent today: the
// `insight` a caller thought it sent never lands anywhere, and the malformed
// fragment gets stored as if it were prose. Detecting it at the write
// boundary turns that into a loud, readable rejection instead.
const TOOL_CALL_SYNTAX_PATTERN =
  /<\/?(?:parameter|invoke|function_calls|antml:[a-z_]+)\b/i;

export function containsToolCallSyntax(text: string): boolean {
  return TOOL_CALL_SYNTAX_PATTERN.test(text);
}

export function toolCallSyntaxMessage(field: string): string {
  return (
    `${field} contains tool-call syntax (a literal "<parameter", "<invoke" or ` +
    "similar tag) — this is almost always a malformed tool call whose closing " +
    "tag glued the next parameter onto this one. Nothing was stored; resend " +
    "with well-formed prose."
  );
}
