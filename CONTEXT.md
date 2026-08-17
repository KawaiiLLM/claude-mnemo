# claude-mnemo

Persistent memory for Claude Code sessions: an episodic layer of recorded turns and
a semantic layer of task containers, maintained by the agents that do the work.
Vocabulary pinned by the 2026-08-17 segment redesign (ADR-0001…0006).

## Language

### Memory model

**Turn note**:
The episodic record of one conversation turn: its conclusion, the expansion of that
conclusion, and any lesson.
_Avoid_: extraction, summary

**Segment**:
The long-lived semantic container for one task lane, accumulating across sessions.
_Avoid_: arc (for this concept), topic (the label is not the container)

**Arc** (also **episode**):
One bounded span of a task's activity inside a segment's history.
_Avoid_: segment (for this concept)

**Session**:
The episodic container for one conversation. Carries no semantic memory.
_Avoid_: task (a session is a slice of one or more tasks)

**Summary layer**:
The segment fields written for outsiders browsing the task.

**Working State**:
The segment fields a resuming session needs to continue the task.
_Avoid_: working set (that's the attached segments), summary

**Attachment (挂靠)**:
A session's reference to a segment as loaded working memory. Not a lifecycle object.
_Avoid_: binding, subscription

**Membership**:
A turn's belonging to a segment, decided by the turn's content.
_Avoid_: attachment (sessions attach; turns are members)

**Homeless turn (无归属)**:
A turn belonging to no segment. Legal — noise stays out of the semantic layer.

**Roster (花名册)**:
The injected list of live segments that makes attachment and creation
read-before-write.

**Proposal**:
Settlement's text-only suggestion that homeless turns form a new segment. Never a
database object, never auto-adopted.

### Judging

**Settlement**:
The asynchronous pass that judges a finished window of turns: election, edge
reconciliation, membership assignment.

**Election (差额选举)**:
Settlement's competitive three-tier ranking (A/B/C) of a window's turns under seat
ceilings.
_Avoid_: grading, scoring (the legacy absolute 0–4 semantics)

**Citation floor**:
The rule that a summary-layer claim exists only with a turn citation.

**Era**:
A semantics boundary in stored data; reads never mix the two sides.

### Tools

**note**:
The main agent's episodic write surface (记录): turn notes and the session title.

**remember**:
The main agent's semantic write surface (记住): segment creation, attachment, and
field maintenance.
_Avoid_: the retired 0.x remember (merged into note)

**Tag**:
A noun naming a thing — the project first, then subsystems or artifacts. Activities
belong to `type`, never to tags.
_Avoid_: activity-suffixed hybrids (`segment-design`)
