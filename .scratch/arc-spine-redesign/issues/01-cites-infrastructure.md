# 01 — cites 引用基础设施

**What to build:** 提取写入的结构化引用成为可查询的机器事实：remember 携带 `cites`（严格 `{id, relation}` 元素、replace-set 流式语义）落入带级联外键的 `turn_citations` 边表并置 `cites_recorded` 标志；legacy turn 经字面文法（单引用/逗号列表/闭区间范围/带注解）解析行内引用作为回退。完成后可对任意 fixture 会话查询任意 turn 的入度与关系集，legacy/新纪元的回退谓词行为可断言。

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] remember 的 cites 输入按 replace-set 语义落边表；turn 更新＋边集替换＋嵌套 regrade 同一事务
- [ ] `cites_recorded` 谓词：未置回退行内解析、已置空即确无；不用创建时间判定
- [ ] 两端 FK ON DELETE CASCADE；跨 session 边可写但被确认入度/受害降级/↳ 渲染三个会话内算法排除
- [ ] 字面文法正反 fixture 全过（每例断言期望展开的 DB-id 数组；范围上限 8 超限取两端；畸形整体忽略；跨形式去重）
- [ ] 无效/未来 id 丢弃并记日志；重复边去重
- [ ] 旧库打开自动迁移（无边表、无标志列时 NULL 安全），全量套件绿＋rebuild

详见 spec §B（.scratch/arc-spine-redesign/spec.md，Rev 4）。
