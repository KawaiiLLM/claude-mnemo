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
- [ ] Full suite green
