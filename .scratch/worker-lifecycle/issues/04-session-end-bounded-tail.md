# 04 — SessionEnd 60 秒收尾 + 立即关闭记忆 agent

**Parent:** ../spec.md

**What to build:** session 正常退出后，其剩余 turn 在 60 秒预算内完成提取，随后该 session 的记忆 agent 立即关闭（不再等 30 分钟 idle）；预算超时或遇连接类错误则直接中断——杀掉 query 子进程、释放 claims、turn 回到未提取状态，不重试，等下次使用时顺带处理。实测单批提取中位 6–7 秒、p90 约 20 秒，预算通常容纳尾部 1–2 批。

**Blocked by:** 01 — 错误分类器 + flush 网络挂起；03 — 消费触发权收敛到 turn-stop。

**Status:** ready-for-agent

- [ ] SessionEnd 收尾有 wall-clock 预算，入 config，默认 60 秒
- [ ] 预算内完成：该 session 的 query session 立即关闭，资源不残留到 idle 定时器
- [ ] 预算超时或 `connection` 类错误：中断在途推理（杀 query 子进程）、释放该 session 全部 claims、关闭 agent、不重试、不产生 dropped tag
- [ ] 被中断的 turn 回到未提取状态，下次全局排空可完整重新处理；批内已部分落地的 remember 重投递安全（既有 skipped-obs / edit-on-top 机制覆盖）
- [ ] 多 session 并存：一个 session 的收尾只关闭它自己的记忆 agent，其余 session 不受影响
