# 01 — 记忆存储＋commit 工具＋历史快照/restore＋迁移

**What to build:** dream agent 的记忆工作区与其原子提交路径。单一当前画像文档、单一当前经历文档、只增不删的 archive 文档、一个 dated 历史快照目录。一个 commit 工具原子发布本夜的记忆＋archive＋日记：先把 pre-curate 的文档（连同 hash manifest）快照到历史目录，再校验每份记忆文档在 token 上限内，写入 staging，原子 rename 就位，最后落 success marker（记已处理日期）。一个 restore 原语能列出、按 hash 校验、并原子恢复任一快照。迁移读取 persona CURRENT 指针指向的 generation、校验后复制为单一当前文档，退役 generations 布局。

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] commit 原子发布画像＋经历＋archive＋日记；marker 之前崩溃则旧文档完整、当日视为未处理
- [ ] pre-curate 快照发生在写任何新文档之前（快照先于发布）
- [ ] 记忆文档超 token 上限被拒绝并返回可操作错误；未超则接受
- [ ] restore 能列出快照、校验 hash、原子恢复选定的一份
- [ ] 迁移从 CURRENT 指向的 generation 得到单一当前文档；CURRENT 缺失/损坏以空文档起步并告警，不崩溃
- [ ] 默认保留最近 30 份＋每月 1 份滚动，可配
- [ ] 端到端测试在临时目录覆盖上述（含崩溃-恢复、超限拒绝）
