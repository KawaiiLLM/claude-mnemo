# 01 — 边表多关系形态与撤边原语

**What to build:** 同对 turn 能存多条关系;错边能按 (pair, relation) 硬删;自引
在表层面就不可能;迁移把现有五列 PK 表无损重建成新形态。

**Ruling base:** spec D2、D3;[S15069/T1109](多关系)、[S15069/T1111](自引
禁)、[S15069/T1124](硬删、双写者同权)。

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

## Pinned decisions

- 存储形态:bare pair(relation NULL)至多一行,用 partial unique index 保证;
  每 (citing_kind, citing_id, cited_kind, cited_id, relation) 一行,五列唯一。
  自引 CHECK(citing_kind = cited_kind AND citing_id = cited_id 拒绝)入表。
- 旧 upsert 的「relation 非空即覆盖」语义废除:关系写入是**增行**;bare 写入在
  已有任何行时是 no-op(pair 已存在即不重复记)。
- 撤边原语:按 (pair, relation) 硬删,relation NULL 形态可删 bare 行。不建墓碑。
- 迁移:重建表,搬运现有全部行(现库无自引、无同对多关系,搬运无冲突);外键
  校验在事务内(沿用 0.11.0 迁移先例)。
- provenance 列与 CHECK 值域不动;级联清理触发器(session/turn 删除)语义保持,
  测试不改而绿。

## Acceptance criteria

- [ ] 同对写入两条不同 relation → 两行并存,各自可读。
- [ ] 同对同 relation 重复写入 → 幂等,不增行。
- [ ] bare pair 重复写入 → 至多一行。
- [ ] 自引写入被拒,报文说明;迁移后表层 CHECK 也拒。
- [ ] 撤边删除指定 (pair, relation) 行,不波及同对其他关系;撤 bare 行同理。
- [ ] 迁移在含现库全量形态的夹具上无损:行数、字段、provenance 逐一保持。
- [ ] 既有级联触发器测试不改而绿。
- [ ] typecheck 干净;全套绿,只余既定的陈旧包守卫红。

## Ground rules

- NO git write commands。报出改动文件清单,主会话提交。
- 不碰 `~/.claude-mnemo/`、`plugin/scripts/`、版本号、`src/worker/`。
- 不自行重建 bundle。变异候选:自引 CHECK、partial unique index。
