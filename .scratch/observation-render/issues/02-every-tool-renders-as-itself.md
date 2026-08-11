# 02 — Every tool renders as the thing it did

**What to build:** the remaining tools that actually occur get their own
projection, so an edit shows what changed, a read shows what was read, and a
dispatched agent says where its report went. Together with `Bash` from ticket
01 this covers 98.2% of observations recorded since the era cutover; everything
else falls through to the generic rule.

Spec: `.scratch/observation-render/spec.md`. Every classification below is
count-verified in `.scratch/observation-render/survey.md` — treat that file as
the source of truth for payload shapes, and re-check any claim you are about to
rely on rather than trusting this summary.

**Blocked by:** 01 — every entry is written against the projection seam that
ticket establishes, and the entries would be rewritten if its shape moved.

**Status:** ready-for-agent

- [x] An `Edit` renders as the file's basename with the changed lines beneath
      it, and contributes no body from its result — the result repeats the
      input verbatim in every sampled row and appends the whole pre-edit file.
- [x] A `Write` renders as the file's basename with the beginning of what was
      written. Its result's whole-file fields contribute nothing, and a
      create — the majority case, where the pre-edit file is null — renders
      correctly rather than emptily.
- [x] A `Read` renders as the file's basename with how much was read, not with
      the file's contents replayed into the reader's context.
- [x] A `note` renders as the turn it addressed and its title, with the
      receipt beneath.
- [x] An `Agent` renders as the task's own description, and a dispatched
      background agent states that its report is not stored with the call.
      Rendering an empty body would assert that it returned nothing, which is
      false: the completion report arrives later as a turn-level notification
      and never becomes a second observation.
- [x] A file path in a header is shortened to its basename, since the full
      prefix repeats on every line of a render whose session header already
      names the project.
- [x] Coverage test: every tool name present in the era either has a table
      entry or produces a non-empty header through the generic rule. This is
      what turns "we covered the common ones" into a checked property.
- [x] Degradation tests: a projection whose expected key is absent falls
      through to the generic rule rather than yielding an empty body; a result
      that is a bare string, an array of mixed item shapes, or null does not
      throw. The survey found a real instance of each.
- [x] No projection rule is keyed on a key name alone. The same name means
      different things in different tools — the survey shows one key that is
      bulk to drop in one tool, the payload to keep in another, and conditional
      in a third — so every rule is scoped to the tool and the side it applies
      to.
- [x] `bun run typecheck` clean, `bun run build` clean, full suite green.

## Comments

The projection encodes knowledge of Claude Code's tool payloads, which is an
external contract that will move. The generic fallback is not a convenience;
it is what makes that acceptable, and the degradation tests are what keep it
honest.
