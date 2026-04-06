# Mnemosyne Prompt Hardening Design

## Goal

Strengthen Mnemosyne's extraction prompt so the agent produces more consistent, higher-signal `save_turn` / `update_session` tool usage without materially increasing prompt complexity or changing the surrounding hook architecture.

This change is scoped to prompt behavior only. It does not alter:
- hook lifecycle
- DB schema
- MCP tool contracts
- replay / recall semantics

## Problems With The Current Prompt

The current prompt establishes the basic observer role and turn-state rules, but it is still underspecified in the areas that most affect extraction quality:

- Output discipline is weak. It says "only tool calls", but does not explicitly forbid explanatory filler like "Skipping" or "No meaningful changes".
- Durable-signal boundaries are too vague. It does not clearly say that concrete debugging evidence from logs, queue state, DB rows, routing, and code-path inspection should be recorded.
- Field-quality requirements are thin. It lacks explicit guidance for writing strong `title`, `description`, `facts`, and `files_*` fields.
- Deduplication is underspecified. It does not clearly tell Mnemosyne to avoid recording the same conclusion repeatedly across adjacent turns.
- The prompt has no positive/negative examples to anchor behavior.

## Recommended Approach

Keep the existing single-file prompt builder and strengthen it in place.

Why this approach:
- It preserves the current architecture and test shape.
- It adds meaningful constraints without introducing a prompt-fragment config system.
- It is enough to close the biggest quality gaps revealed by comparison with `claude-mem`.

Alternatives considered:
- Tiny patch with only one or two extra sentences: too weak, leaves field-quality and dedup problems unresolved.
- Full modular prompt configuration like `claude-mem`: more flexible, but unnecessary for the current repo.

## Prompt Structure

The prompt will remain a single generated string, but its content should be reorganized into clearer sections:

1. Role and status handling
2. What to record
3. What to skip
4. Field quality rules
5. Deduplication rules
6. Output discipline
7. Short examples

## Prompt Requirements

### 1. Role And Status Handling

Retain the existing lifecycle guidance:
- process `[pending]`
- re-evaluate `[stale]`
- skip `[extracted]`, `[skipped]`, `[undone]`
- use explicit `status="undone"` for undone branches

This section should remain near the top because it is the most important routing rule.

### 2. What To Record

Expand the durable-signal guidance to explicitly include:
- shipped or user-visible behavior changes
- concrete fixes, implementations, refactors, and decisions
- debugging findings grounded in evidence
- concrete discoveries from logs, queue state, DB rows, routing, request flow, or code-path inspection

The prompt should steer the agent toward recording outcomes and findings, not narrating the whole conversation.

### 3. What To Skip

Retain the current skip guidance, but make the principle more explicit:
- trivial chatter
- routine checks with no findings
- aborted work with no outcome
- repeated work that adds no new durable information

### 4. Field Quality Rules

Add explicit rules for the generated fields:
- `title`: short, action- or outcome-oriented, not generic
- `description`: concise statement of what changed or was learned, not a restatement of the user prompt
- `facts`: independent, verifiable statements rather than vague summaries
- `files_read` / `files_modified`: list only files that materially informed or changed the recorded result

### 5. Deduplication Rules

Add explicit instructions to avoid repeated extraction:
- do not create a new observation if the turn only repeats a conclusion already recorded in adjacent turns
- prefer fewer, higher-signal observations over many overlapping ones
- only record follow-up turns when they add a new finding, decision, or completed change

### 6. Output Discipline

Strengthen the current output restriction:
- only tool calls
- no prose explanations
- do not emit filler like "Skipping", "No changes", or "Nothing to record"

This must be worded as a hard constraint because casual prose weakens tool-only behavior.

### 7. Short Examples

Add two short examples:
- one good extraction example for a bugfix/debugging turn
- one skip example for a low-signal turn

Examples should be short enough to avoid bloating the prompt, but concrete enough to anchor behavior.

## Testing

Update prompt tests to verify:
- explicit undone handling remains present
- output-discipline wording forbids prose skip responses
- durable debugging signals are explicitly listed
- long prompt previews remain near the current ~80-character target

## Non-Goals

- No prompt-fragment configuration system
- No new MCP tools
- No changes to save semantics beyond prompt wording
- No changes to hook execution model
