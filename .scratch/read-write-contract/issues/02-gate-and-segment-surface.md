# 02 — 三判门 + 首个写面(段字段)

**What to build:** 两个并发会话挂同一段时,后写者若未读过对方改动即被拒并获教学报文——丢更新洞(spec user story 7)关闭。

规范:spec「三判次序」。

- 门判定模块(跨票契约:单一模块,03/05 同源消费):逐字段三判——(1) 读过实体且字段未被他人后写;(2) 上次写者==本会话;(3) 从未被写过;否则拒绝。
- **门判定、写入、印章更新同一事务**(检查-写入原子)。
- 双错误报文:「未读过 → 先 recall <地址>」/「已失效 → <字段> 已被 <写者> 改过,重新 recall」——两形态在报文层可区分。
- 首个消费面:remember 的段字段写(含 Working State);段创建=实体不存在,天然放行。

**Blocked by:** 01(读集与印章)。

**Status:** done

**Implementation record:**

- `checkFieldGate`/`stampField` from `db/write-gate.ts` wired into
  `remember.ts`'s `handleAppend`/`handleReplace` — the gate check runs INSIDE
  the same `writeTransaction` callback as the actual field mutation and the
  stamp that follows it (no separate check step, no gap). Both handlers now
  return a small discriminated-union transaction result
  (`AppendOutcome`/`ReplaceOutcome`) so a gate rejection, a "segment no
  longer exists" race, and (for replace) the existing missing/ambiguous
  `oldString` rejections are all distinguishable at the call site without
  overloading a single `null` sentinel.
- Writer id: `sessionWriterId(options.callerSessionId)` when known, else
  `null` — a `null` writer skips the gate ENTIRELY (see judgment call below).
- Covers all eight `SEGMENT_EDITABLE_FIELDS` (the six Working State fields
  plus content/insight) — the gate check is generic over `field`, not
  special-cased per field name.

**Judgment calls:**

1. **When `callerSessionId` is unknown, the gate is skipped outright** (no
   check, no stamp) rather than gated against some fallback identity. This
   preserves 100% backward compatibility with the pre-existing
   `remember.test.ts` suite, which overwhelmingly calls `append`/`replace`
   without `callerSessionId` (only the dedicated write-gate describe block I
   added supplies two real session ids). Production always resolves a
   `callerSessionId` through `resolveCallerSessionId`, so this only matters
   for tests and any edge call before that resolution is wired up — mirrors
   `note.ts`'s own established "unknown caller always admits" rule for the
   crossSession guard.
2. The pre-existing `resolution.segment.status === "closed"` check (read
   BEFORE the transaction opens) is a separate, already-existing TOCTOU that
   this ticket does not touch — out of scope (ticket 02 is about the FIELD
   gate, not the closed-segment race, which spec does not ask this ticket to
   fix).

- [x] 并发双会话同段写:后写者被「已失效」拒;重新 recall 后放行 — `bun test tests/mcp/remember.test.ts -t "concurrent dual sessions"`
- [x] 未读实体写被「未读过」拒,报文含 recall 指引 — `bun test tests/mcp/remember.test.ts -t "never-read"`
- [x] 自己写过的字段重写放行;首写放行 — `bun test tests/mcp/remember.test.ts -t "first write on a field admits"` and `-t "same session may keep rewriting"`
- [x] 原子性:门通过与写入之间无并发作废窗口(构造性测试) — `bun test tests/mcp/remember.test.ts -t atomicity`
