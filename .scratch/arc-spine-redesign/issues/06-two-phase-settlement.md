# 06 — 两阶段结算

**Status: done** — 见 feat(settlement) 提交（含 codex 审查轮 1 blocker＋5 major＋4 minor 修复；门禁 1411/0）。审查轮裁决已入 spec §A：认领代数栅栏（done/fail CAS、stale 结果回滚弃置）、attempts 认领时消耗、终态=弃置放行（游标跨终态 failed 推进）、关停中止保持 claimed、反链=rolled-back 标记非机械降级、fenced JSON 容忍。实施要点：严格批量走 text-parse（SDK zod-strict 做不到整批拒收）；`<window-roster>` 以 `turnId=` 作 DB id↔prompt 号映射，机械信号同口径标注；引用快照每 job 读一次、经 `buildTimelineView` 第 4 参喂给弧渲染（信号与弧同快照；偏离「每 session 一次」是有意的——pass 内跨 job 间隔以分钟计，pass 级快照反而陈旧）；SessionEnd 收尾门在孤儿转 skipped **之后**入队（活动快照时机不变）；settle 推送 `withEnvelopes:false` 防 envelope 被 JSON-only 交换烧掉；`hadIllegalTool` 改 MNEMO_ALLOWED_TOOLS 成员测试。**陷阱**：`bun run typecheck` 不覆盖 tests/（tsconfig exclude），签名改动只在 bun test 现形；`claim_generation` 迁移是承重的（未提交期间 worker.cjs 已建过无此列的表）；收尾门 `terminalCount<=cursor` 跳过与弃置放行叠加 = 末窗口终态失败的会话不再补收尾 job（有意）。已知残留：failed 批量的 change_summary 无 old→new（无写入即无变更）。 等级从暂定走向结算的全链路：`settlement_jobs` 状态机（`UNIQUE(session,boundary)`、入队时持久化冻结成员、每 session 升序单认领＋CAS 租约、10 分钟租约回收、failed 且 attempts<3 回收、attempts=3 终态、游标只在成功事务推进且单调）；跨界枚举全部边界（49→151 → 50/100/150）；SessionEnd 收尾门（修复前活动快照 × terminal 数 > 最近成功边界）；独立 worker 消息类（契约授权窗口内改写；提取 agent 工具面加 timeline 与 recall）；输入 = 冻结窗口弧视图＋机械信号三件套（入度、supersession 事件、零入度暂定 G3 名单）；严格批量校验（恰两键、唯一整数 turnId ∈ 冻结窗口、grade 0-4 整数、空批与部分覆盖合法、其余整批拒收）；机械确认（入度≥1 任意等级引用方）/降级过模型；规则豁免经 `S<session>/T<prompt>` 多证据解析（proposed 的 evidence refs ∪ judgment 经 source_event_id 追溯）；成功事务同写等级、supersedes 派生反链、old→new 变更摘要与游标。完成后 mock 模型下从跨界入队到落库的全链路可演示，崩溃与乱序用例全过。

**Blocked by:** 01 — cites 基础设施；02 — effGrade 选择；03 — 统一行渲染器。

**Status:** ready-for-agent

- [ ] 状态机全语义有测试：冻结成员（延迟终态不改 cohort）、升序单认领、crash-after-claim 租约回收、乱序完成、游标单调且只随连续完成推进
- [ ] 批量校验拒收矩阵（未知/越窗/重复 id、越界 grade、多余键、缺字段）＋空批/部分覆盖语义
- [ ] 机械确认与降级候选组装（含零入度名单注入）；降级候选可 recall 下钻
- [ ] 规则豁免：多证据 proposal 与 judgment-via-source_event_id 两类用例
- [ ] change_summary 每条 old→new 可审计；diary 不因结算失效（显式断言）
- [ ] 全量套件绿＋rebuild

详见 spec §A 与 §B（豁免）。
