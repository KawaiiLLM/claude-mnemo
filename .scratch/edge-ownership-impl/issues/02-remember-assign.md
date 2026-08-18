# 02 — remember 复活 `assign` 动词

**What to build:** 主 agent 一次调用把一个区间/列表的 turn 派进段,或置无归属;单归属搬家语义。

规范:`.scratch/ownership-and-note-cadence/spec.md`「所有权」节 assign 条目([S15069/T926])。

- 动词 `assign`:`id="E<n>"` 或省略(省略 = 置无归属,从现归属移除,turn 变 homeless);turn 集合收 `S<n>/T<a>..T<b>` 区间或地址列表。
- **单归属**:写路径强制——派入前先从现段移除,同一事务;**不加追溯性 schema 约束**(遗留段可能共享 turn,冻结不动)。
- 移除/搬家落 DB 原语(现行唯一原语只增不减,peer 发现 3);`create` 的 `members` 种子与 `assign` 同一条写入路径;派生 facets 随成员增删重算。
- 区间跨不存在的 turn:整个调用拒绝并报出缺哪个,零部分写入。

**Blocked by:** None — can start immediately.

**Status:** done

- [x] 区间派入/列表派入/置无归属三形态各有测试
- [x] 已属 E_a 的 turn 派入 E_b 后,E_a 不再计入其 facets(mutation fixture,peer 发现 3 点名的缺口)
- [x] `create`+`members` 与 `assign` 走同一写入路径的断言
- [x] 不存在的 turn 使整个调用拒绝,零部分写入

## Implementation record

`db/segments.ts`: new primitive `reassignSegmentMembers(db, turnIds,
targetSegmentId, nowEpoch)` — the ONE write path for "these turns belong
here now" (or nowhere, `targetSegmentId: null`). Deletes every named turn's
`segment_members` row (wherever it currently lives) then, if a target is
given, re-inserts via the existing `addSegmentMembers` — one transaction (the
caller's `runWriteTransaction`), so a turn is never observably a member of
two segments between the halves. Recomputes facets for every VACATED segment
(the target's own recompute already happens inside `addSegmentMembers`). No
retroactive schema constraint, per spec — a legacy multi-segment turn is
untouched until something reassigns it.

`mcp/remember.ts`: new `assign` verb (sixth, `REMEMBER_VERBS`/`RememberVerb`
widened). `handleAssign` resolves an OPTIONAL `id` (segment target, or
omitted = clear ownership) and a REQUIRED `turns` array — each token is
either an interval (`S<session>/T<a>..T<b>`, own regex, every prompt number
in range must resolve via a bare `SELECT id` lookup — not `db/turns.ts`'s
fuller `getTurn`, which this module has no other reason to depend on) or an
individual address (reusing `parseBareAddressReference`/`validateReferences`,
same as `create`'s existing `members` path). All tokens are resolved and
validated BEFORE any write — one rejection anywhere fails the whole call,
zero partial writes. `handleCreate`'s `members` seeding was switched from
`addSegmentMembers` to this SAME `reassignSegmentMembers` — the identical
single-ownership rule now applies to `create`, not a second looser path.

`mcp/definitions.ts`: `rememberInputShape.verb` gained `"assign"`; new
`turns` field; `id`'s own describe documents assign's optional use. Tool
description gained assign's own clause. `remember`'s token cap raised 380→400
(measured: the untouched five-verb text already sat at 376 — a sixth verb's
real clause needs headroom a mechanical trim of EXISTING pinned prose cannot
supply without deleting a different acceptance criterion).

Tests (`tests/mcp/remember.test.ts`, new `describe("assign (ticket 02)")`):
interval form, list form, unassign/homeless, the mutation fixture (moved
turn's facets), the create+assign shared-write-path assertion (BEHAVIORAL —
a turn already owned by E_a ends up in E_b ALONE after `create(members:
[...])`, which only holds if both verbs share the single-ownership write
path), interval-with-gap zero-partial-write, unresolved-address-in-list
zero-partial-write.

Mutation demo (restored after verifying red): the `DELETE FROM
segment_members` step inside `reassignSegmentMembers` commented out → 3 of
the 8 new `assign` tests go red (the mutation fixture, the shared-write-path
test, and the unassign/homeless test) — confirms single ownership is
actually enforced by the write, not merely asserted by a test that happens
to pass anyway.
