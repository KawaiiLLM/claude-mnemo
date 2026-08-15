// The `note` MCP tool (spec D1) is the main agent's own bookkeeping about a
// turn, not work done inside that turn. Its PostToolUse observation is still
// captured — the raw axis stays complete and auditable — but it carries an
// exclusion marker so the legacy extraction pipeline never reads it as work
// content. Without the marker a note call would inflate the ride turn's
// tool_call_count and appear in the extraction agent's observation stream,
// i.e. the act of taking notes would itself manufacture material to take notes
// about, and the P1 trial's two data sources would stop being independent.
//
// The tool name a hook actually sees depends on how the server is mounted:
//   plain `.mcp.json` entry   -> mcp__mnemo__note
//   plugin-scoped server      -> mcp__plugin_claude-mnemo_mnemo__note
// so match the `…mnemo__note` shape under the `mcp__` prefix rather than one
// literal string that silently stops matching when the mount changes.
export const NOTE_TOOL_NAME = "note";

const NOTE_TOOL_NAME_PATTERN = /^mcp__(?:[A-Za-z0-9_-]*_)?mnemo__note$/;

// Same two mount shapes, widened to every tool this system mounts itself.
// ticket 03 (spec E1): `remember` merged into `note` and no longer exists as
// a separate tool name — the pattern drops it rather than matching a name
// nothing can send any more.
const MNEMO_TOOL_NAME_PATTERN =
  /^mcp__(?:[A-Za-z0-9_-]*_)?mnemo__(?:note|recall|timeline)$/;

export function isNoteToolName(toolName: string): boolean {
  return NOTE_TOOL_NAME_PATTERN.test(toolName);
}

/**
 * Mnemo's own tool calls (spec D3, R2#P2-5). The note-debt classification counts
 * a turn's *substantive* tool calls, and memory housekeeping is not work: if
 * recall/timeline/note counted, then answering "what did we decide?"
 * with one recall would open a debt, and taking a note would open the next one —
 * the ledger would manufacture its own input.
 *
 * Deliberately NOT folded into `isExtractionExcludedToolName`: that predicate
 * governs what the legacy extraction pipeline may read, and widening it mid-P1
 * would change the very baseline the trial's blind evaluation compares against.
 * Two predicates, two questions — "does the old pipeline see it" and "does it
 * count as work" — that happen to agree only on `note` today.
 */
export function isMnemoOwnToolName(toolName: string): boolean {
  return MNEMO_TOOL_NAME_PATTERN.test(toolName);
}

/**
 * Tool calls whose observation is captured but withheld from the legacy
 * extraction pipeline. Only `note` qualifies today: recall/timeline
 * observations keep flowing exactly as before, because narrowing the old
 * pipeline's input is a behaviour change this ticket does not own (spec D3
 * revisits the debt-side tool count in the ledger ticket).
 */
export function isExtractionExcludedToolName(toolName: string): boolean {
  return isNoteToolName(toolName);
}
