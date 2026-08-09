# 07 — 结算调用本体：语境装配与原子写回（P2）

**What to build:** Sonnet 无状态结算调用的全部内容（spec D9）。语境装配走生产接口：窗口 turn（笔记 + 琐碎 turn 的截断原文）、前 50 turn 的 recall collapsed 渲染、开放段列表、活跃主题注册表、里程碑/current session 注入构建器；不足时结算自行 recall 下钻。职责：段依附判定（同主题同段续/静默久新段/无主题先搜后铸，铸新必须陈述无候选理由）、段身体撰写（结论先行、S/T 格式引证成员→解析为 anchor）、边分类补充（四候选来源定关系类型）、type/tag 复核多值化（含回退）、session summary 维护（沿用现有预算合同）、洞的补写——**中间洞必补**：认领清账的 pending 中其后仍有 noted turn 者，随窗注入截断原文（prompt+response，~1000 token/turn），产出重建笔记并带结算侧 provenance；尾部洞与活会话 aged 洞停留为主（确需时凭 replay）。写回：结构化输出 schema，按 session 分区的副作用与游标在单一成功事务提交、带 job generation 校验；开放段重写走 06 的 revision CAS，冲突段以补充小事务重放。密度纪律与主题铸造率计数入监控。

**Blocked by:** 05 — 结算作业基建；06 — 段/主题/边 schema 与机械层。

**Status:** ready-for-agent

- [ ] fixture 窗口端到端：段/成员边/引用边/type/tag/session summary 一次事务落库
- [ ] generation 过期的写回被整体丢弃（迟到作业测试）
- [ ] 段 CAS 冲突触发补充重放，不回滚已提交分区写
- [ ] anchor 从段身体的 S/T 引用解析而得，非法引用不入
- [ ] 中间洞（后有 noted turn 的 skipped(closed)）获原文注入并产出带 provenance 的重建笔记；尾部洞不注入不补写
- [ ] S1730 离线回放抽查：段粒度与日记行粒度相当（人工 spot-check 记录在案）
- [ ] 每窗新主题铸造数落监控计数
