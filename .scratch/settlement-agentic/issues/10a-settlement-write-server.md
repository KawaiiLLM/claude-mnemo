# 10a — A settlement write server the model cannot talk its way out of

**What to build:** The settlement pass writes each turn's verdict as it decides it, through a surface that grants it exactly the authority the retiring write-back granted it and nothing more — and a window that leaves a hole unfilled cannot be marked complete.

**Blocked by:** 03, 07, 09

**Status:** ready-for-agent

Ticket 10 was one cutover. A cross-session review found that it removes three proven fences in the same change that adds their replacement, so it splits: **the fences come first**, and the envelope is demolished in 10b once they hold.

The danger is not "tools". It is that the write-back holds settlement-specific authority the public note tool does not have — narrower in what it may write, and wider in what it must prove — and handing settlement the main-agent schema raw silently grants it `skip`, session fields, `crossSession`, append modes, prose rewrites over any existing turn, and the main agent's own relation authority.

- [ ] Job id and claim generation enter the **per-request** server factory and are invisible to the model — today the handlers are built once, outside the per-request closure, so there is nowhere for a job identity to live
- [ ] The ownership fence runs inside the **same transaction as the write it guards**. `assert(); write()` as two transactions is a lease TOCTOU, not a fence
- [ ] Settlement writes turns through a restricted facade over the shared primitive, not the main-agent schema: no `skip`, no session fields, no `crossSession`, no append; prose only for this dispatch's reconstructable holes and yielding to a note the agent landed late; grade/type/tags only for the window's reviewable turns; tags as a replace-set
- [ ] Relation eligibility comes from a pair snapshot taken **before the model run**, not per tool call — otherwise an earlier call mints a pair and a later call self-licenses its relation, which is exactly the "a reply cannot create its own eligibility" rule ticket 07 established
- [ ] **The completion gate proves duty 2** (spec G1a): no turn in the frozen window is still owed a note, computed inside the same transaction as the anti-join and the compare-and-set
- [ ] **The last surviving tag merge dies here.** The review directive carries a single `tag`, which is why the write-back still routes through `mergeTags` while every public write overwrites whole (spec D5a). Grow the directive to a full tag list in the same change, then delete `mergeTags` and the turn update input's additive `tags` parameter — a writer that can only state one value cannot be asked to state a set, so the shape has to change before the rule can
- [ ] **A whole-rewrite field is rejected when omitted, never defaulted to empty.** The retiring write-back defaults an absent field to empty, survivable only because reconstructed notes target holes; the replacement schema inherits no such protection and must refuse the call
- [ ] A query that succeeds, or a final prose answer, never means completion — only the gate may report success
- [ ] Each tool call remains one transaction over its body, its derived edges and its status
- [ ] Full suite green

## The protections being replaced, with their current homes

Named so the replacement can be diffed against them rather than reinvented:

- hole scope and the late-note race — the reconstruction loop's own guards
- review scope, and yielding to a note the agent wrote after the window was cut
- the reply-level pre-state relation snapshot (ticket 07)
- the runtime gap coverage guard that throws and rolls back the whole reply when a reconstructable hole is left open — this is the one G1a is about, and the one with no replacement today
