# 12 — persona 算子调度语义补全 + CURRENT 崩溃恢复

**What to build:** 补上 v6 §5.2/§5.2a/§5.3 从未落地的调度与冻结语义（周期 rebase、pending 升级 rebuild、rebase 30 篇输入窗、consumedPendingDates 冻结），修复 generation 落盘后 CURRENT 未发布的崩溃恢复洞，以及 read_diary 预检分支缺入队、stale-bundle 守卫缺新功能 marker 两个 Important。

**Blocked by:** 11。

**Status:** done

- [ ] **B1 幂等 CURRENT 发布**：拆出 `publishPersonaCurrent(generation)`；恢复发现完整 target generation 时先原子写入并重验 CURRENT，再推进 cursor、完成 operation；测试「generation rename 后、CURRENT 写入前崩溃 → 恢复补写 CURRENT 且日记消费不丢」
- [ ] **B2 调度阈值（v6 §5.3）**：operation 创建前集中计算决策——`pending_rebase > 30` 或最老 pending 超 90 天 → 升级全量 rebuild；`folds_since_rebase ≥ 30` → 周期 rebase；边界测试 29/30 folds、30/31 pending、89/90 天
- [ ] **B3 rebase 输入窗（v6 §5.2）**：rebase = 最近 30 个 settled day ∪ 启动时 pending 集，按日期去重排序后冻结；rebuild 才取全部日记；测试长历史下 rebase 输入不含窗外非 pending 日
- [ ] **B4 pending 冻结（v6 §5.2a）**：`consumedPendingDates` 启动时冻结并持久化进 operation/input manifest；续跑、发布、崩溃恢复只用冻结值；测试「batch 1 后新增 pending → 本 operation 不消费不清除，留给下一轮」
- [ ] **I5 read_diary 预检分支入队**：原子 `markDayStaleAndEnqueue()` 供文件校验失败与 day-state 预检失败共用；测试「day 被标脏且当前无 queue row」
- [ ] **I6 stale-bundle 守卫**：release-artifacts 的 worker bundle marker 加入 diary runtime / canonical prompt / persona recovery 的稳定标识，使「改 diary/persona 源码漏 build」可被发现
- [ ] 重建 bundles；全量 `bun test` 0 失败；`bunx tsc --noEmit` 通过
