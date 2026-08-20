# 08 — 直写逐笔验租(终审必改 5)

**What to build:** 结算的每一次直写(turn 写、membership 的 create/reassign/
propose)都在**同一事务内**先验 job 认领与 claim generation;失效的 claimant 在
第一笔写就被拒,而不是等到 commit。

**Ruling base:** peer 终审必改 5;job lease 的本义。

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

## Pinned decisions

- 病灶:`note-settlement-direct-write.ts` 约 54–59 行自述逐写租约栅栏缺席;
  `writeMembership`(约 208–230)只包事务不验租;`membership-facade.ts` 约
  454–459 直接 create+attach。被 reclaim 的旧 claimant 可先造一个空段挂到
  session,commit 才被拒——段已存在。
- 修法:验租(job 存在、claim_generation 匹配)进入每次直写的事务前置;沿用
  commit 已有的判定逻辑,不发明第二套。
- **自动挂靠本身是对的**(否则下窗看不见新段),不动;修的只是租约前置。
- commit 的终检保留不变——逐写验租是**加**的一道,不替代终检。

## Acceptance criteria

- [ ] reclaim 后,旧 claimant 的 create / reassign / propose / turn 直写全部被
      拒,报文指名租约原因;各一个回归例。
- [ ] 有效 claimant 的全部直写行为不变,既有测试不改而绿。
- [ ] 验租与写入同事务(测试用注入事务竞争验证,沿用既有 runWriteTransaction
      注入口)。
- [ ] typecheck 干净;全套绿,只余既定的陈旧包守卫红。

## Ground rules

- NO git write commands。报出改动文件清单,主会话提交。
- 只碰 `src/worker/note-settlement-direct-write.ts`、
  `src/worker/note-settlement-membership-facade.ts` 及其对应测试;
  turn-facade、note-settlement.ts、schema.ts 等有并行 worker,全部只读。
  若验租谓词必须落在共享文件,回来报告,不要动。
- 不碰 `~/.claude-mnemo/`、`plugin/scripts/`、版本号;不重建 bundle。
