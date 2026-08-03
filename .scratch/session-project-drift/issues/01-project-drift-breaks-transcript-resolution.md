# 01 — sessions.project 被最新 cwd 覆盖，导致 transcript 解析失败

**Status:** ready-for-agent
**Rev:** 3 — 二轮评审吸收：可恢复修复台账、稳定平局规则、双注册路径写入

**What to fix:** 会话表的 project 字段在每次 hook upsert 时被最新 cwd 覆盖，而 Claude Code 的 transcript 目录固定在会话起点的 cwd。会话中途 cd 过的会话（实测 3 例中 2 例已解析失败），凡**由 DB 推导 transcript 路径**的读取面（recall、timeline、SessionStart context、worker 端修复路径）都会找不到文件且静默失败。replay CLI 接收显式 JSONL 路径、不受影响——波及面以 DB 推导路径的调用点为准。

**锁定的设计：**
- 新增 `sessions.transcript_path`：以 hook 输入的 transcriptPath 为权威来源，**first-non-NULL 语义**（一经写入不覆盖），且在**两条注册路径**（SessionStart context 注册与 UserPromptSubmit session-init）都执行写入。
- `project` 保留「最新 cwd」语义不变（search / recent-sessions 检索行为不受影响）。
- 所有由 project 推导 transcript 路径的读者（recall、timeline、SessionStart context、worker 修复路径）改为：优先 `transcript_path`，NULL 时回退现有推导（legacy 行为）。
- **一次性修复（可恢复台账＋高水位游标）**：以版本化修复记录（如 `transcript-path-backfill-v1`，含 status、**按 session id 升序的高水位游标**与逐类结果计数）驱动，不与 ALTER 绑定：只处理 id > 高水位的 NULL 行，每批事务内同步推进游标与计数增量——零命中行同样越过高水位（不被永久重选、不重复计数）；崩溃后从高水位续跑，完成标记最后写，完成后不再全表重扫。反查规则：按 content_session_id 在共享解析器声明的 transcript 根目录下找 `<uuid>.jsonl`；唯一命中回填；零命中留 NULL（读者回退推导）并计数；多命中按 **(mtime DESC, 规范化绝对路径 ASC)** 稳定取首，记录全部候选与选中项。结束输出修复摘要（回填/留空/多命中计数）。

**Blocked by:** None — can start immediately.

- [ ] 会话中途 cd 后，recall/timeline/SessionStart context/worker 修复路径仍能解析到 transcript
- [ ] schema 迁移：旧库打开自动加列，NULL 安全；`transcript_path` 在两条注册路径均为 first-non-NULL 写入，后续 upsert 不覆盖
- [ ] 修复台账可恢复（ALTER 与扫描之间、零命中批之后崩溃均从高水位续跑且不重复计数）、零命中行不被永久重选、完成后幂等跳过、摘要可审计；零命中行读者回退推导不抛错
- [ ] 回归测试：fixture 会话两次不同 cwd 的 upsert 后 `transcript_path` 不变、`project` 为最新 cwd；两类读者（新字段命中 / NULL 回退）各一条；多命中平局取 (mtime DESC, path ASC)
