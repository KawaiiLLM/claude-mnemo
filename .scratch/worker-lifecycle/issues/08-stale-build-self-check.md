# 08 — worker 认领自主工作前自检构建陈旧

**Parent:** ../spec.md

**What to build:** worker 在认领任何自主工作（结算 job、dream、全局排空）之前，先确认自己就是最后一次迁移这个数据库的那个构建；不是则一件都不认领，走票 05 既有的优雅退出。退出即自愈——懒启动会把 hook 当前解析到的那个版本拉起来。

**Blocked by:** None — can start immediately（票 05 的优雅退出与四守卫已实现）。

**Status:** ready-for-agent

## 事故（2026-08-17，本票的来源）

`/plugin` 更新到 0.11.1 后：hook 与 MCP server 是短命进程，下一次调用就换成新包并**立刻跑完五次迁移**；而 23:23 起的常驻 worker 仍是 `0.10.0-msqdbiq3`。03:47–03:49 之间，这个陈旧 worker 按自己的定时排空派发了两个结算 job，双双失败：

```
last_error: ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint
0.10.0: ON CONFLICT (citing_kind, citing_id, cited_kind, cited_id, relation)
迁移后:  PRIMARY KEY (citing_kind, citing_id, cited_kind, cited_id)
```

票 07 把 `memory_edges` 的身份从「对 + 关系」收成「对」，旧码的五列 upsert 于是无处落地。

**守卫存在但没轮到开火。** `readWorkerHealth` 确实比对 BUILD_ID 并把陈旧 worker kill 掉重生，且接在四个活的 handler 上。但它只在 **hook 主动找 worker 说话**时被触达；那个窗口里没有任何 Stop / compact 触发，worker 在 03:49 先自己空闲退场了。**hook 侧的守卫管不住 worker 自己的节拍。**

这次是结构性变更所以吵（抛异常、留 `last_error`、自动重试）。只加列的发布会静默通过；改语义不改结构的发布，会在同一窗口里写脏数据而不是报错。

- [ ] 数据库持久记录「最后完成迁移的 BUILD_ID」，由 `initializeDatabase` 在迁移所在事务内写入——记录与迁移同生共死，不存在「迁移成功但没记上」的中间态
- [ ] worker 在 claim 之前比对该记录与自身 BUILD_ID；不一致则不 claim、不烧 attempt、不占 lease，转入票 05 的优雅退出
- [ ] 已 claim 的在途工作不被此检查中断：只挡新的认领，不撕正在跑的 agent
- [ ] 变红检查：令 DB 记录的 BUILD_ID 与 worker 自身不一致，断言零 claim 且进程退出；把比对改成恒真后该测试必须转绿（证明是守卫而非别的东西让它退出）
- [ ] hook 侧 `ensureCompatibleWorker` 与 `spawnWorkerProcess` 语义不变，不重复实现第二套版本判定

## Comments

- **为什么不去磁盘上找有没有新包。** `/plugin` 把新版本装进**新目录**（`…/claude-mnemo/0.11.1/`），运行中 worker 的 `CLAUDE_PLUGIN_ROOT` 和它自己的 `worker.cjs` 都钉在旧目录上——路径不变、mtime 不变。从 worker 自己这一侧，0.11.1 是不可见的。任何基于「看自己的文件变没变」的检查都恒为假。
- **数据库才是双方共享的权威。** 值得检查的不变量不是「磁盘上有没有更新的包」，而是「这个库最后是被谁迁移的」——后者恰好就是危险本身，前者只是它的一个不可靠代理。这也让检查对未来的分发方式免疫。
- **为什么挡在 claim 之前而不是 dispatch 失败后。** claim 会烧掉一次 attempt 并占住 lease。本次事故中 40/41 各被烧掉一次（`attempts` 1→2 才成功），上限是 3；一个陈旧 worker 只要多转两圈就能把整窗口推进 terminal。
- **驳回的窄解法：让 hook 每次事件都探一次 worker。** 每事件多一次 HTTP 往返，而且覆盖面没变——它仍然只在 hook 发生的时刻生效，挡不住两次 hook 之间的自主排空，也就是本次事故发生的那段。
