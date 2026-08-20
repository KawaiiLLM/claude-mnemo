# 01 — SessionStart 的段块在只读连接上重新渲染出内容

**What to build:** 恢复/压缩会话的注入里,`[E<n>] · fields` 与
`[E<n>] · milestones` 两块重新出现并带真实内容——不再是一行
`timeline error: attempt to write a readonly database`,也不再无声消失。

线上 0.12.1 现状:段块槽各自是独立 hook 进程、开只读连接(为避开并行进程抢写
锁),却传了写者身份,于是渲染末尾的授权 INSERT 抛错。`milestones` 被渲染器兜
住吐一行错,`fields` 抛穿后被 handler 的宽 catch 吞成「没有这一块」。每个
resume/compact 会话都在丢两块注入。

**Ruling base:** spec D9([S15069/T1052] 保留授权表;授权基准 = 实际渲染出内
容,不做扩张)。

**Blocked by:** none — 与词汇工程完全无依赖,可单独落地、单独发版。

**Status:** ready-for-agent

## Pinned decisions

- 段块槽**不传写者身份**。花名册不动:它骑在唯一那条可写连接上(bare
  `context` 命令),继续按「实际渲染出的页项」记录授权。
- **不扩张授权基准。** 初稿曾提议扩到「全体挂靠段」,已作废——花名册的溢出行
  明写 `(attached, not rendered here)`,没有渲染出内容就不该拿到授权。
- 三处授权缺口(掉出花名册当前页的挂靠段、closed 的挂靠段、候选上限 500 之外
  的段)**记录在案,本票不修**。出路是显式 `recall(id="E<n>")`,报文的
  never-granted 分支本就指向它。
- 段块 handler 的宽 catch **不动**。本票修的是抛错的成因,不是吞异常的行为。

## Acceptance criteria

- [ ] 用**只读的、文件落盘**的数据库句柄渲染两块:块头出现、内容不是错误行、
      `write_gate_reads` 无新增行。现有 hook 测试用可写的内存库、且多数不传
      readerId,复现不了事故——新测试必须两个条件都满足,否则不算数。
- [ ] 花名册行为逐字节不变(既有测试不改而绿),其授权仍只覆盖实际渲染出的页
      项。
- [ ] typecheck 干净;全套绿,只余既定的陈旧包守卫红。

## Ground rules

- NO git write commands(commit/stash/checkout/restore)。报出改动文件清单,主
  会话提交。
- 不碰 `~/.claude-mnemo/`、`plugin/scripts/`、版本号、`src/worker/`。
- 自己文件之外的瞬时红:窄范围重跑那一个文件,绝不回滚工作树。
