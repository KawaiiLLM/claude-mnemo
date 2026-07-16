# 03 — 增量提交（staging + 受限 Write/Edit + payload-free commit）

**What to build:** dream agent 不再把五份文档作为 `commit` 参数整体重发，而是把文档写进一个本次运行的 staging 工作区——用 Edit 增量修改 profile/experience/archive、用 Write 落当天日记，只把真正变化的内容变成 token。`commit` 退化为不带文档参数的「校验并原子发布 staging」信号。原子性、快照历史、5k-token/文档校验、成功标记「最后落」的既有契约全部复用，不削弱任何保证。目标：削减每晚 output（按讨论约 1/4~1/3），并清掉「全量重发」这一偶然复杂度。

**Blocked by:** 无 — 可立即开始。

**Status:** done — Opus subagent 实现（staging=`<dataRoot>/.dream-staging/<date>/`、Write/Edit 经 writable 分级 + realpath 限死子树、commit payload-free 从 staging 读回调 UNCHANGED commitNight、prompt 重写 + full-fill 带沟通风格）。codex 跨审判两 blocker 两 important：已修 Blocker1（staging 封闭 dataRoot 内防符号链接逃逸破坏性删除）+ Important3（三份记忆文档失效关，缺失即 throw 拒发布空文档）；Blocker2（同日并发）串行排空生产不可达、仅记不变量；Important4（TOCTOU）+ nit 接受。895 pass / 1 fail（仅 stale-bundle guard，待本票）；tsc 干净；commitNight 与 HEAD 逐字节相同。

- [ ] worker 在调起 agent 前，把当前有效记忆的文档（profile/experience/archive/migration-state/当天日记/INDEX）播种进一个本次运行的 staging 工作区。
- [ ] agent 获得受限的 Write/Edit 内置工具，可写路径经 `canUseTool` 限死在该 staging 工作区子树内（与现有 read_doc 的作用域机制同源）；staging 子树之外的写路径一律拒绝。
- [ ] `commit` 工具去掉六个文档参数，退化为「本次 staging 已就绪」信号；发布逻辑改为从 staging 工作区读取文档内容，替换原先从工具参数读取；INDEX 的 recent-first 归一仍在发布侧兜底。
- [ ] 复用现有原子发布事务：snapshot（`memory/history/` 带日期快照）→ 校验（5k-token/文档）→ staging 事务 → 原子发布 → 成功标记最后落；单次提交守卫保留。不引入 symlink、不重构 memory 目录布局。
- [ ] curate 提示词从「输出五份全文调用 commit」改为「用 Edit 增量改 staging、用 Write 落日记、改完调用无参数 commit」。
- [ ] 现有 commitNight 的故障注入测试（after-snapshot / after-staging / after-publish / before-success-marker）在「文档来源换成 staging」后仍验证原子性与回滚不变。
- [ ] 新增测试：canUseTool 拒绝 staging 子树之外的写路径；payload-free commit 触发一次完整发布且单次提交守卫仍生效。
- [ ] 全量 `bun test` 与 `tsc` 干净。
