# 10 — Settlement writes through tools instead of returning a payload

**What to build:** The settlement pass stops returning a batch of instructions for a write-back to interpret, and writes what it decides as it decides it.

**Blocked by:** 03, 07, 09

**Status:** ready-for-agent

Three data-destructive defects came from re-implementing in a payload parser the authorization the tool layer already performs. Window-level atomicity is surrendered deliberately; per-call transactions are not.

- [ ] Settlement writes turns and segments through the shared tools
- [ ] The structured envelope and the write-back layer that interpreted it are deleted
- [ ] A crashed window leaves a partial result and is not marked complete
- [ ] Each tool call remains one transaction over its body, its derived edges and its status
- [ ] The three-strike cursor advance is documented in the job log as abandoning a remainder, not converging
- [ ] Per-tool replay behaviour matches spec G5, and the three writes named unsafe there have a stated contract before this ticket closes
- [ ] **The last surviving tag merge dies here.** The review directive carries a single `tag`, which is why the write-back still routes through `mergeTags` while every public write overwrites whole (spec D5a). Grow the directive to a full tag list in the same change, then delete `mergeTags` and the turn update input's additive `tags` parameter — a writer that can only state one value cannot be asked to state a set, so the shape has to change before the rule can
- [ ] **A whole-rewrite field must be rejected when omitted, never defaulted to empty.** The retiring write-back layer defaults an absent field to empty, which is survivable only because reconstructed notes target holes; the replacement tool schemas inherit no such protection and must refuse the call instead
- [ ] Full suite green
