/**
 * Console-facing status classification for a read-only memory query — recall
 * or timeline (ticket 16 scope addition, peer review finding P2: "the
 * console-native 400/404 contract was never implemented — every failure
 * comes back 200 with prose error text"). `recallMemory`/`timelineQuery`
 * (this same module's siblings) keep returning a plain string, UNCHANGED —
 * that string is the MCP tool's own long-pinned contract. `recallQueryOutcome`
 * (`recall.ts`) and `timelineQueryOutcome` (`timeline.ts`) are an ADDITIONAL,
 * TYPED entry point over the exact same render: `400` for an id/parameter
 * shape neither module's own routes recognize, `404` for a recognized shape
 * whose target/range/lane the render could not find, `200` otherwise. The
 * console API reads its HTTP status from THIS discriminant, never by
 * pattern-matching the rendered prose.
 */
export type QueryOutcome =
  | { status: 200; text: string }
  | { status: 400; message: string }
  | { status: 404; message: string };
