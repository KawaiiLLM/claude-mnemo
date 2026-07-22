# Async tool attribution and turn liveness

**Status:** ready-for-agent
**Date:** 2026-07-22
**Origin:** S14912 — production dream-block diagnosis across S15233, S15410, and S15440; verified against Claude Code hook semantics and the live queue

## Problem Statement

Claude Code emits two independent streams around background work. A top-level `Agent`, asynchronous `Bash`, or `SendMessage` call produces its own `PostToolUse` when the launch or send operation returns. The child agent's internal tools later produce additional `PostToolUse` hooks carrying the root `session_id` plus a child-specific `agent_id`. When the background task finishes, Claude Code separately injects a task or teammate notification as a new user-role input.

Mnemo currently normalizes the root session identity but discards `agent_id`. Its `PostToolUse` handler therefore attaches every hook sharing that root session to the latest root-session turn. Child-agent Bash, WebFetch, WebSearch, and SendMessage events can arrive after the parent turn has already completed and can be written back onto that completed turn as new observations.

This violates the extraction state machine's completion invariant: a consumed `turn-stop` is assumed to be the last event for its turn. Late sidechain observations have no second completion token. A partially streamed turn can remain `provisional`; pending observations can remain queued after their owner turn is already terminal; and those stale rows can pollute the FIFO and delay a later valid `turn-stop`.

The production consequence on 2026-07-22 was a complete dream blockade for content day 2026-07-21:

- S15233 T8287 remained `provisional` with 8 pending observations after child-agent WebFetch and WebSearch activity was attributed to it.
- S15440 T8379 remained `provisional` with 19 pending observations after child-agent Bash and SendMessage activity was attributed to it; 15 observations arrived after the turn's last completion update.
- S15410 T8375 remained `active` with its own `turn-stop` queued behind 40 pending observations owned by already extracted turns.
- The diary item was otherwise ready and unclaimed, but the dream readiness guard correctly refused to run while any content-day turn remained `active` or `provisional`.

The dream guard is not the defect. The defect is that sidechain ownership is erased before persistence, while queue cleanup and stranded-turn recovery do not enforce a terminal-owner invariant or repair completion-evidenced turns across closed sessions.

## Solution

Introduce one ownership rule and one liveness rule.

**Ownership rule:** a `PostToolUse` carrying `agent_id` belongs to a child-agent sidechain, not to the root conversation's turn stream. Mnemo ignores it for root-turn observation extraction. Root tool events without `agent_id` continue to be recorded exactly as today.

**Liveness rule:** pending extraction work may exist only for an `active` or `provisional` owner with a reachable completion path. End-event coordination repairs closed-day violations before attempting dream claim: terminal-owner queue rows are retired, structurally stranded turns are reconnected to a completion path when possible, and completion-evidenced turns with no recoverable execution path are finalized through the existing model-free completion floor.

The repaired end-event order is:

1. Drain ordinary extraction work for the triggering event.
2. Reconcile due diary days.
3. Inspect unfinalized turns and queued observations inside those due content days.
4. Retire terminal-owner queue pollution and restore missing completion work.
5. Run a second ordinary drain only when repair created executable work.
6. Apply the existing completion floor only to completion-evidenced turns that remain structurally unreachable.
7. Claim at most one diary item after the unchanged `active` / `provisional` readiness guard passes.

This preserves the event-driven design: repair and any resulting extraction occur only under `Stop`, `SessionEnd`, or `PreCompact`; worker startup and `SessionStart` do not initiate new agent requests.

## User Stories

1. As the extraction worker, I want child-agent hook events identified by `agent_id`, so that I do not mistake sidechain activity for root-turn evidence.
2. As the extraction worker, I want top-level Agent tool launches to remain ordinary root `PostToolUse` events, so that the main turn still records that it delegated work.
3. As the extraction worker, I want top-level asynchronous Bash launches to remain ordinary root tool events, so that background execution intent remains visible.
4. As the extraction worker, I want top-level SendMessage calls to remain ordinary root tool events, so that agent coordination remains visible in the sending turn.
5. As the extraction worker, I want child-agent Bash, Read, WebFetch, WebSearch, and SendMessage hooks excluded uniformly, so that ownership does not depend on tool names.
6. As the extraction worker, I want ownership determined only by Claude Code's explicit `agent_id`, so that timing and latest-turn heuristics cannot change attribution.
7. As a maintainer, I want `agent_id` preserved in normalized hook input, so that later handlers can make ownership decisions without parsing raw payloads.
8. As a maintainer, I want root `PostToolUse` handlers to write only to a live root turn, so that no new observation is attached to an already terminal turn.
9. As a maintainer, I want child-sidechain events to be a no-op before database lookup and worker wake, so that ignored events create no queue or process churn.
10. As a user, I want task completion notifications to remain distinct from tool lifecycle events, so that a new notification input is not confused with a second completion-time `PostToolUse`.
11. As the queue worker, I want pending observations whose owner is already terminal retired before buffering, so that stale rows cannot contaminate FIFO order or session buffers.
12. As the queue worker, I want terminal-owner retirement to update observation state and remove its queue row atomically, so that queue and observation state cannot disagree after a crash.
13. As the queue worker, I want `undone`, `failed`, `skipped`, and `extracted` owners treated consistently as terminal, so that no terminal status silently remains processable.
14. As the queue worker, I want valid `active` and `provisional` observations processed unchanged, so that normal streaming extraction is unaffected.
15. As the end-event coordinator, I want to detect a nonfinal turn whose completion is evidenced by a queued `turn-stop` or a later turn in the same session, so that an old turn cannot remain live merely because its original completion token was lost.
16. As the end-event coordinator, I want a stranded turn with a registered execution environment reconnected by a deduplicated `turn-stop`, so that recoverable extraction is completed rather than discarded.
17. As the end-event coordinator, I want a closed-day stranded turn with no recoverable environment finalized through the existing completion floor, so that a dead session cannot block all future diary work forever.
18. As the end-event coordinator, I want partial extracted content preserved when the completion floor can establish a usable record, so that recovery loses only the unreachable tail.
19. As the end-event coordinator, I want a turn with no usable extracted record finalized as `failed`, so that the system records loss honestly instead of fabricating a summary.
20. As the end-event coordinator, I want pending observations and obsolete stop rows retired when a turn is floored, so that terminalization leaves no queue residue.
21. As a user, I want a transiently running background task left alone while it still has a live completion path, so that liveness repair does not terminate legitimate work merely because a date boundary passed.
22. As a user, I want dream generation to continue waiting for genuinely live extraction work, so that diary consistency is not weakened to hide an extraction bug.
23. As a user, I want structurally dead extraction work repaired under the next end event, so that I do not need to resume every old session manually.
24. As a user, I want repair to remain event-driven, so that worker startup and SessionStart cannot reopen unbounded agent cost.
25. As a maintainer, I want repair restricted to content days already due for diary processing, so that an end event does not scan or rewrite unrelated recent work.
26. As a maintainer, I want a second extraction drain only when repair enqueued new work, so that the common end-event path remains cheap.
27. As a maintainer, I want all repair operations idempotent, so that repeated Stop, SessionEnd, and PreCompact events do not duplicate stops or change terminal records again.
28. As a maintainer, I want worker restarts to reset stale claims before repair, so that claimed orphan rows become inspectable and recoverable on the next end event.
29. As a maintainer, I want the production shapes from S15233, S15410, and S15440 encoded as regression fixtures, so that this exact dream blockade cannot recur unnoticed.
30. As a reviewer, I want tests to distinguish root tool hooks, child-agent hooks, and completion notifications, so that a passing test cannot conflate the three Claude Code channels.
31. As a reviewer, I want the highest-level regression to end with the diary item becoming claimable only after extraction repair, so that the whole causal chain is covered rather than isolated helpers.
32. As an operator, I want structured diagnostics when a sidechain hook is ignored or a stale turn is floored, so that future incidents can be explained without reading raw transcripts.

## Implementation Decisions

- **Normalize child identity.** The Claude Code hook adapter adds an optional `agentId` field sourced from `agent_id`. Absence means a root-thread event; presence means a child-agent sidechain event. The raw payload remains available as today, but ownership logic uses the normalized field.
- **Filter at the observation boundary.** The root `PostToolUse` observation handler returns success without inserting an observation, enqueueing work, or waking the worker when `agentId` is present. Filtering occurs before session and latest-turn lookup so a child event cannot influence root state indirectly.
- **Do not infer ownership from tools or timing.** Agent, Bash, SendMessage, WebFetch, and all future tools follow the same identity rule. A top-level Agent or background Bash call has no child `agentId` and remains recorded; a child agent's internal tools carry `agentId` and are excluded.
- **Keep completion notifications separate.** Task and teammate notifications remain user-role inputs governed by the existing prompt path. This feature does not reinterpret a completion notification as a tool result and does not use notification text to infer tool ownership.
- **Require a live root owner.** A root `PostToolUse` may attach only to the latest `active` or `provisional` root turn. If no live root turn exists, the handler performs a non-blocking no-op and emits a bounded diagnostic. It never reopens `extracted`, `skipped`, `failed`, or `undone` turns.
- **Enforce terminal-owner queue hygiene.** Before an observation queue item enters a session buffer, the worker checks its owning turn. Missing owners and terminal owners are retired instead of buffered. Retirement marks the observation skipped and deletes the queue row in one transaction. Existing semantics for valid active/provisional owners remain unchanged.
- **Use completion evidence, not age alone.** A nonfinal turn is structurally stranded only when its main response is present and completion is evidenced by either an existing `turn-stop`, a later turn in the same root session, or an existing invalidation signal. Merely crossing the content-day boundary is not enough to terminate genuinely running work.
- **Repair only due content days.** End-event orchestration first establishes which diary days are due, then runs extraction-liveness repair only over those days. This keeps the scan bounded by the same content-day backlog that can block dream.
- **Prefer normal completion.** If a stranded turn lacks a stop but its original session environment is registered, repair enqueueing uses the existing deduplicated turn-stop path and lets the ordinary worker complete extraction.
- **Use the existing completion floor as the last resort.** If a completion-evidenced closed-day turn has no reachable execution path after the repair drain, the worker applies the same floor already used at extraction completion: preserve a usable partial record as extracted; otherwise mark the turn failed. No model-generated fallback content is invented.
- **Clean the turn atomically when flooring.** Floor application also retires all remaining observation queue rows and obsolete turn-stop rows for that turn. Repeating repair is a no-op once the turn is terminal.
- **Run under end events only.** Stop, SessionEnd, and PreCompact can initiate the repair pipeline. SessionStart may continue its existing local context recovery but does not become the trigger for this global repair or for dream work. Worker boot alone performs no agent request.
- **Repair before dream claim.** If repair adds queue work, the coordinator performs one additional ordinary drain before checking diary readiness. Dream keeps the existing rule that any remaining active/provisional turn withholds the day.
- **No schema migration.** Child identity is needed only at hook handling time. The repair derives its decisions from existing turn, observation, and queue state; no `agent_id`, origin, or liveness column is added.
- **No historical sidechain reconstruction.** Existing child-agent tool events are not reassigned to synthetic subagent turns. The first post-deploy end event repairs queue and turn liveness only; already persisted narrative fields remain as recorded.
- **Diagnostics are bounded.** Ignored sidechain events and model-free floors use structured logs with session/turn identifiers and reason codes, without logging tool payloads or notification bodies.

## Testing Decisions

- Tests assert externally observable ownership, queue, turn-status, and diary-readiness outcomes. They do not assert private helper call counts, buffer internals, or exact log prose.
- The primary regression uses the existing end-to-end hook-to-worker seam: raw Claude Code hook payloads enter through the hook command, use production normalization and handlers, pass through the worker request boundary, and finish at the database and diary claim interfaces.
- The primary fixture contains three shapes in one due content day: a root turn receiving a child `PostToolUse` after completion, a provisional turn with pending observations but no stop followed by a later turn, and an active turn whose valid stop sits behind terminal-owner observation pollution.
- The primary assertions are: child hooks create no root observation; root hooks still create one; terminal-owner queue rows are retired; stranded turns become terminal through normal completion or the existing floor; no unrelated current-day turn is modified; and the diary item is unclaimable before repair but claimable afterward.
- Adapter tests cover `agent_id` normalization and confirm that root payloads leave `agentId` absent.
- PostToolUse handler tests reuse the existing in-memory session/turn fixture to compare root and child payloads and to verify the terminal-owner no-op.
- Queue tests add explicit extracted-, skipped-, failed-, and undone-owner cases; each must retire without entering a buffer, while active and provisional owners remain processable.
- Stranded-recovery tests cover deduplicated stop restoration, later-turn completion evidence, environment-available recovery, environment-unavailable floor behavior, and idempotent repetition.
- Worker orchestration tests cover Stop, SessionEnd, and PreCompact as equivalent end-event entry points and confirm that repair is not run from a pure liveness scan or worker boot.
- Diary tests retain the existing active/provisional guard unchanged and add an integration assertion that the guard turns green only because extraction state was repaired, not because readiness ignored it.
- Task-notification tests demonstrate that the notification input and child `PostToolUse` are independent events: the notification may follow the normal prompt path, while the child hook still cannot write into either the parent turn or the notification turn.
- All tests use seeded in-memory databases and fake worker processors; no live Claude call is required. Tests entering main worker assembly pass an explicit temporary data root under the existing HOME sandbox.
- Prior art is the existing Claude Code adapter suite, PostToolUse hook suite, Stop/SessionEnd/PreCompact hook suites, stranded-turn recovery suite, worker end-event/dream reconciliation suite, diary readiness suite, and queue-backed end-to-end smoke test.

## Out of Scope

- Persisting complete child-agent transcripts or creating first-class subagent turns in the main database.
- Reassigning historical child-agent observations to their original child transcripts.
- Changing Claude Code's task-notification, teammate-message, or queued-command behavior.
- Resolving the existing inconsistency between notification turns created by the live prompt path and notification filtering in replay parsing; that is a separate modeling issue.
- Changing PreToolUse rule dispatch for child agents.
- Changing the dream agent's content, retry policy, date boundary, backlog limit, or active/provisional readiness guard.
- Triggering repair or dream work from SessionStart, worker startup, a timer, or polling.
- Re-extracting all historical sessions or introducing a background migration.
- Storing `agent_id` in the turn or observation schema.
- Relaxing session-environment isolation by running an old session's extraction under an unrelated current session environment.

## Further Notes

- Claude Code already supplies the identity needed for the fix. Root and child tool hooks share `session_id`, while child hooks alone carry `agent_id`; no heuristic or upstream change is required.
- A background task's completion notification does not generate a second completion-time `PostToolUse`. The top-level tool hook occurs when the task is launched; child internal tool hooks occur inside the sidechain; the notification is a later user-role input.
- S15233 and S15440 directly demonstrate child-sidechain misattribution. S15410 demonstrates the second-order queue effect: terminal-owner observation pollution can prevent an unrelated valid stop from reaching completion.
- The first deployment end event should be sufficient to repair the current production blockade: orphan rows become retireable after claim reset, T8287/T8379 have later-turn completion evidence, and T8375 already has a valid stop behind removable terminal-owner pollution.
- The design intentionally keeps the dream consistency barrier strict. A day becomes runnable because extraction regains a terminal state, never because dream is taught to ignore unfinished turns.
