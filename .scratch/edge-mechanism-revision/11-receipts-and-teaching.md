# 11 — 计量诚实化与教学面修正(终审必改 6 + 建议 1、2、3)

**What to build:** commit 回执不再虚报:create 不算 proposal,新增
segmentsCreated / proseWritten / relationsWritten / relationsRestated /
relationsRetracted 计量;提示词不再过度承诺逐字段落地;死的 staging 路径删除;
门字段镜像有机械防漂移;ADR 的撤边审计措辞改真。

**Ruling base:** peer 终审必改 6、建议 1–3。

**Blocked by:** 07、08(同文件先后)。

**Status:** blocked

## Pinned decisions

- 计量:`note-settlement-direct-write.ts` 的 counts 拆开——create 独立计量
  (`proposeAlreadyExisted` 为 undefined 时不得落 proposal 桶);prose 写、
  关系写(新增/幂等分开)、撤边各有其数。三处 `toEqual` 夹具随语义更新。
- 提示词(note-settlement-prompt.ts):「各字段独立落地」限定为 type/tags 的
  field-yield;prose 门拒与关系结构错仍拒整调用、事务整回滚——保留更安全的
  原子性,改的是教学。
- staging:`note-settlement-staging.ts` 已无调用方且 dry-run 语义已弱化
  (apply:false 虚报),**整体删除**,连同 apply:false 分支与其测试;
  evaluate 函数保留 apply:true 单一形态。
- 门字段:`EDGE_WRITE_GATE_FIELD` 提为共享导出(mcp/note.ts 导出、facade 引
  用),或加源码级 parity 测试——二选一,倾向共享常量。
- ADR-0009 撤边审计句改真:硬删无墓碑,live 库回答不了「本 run 撤了什么」,
  审计走外部 dump/快照。

## Acceptance criteria

- [ ] create+auto-attach 的回执报 `1 segment created`,proposal 计 0;各新计量
      有正例。
- [ ] 提示词测试断言新教学措辞、无「每字段独立」的旧句。
- [ ] staging 文件与 apply:false 分支不复存在,全套绿。
- [ ] 门字段共享常量或 parity 测试落地,故意改一侧会红。
- [ ] ADR-0009 审计句与实现一致。
- [ ] typecheck 干净;全套绿,只余既定的陈旧包守卫红。

## Ground rules

- NO git write commands。报出改动文件清单,主会话提交。
- 工作面:`src/worker/note-settlement-{direct-write,prompt,staging,turn-facade}.ts`、
  `src/mcp/note.ts`(仅常量导出)、`docs/adr/0009…md` 及对应测试。开工前先
  rebase 理解 07/08 落地后的现状。
- 不碰 `~/.claude-mnemo/`、`plugin/scripts/`、版本号;不重建 bundle。
