# 03 — 笔记债台账与批次提醒（P1）

**What to build:** 完整的做笔记闭环（spec D2/D3）。turn 完结时（下一 UserPromptSubmit 或 Stop，非创建时——R2#1）机械分类：零实质工具调用（mnemo 自家 remember/recall/timeline 不计）判琐碎、不欠债；带工具 turn 入待写台账（台账住影子侧，R2#2）。PostToolUse 同步入口在**待写列表新增**时返回英文提醒（D2 附原型：全限定号 + 用户原文前缀 + pending N turns，最老 5 条，3–4 条时收回跳过授权），每 turn 至多一次，note 自身调用不再触发；异步摄取入口不受影响，台账写入唯一归 worker 异步侧（R2#P2-6）。回滚 turn 在提醒中出现一次标 "rolled back — no note needed" 后清账。pending 超 50 turn 懒老化为 skipped(aged)。SessionStart 注入静态机制说明块（D2 附英文原型）。曝光台账同步记录（每会话被提醒/注入过的 id 集，供 P2 引用校验）。

**Blocked by:** 02 — note 工具与影子笔记存储。

**Status:** ready-for-agent

- [ ] 纯问答 turn 与仅调 mnemo 工具的 turn 永不出现在提醒中
- [ ] 带工具 turn 完结 → 下一批次首个工具结果后恰出现一次提醒；列表不新增则不重复
- [ ] note 写入清账；跳过不挨重复提醒，直到列表再新增
- [ ] 回滚 turn 标注一次后清账；台账里每笔债都有可见下场（写掉或免除）
- [ ] pending >50 turn 在下次读取台账时转 skipped(aged)，无启动扫描
- [ ] 提醒经同步入口返回、台账写经异步入口，两入口断言不越权
- [ ] 曝光台账记录提醒/注入过的 id
- [ ] writer_model 由 worker 从 transcript 机械回填（票 02 实测：MCP 进程拿不到模型名，message.model 是唯一机械来源；capture 侧解析时回填 shadow_notes.writer_model）
