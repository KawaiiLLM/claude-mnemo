# Mnemosyne Prompt Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Strengthen Mnemosyne's extraction prompt so it produces more consistent, higher-signal `save_turn` / `update_session` tool usage.

**Architecture:** Keep the existing single-file prompt builder in `src/mnemosyne/prompt.ts` and harden it in place. Drive the change with prompt-focused tests that verify output discipline, identity discipline, field-quality guidance, examples, and preservation of existing constraints.

**Tech Stack:** TypeScript, Bun test

---

## File Structure

- Modify: `src/mnemosyne/prompt.ts`
  - Strengthen prompt sections and guidance without changing surrounding architecture.
- Modify: `tests/mnemosyne/prompt.test.ts`
  - Add behavior-focused prompt assertions before implementation.

---

### Task 1: Expand Prompt Tests

**Files:**
- Modify: `tests/mnemosyne/prompt.test.ts`
- Test: `tests/mnemosyne/prompt.test.ts`

- [ ] **Step 1: Write failing tests**
  - Add assertions that the prompt:
    - forbids self-referential observer narration
    - explicitly records debugging evidence from logs / DB rows / routing / code-path inspection
    - preserves `<private>` exclusion
    - distinguishes `concepts` from observation `type`
    - keeps `update_session` decision guidance
    - includes short tool-call-style good/bad/skip examples

- [ ] **Step 2: Run test to verify it fails**

Run: `~/.bun/bin/bun test tests/mnemosyne/prompt.test.ts`
Expected: FAIL because the new prompt wording is not present yet.

- [ ] **Step 3: Implement minimal prompt changes**
  - Update `src/mnemosyne/prompt.ts` only enough to satisfy the new tests.

- [ ] **Step 4: Run test to verify it passes**

Run: `~/.bun/bin/bun test tests/mnemosyne/prompt.test.ts`
Expected: PASS

---

### Task 2: Full Verification

**Files:**
- Modify: `src/mnemosyne/prompt.ts`
- Modify: `tests/mnemosyne/prompt.test.ts`

- [ ] **Step 1: Run full test suite**

Run: `~/.bun/bin/bun test tests`
Expected: PASS

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Run build**

Run: `npm run build`
Expected: PASS

