---
name: mnemo-remember
description: Save durable cross-session memories — user feedback, project decisions, recurring patterns, and lessons learned. Use when the user says "remember this", "save this as feedback", "make a note that...", or when you notice a non-obvious fact that will matter in future sessions.
---

# Mnemo Remember

Write durable memory that survives across sessions. One tool, one purpose:

- `remember({ type, scope, title, content, ... })` — create a new memory

**This skill is about creating memories only.** Turn, observation, and session records are managed automatically by the Mnemosyne worker — you don't need to write to those from the main agent. If the user asks to "save this turn" or "write an observation", that work is already happening in the background; the user usually means "create a memory capturing the insight from this turn."

## When to Use

Use proactively when:

- The user gives explicit feedback ("don't do X", "always prefer Y", "stop using Z")
- The user makes a non-obvious project decision ("we're going with Postgres because of...")
- You discover a pattern, constraint, or gotcha that will matter later ("this service silently drops payloads >1MB")
- The user explicitly asks you to remember something ("记住这个", "save this as a note")
- You infer something about the user's role, preferences, or workflow that will change how you collaborate

Use when the user asks to save things explicitly:

- "Remember that we use snake_case for DB columns"
- "Save this as feedback: don't create README files"
- "Make a project note: the staging env is slow on Mondays"

**Do not** use for:

- Temporary task state (use TodoWrite / Plan)
- Information that's derivable from `git log` / code / CLAUDE.md
- Debugging details that are only relevant to the current session

## The One Call

```
remember({
  type: "feedback",
  scope: "global",
  title: "Prefer terse commit messages",
  content: "User prefers 1-2 sentence commit bodies focused on *why*, not *what*. Skip bullet lists unless the change is multi-faceted.",
  reasoning: "Corrected me twice when I wrote long multi-paragraph commits.",
  application: "Apply when drafting any git commit message.",
  tags: ["git", "style"]
})
```

Four fields are required: `type`, `scope`, `title`, `content`. Everything else is optional but often worth filling in — `reasoning` and `application` make the memory useful to future-you, and `tags` make it searchable via `recall(query="tag:...")`.

## Required Fields

### `type` (string, free-form)

Classifies what kind of memory this is. Conventions in this project:

| Type | Use for |
|---|---|
| `feedback` | User corrections, preferences, "stop doing X" / "keep doing Y" |
| `decision` | Project choices with a why (tech selection, architectural calls, trade-offs) |
| `pattern` | Recurring patterns, conventions, idioms in this codebase |
| `gotcha` | Non-obvious constraints, silent failures, counterintuitive behaviors |
| `lesson` | "We tried X, it didn't work, we learned Y" |
| `context` | Domain knowledge, stakeholder info, external dependencies |

Type is a free-form string; the above are conventions, not an enum. Pick the closest fit; if none match cleanly, make one up that a future search will plausibly guess.

### `scope` (string)

Controls visibility:

- `"global"` — applies across all projects (user preferences, general feedback, tool usage)
- `<absolute project path>` — specific to one repo (e.g. `"/Users/alice/code/payment-service"`)

Search looks up both `global` memories and memories scoped to the current project, so project-scoped memories are preferred when the knowledge is local. Use `global` only when the memory is truly portable.

### `title` (string)

One-line handle. Aim for 20-60 chars. Show the *rule* or *fact*, not the context:

- **Good**: "Prefer terse commit messages"
- **Good**: "Staging DB drops connections after 30s idle"
- **Bad**: "User said something about commits today"

### `content` (string)

The body. This is what you'll read when recall surfaces this memory. Keep it self-contained — don't rely on context from the creating session.

For `feedback` / `decision` memories, structure as:

```
<the rule or fact>

**Why:** <the reason, often a prior incident or constraint>
**How to apply:** <when/where this kicks in>
```

This matches the auto-memory style and makes the memory actionable at read time.

## Optional Fields

### `reasoning` (string)

The *why* behind the memory. Separate field from `content` so recall can surface it independently. Include the specific incident, constraint, or user statement that triggered the memory.

### `application` (string)

When future-you should apply this memory. A pointer, not a restatement of `content`. Example: *"Apply when drafting any git commit message."*

### `tags` (string[])

Searchable labels. Use lowercase, hyphenated. Examples: `["git", "style"]`, `["database", "migrations"]`, `["testing", "mocks"]`. Retrieve via `recall(query="tag:git")` (mnemo-recall skill).

### `source` (string, format `"T12"`)

Links the memory back to a specific turn in the current session where the insight originated. Format is `"T<promptNumber>"` matching the turn id shown in recall/replay output. Preserves provenance — future-you can trace where a memory came from.

Example: `source: "T5"` means "this memory was created during turn 5 of the current session." You need to know the current turn number to set this; if you're not sure, omit it.

### `status` (string, default `"active"`)

- `"active"` — in effect (default)
- `"superseded"` — replaced by a newer memory (rarely set at creation time)
- `"archived"` — no longer applies

Almost always omit this; the default is correct.

## Examples

### User feedback

```
remember({
  type: "feedback",
  scope: "global",
  title: "Don't create README files unless asked",
  content: "Avoid creating *.md documentation files proactively.\n\n**Why:** User called out unwanted README creation on 2026-04-05.\n**How to apply:** Never create documentation files unless the user explicitly requests them.",
  reasoning: "User said 'stop adding READMEs to every new subdirectory'.",
  application: "Apply before creating any .md file.",
  tags: ["documentation", "file-creation"]
})
```

### Project decision

```
remember({
  type: "decision",
  scope: "/Users/alice/code/payment-service",
  title: "Settled on pgvector over Pinecone for embeddings",
  content: "Using pgvector inside the existing Postgres instance instead of Pinecone.\n\n**Why:** Avoids a second datastore + latency of cross-service calls; vector load is small (<100k rows).\n**How to apply:** Route all new embedding work through pgvector; don't reintroduce Pinecone without revisiting this.",
  reasoning: "Discussed trade-offs in the architecture review on 2026-04-08.",
  application: "Apply when designing any new semantic-search or RAG feature in this repo.",
  tags: ["architecture", "vector-search", "postgres"],
  source: "T7"
})
```

### Gotcha / constraint

```
remember({
  type: "gotcha",
  scope: "/Users/alice/code/payment-service",
  title: "Stripe webhook handler silently swallows >256KB payloads",
  content: "The stripe-webhooks lambda truncates request bodies above 256KB with no log or error. Large disputed-charge events get lost.\n\n**Why:** API Gateway default payload limit; not yet raised.\n**How to apply:** If a webhook handler change involves disputed-charge events, verify payload size and consider streaming to S3 first.",
  application: "Apply when touching src/lambdas/stripe-webhook.ts or debugging missing webhook events.",
  tags: ["stripe", "webhooks", "silent-failure"]
})
```

### Pattern

```
remember({
  type: "pattern",
  scope: "/Users/alice/code/payment-service",
  title: "Integration tests must hit a real Postgres, not mocks",
  content: "All tests in tests/integration/** must use the dockerized Postgres from docker-compose.test.yml. Never mock the DB in this layer.\n\n**Why:** A mocked migration test passed but prod failed during Q1 2026 rollout; team committed to always using the real DB for integration tests.\n**How to apply:** When adding or modifying any test under tests/integration/, ensure it uses the shared testDb fixture, not jest.mock.",
  tags: ["testing", "postgres"]
})
```

## Quality Bar

Before calling `remember`, ask yourself:

1. **Is this derivable from code / git / CLAUDE.md?** If yes, don't save it — reading the source is authoritative.
2. **Will this matter in 3 months, 6 sessions from now?** If no, don't save.
3. **Is the title specific enough that I'll recognize it when searching later?** If the title could describe 10 different memories, make it more specific.
4. **Does the content stand alone?** A future session won't have this conversation's context.

Low-quality memories clutter search results and waste recall budget. It's better to save nothing than to save something vague.

## Retrieval

After saving, the memory is searchable via the `mnemo-recall` skill:

```
recall(query="tag:feedback git")                          # find by tag + keyword
recall(id="M4", depth="expanded")                         # read a specific memory
recall(query="postgres migration")                        # FTS across memory content
```

Project-scoped memories only appear when `recall` is run from that project; global memories always appear.
