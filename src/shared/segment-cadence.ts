/**
 * The maintenance cadence's "too soon" threshold (ADR-0002): under this many
 * turns since the segment's last touch, a fresh write draws the too-soon
 * reminder on `remember`'s own receipt (`mcp/remember.ts`).
 *
 * Ticket 13 (spec "节奏与建段指导") retired this module's other half — the
 * `nudgeAtOrAbove` threshold that used to draw a "consider a maintenance
 * pass" suffix on the segment card's header (`mcp/segment-card.ts`) once a
 * segment went 20+ turns unmaintained. That nudge only ever reached a
 * session that already had the card in view (SessionStart or `recall` on an
 * ATTACHED segment); the ticket's whole point was that judgment about
 * whether to create or attach in the first place needs a reminder that
 * reaches every session, attached or not — the universal 20-turn `remember`
 * check on the UserPromptSubmit channel (`hooks/note-reminder.ts`'s
 * `renderRememberReminder`) now carries that function instead, and the card
 * header goes back to stating the bare "maintenance N turns ago" fact with
 * no suffix.
 *
 * `tooSoonUnder` survives as its own scalar (not part of a pair any more) —
 * `remember.ts` is its one remaining consumer.
 */
export const TOO_SOON_UNDER_TURNS = 10;
