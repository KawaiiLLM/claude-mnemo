# 04 — SessionEnd 60 秒收尾 + 立即关闭记忆 agent

**Parent:** ../spec.md

**What to build:** session 正常退出后，其剩余 turn 在 60 秒预算内完成提取，随后该 session 的记忆 agent 立即关闭（不再等 30 分钟 idle）；预算超时或遇连接类错误则直接中断——杀掉 query 子进程、释放 claims、turn 回到未提取状态，不重试，等下次使用时顺带处理。实测单批提取中位 6–7 秒、p90 约 20 秒，预算通常容纳尾部 1–2 批。

**Blocked by:** 01 — 错误分类器 + flush 网络挂起；03 — 消费触发权收敛到 turn-stop。

**Status:** implemented

- [x] SessionEnd 收尾有 wall-clock 预算，入 config，默认 60 秒
- [x] 预算内完成：该 session 的 query session 立即关闭，资源不残留到 idle 定时器
- [x] 预算超时或 `connection` 类错误：中断在途推理（杀 query 子进程）、释放该 session 全部 claims、关闭 agent、不重试、不产生 dropped tag
- [x] 被中断的 turn 回到未提取状态，下次全局排空可完整重新处理；批内已部分落地的 remember 重投递安全（既有 skipped-obs / edit-on-top 机制覆盖）
- [x] 多 session 并存：一个 session 的收尾只关闭它自己的记忆 agent，其余 session 不受影响

## Comments

- `MnemoConfig` 新增 `sessionEndTailTimeoutMs`，默认 `60_000`；文件配置允许覆盖并钳制到 1–300 秒。`POST /flush`、worker-down 后携带 `CLAUDE_MNEMO_FLUSH_SESSION_ID` 的启动收尾都接入新的 `finishSession`，普通 `flushSession` 保留为不关闭 agent 的低层接口。
- `finishSession` 从调用开始同时启动 wall-clock timer，在预算内执行该 session 的 `drainSessionCompletely`（排空 durable queue + flush 全部内存 batch）；成功后立即 `closeSessionQuery`。HTTP wiring 回归断言 turn 送达后 query session 已关闭。
- 超时使用票 01 已有的 `shutdown` abort 标记，复用 connection 挂起路径：重置该 session 全部 claims、清空 buffer/batch/streamedParts、设置 10 秒 per-session 退避，并以标记错误关闭 query。真实 query-session 回归确认 AbortController 中断后对子进程发送 `SIGKILL`。
- connection 类推送错误同样只尝试一次即进入挂起；关闭时向 query session 透传原 connection error，既不递增 batch attempts，也不生成 `delivery_dropped` tag。session-filtered drain 增加循环内挂起检查，避免本次 SessionEnd 在释放 claim 后立刻重新认领自身、绕过退避。
- 超时回归断言 in-flight turn 仍为 `active`、claim 已释放、无 dropped tag；推进 10 秒退避后，下一次全局 wake 会重新认领并完整送达。批内部分 remember 的 restart-safe 行为继续由既有 skipped-obs / prior-turn edit-on-top 路径承担，相关 streaming 与 flush-retry 回归均通过。
- 多 session 回归先建立另一 session 的活跃 agent，再完成目标 session 收尾；只关闭目标 agent，另一 session state 保持活跃。
- 验证：worker 生命周期定向测试 99 pass / 0 fail；hooks/config 定向测试 40 pass / 0 fail；`bunx tsc --noEmit` 通过。全量 `bun test` 908 pass / 1 fail，相对接受基线 903 pass / 1 fail 无回退；唯一失败仍为 `tests/shared/release-artifacts.test.ts` stale-bundle guard。未重建或触碰 release 产物，无规格偏差。
