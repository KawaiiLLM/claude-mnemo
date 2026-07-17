# 05 — 全 agent 关闭即停 worker + dream 中断护栏

**Parent:** ../spec.md

**What to build:** 最后一个记忆 agent 关闭后 worker 立即退出，建立不变量「CC 关闭约 1 分钟后零残留 Claude 请求」。退出判定四守卫：无存活 query session、无全局排空在途、无 HTTP 请求在途、dream 未在跑或已按护栏中断。dream 若在跑则中断且不计尝试次数——「恰好在补跑时关 CC」不得累积成 terminal。30 分钟空闲定时器保留为崩溃路径兜底；新 turn 入队时既有懒启动自动拉起。

**Blocked by:** 02 — diary/dream 尝试计数接入分类器；04 — SessionEnd 60 秒收尾 + 立即关闭记忆 agent。

**Status:** ready-for-agent

- [ ] 退出判定同时满足四守卫才触发既有优雅退出（pid 文件清理等语义不变）；「无全局排空在途」为硬守卫（/flush 是 fire-and-forget，HTTP 计数早已归零）
- [ ] dream 在跑时被中断：attempt_count 不变、next_attempt_epoch 重置为立即可做、staging 半成品无任何提交残留（staged-commit 原子性）
- [ ] 被中断的 dream 在下一次 turn-stop 排空的 reconcile / 继续调度中自动补跑
- [ ] 30 分钟空闲兜底保留：SessionEnd 未触发（崩溃、强杀）时 worker 仍会退出
- [ ] 端到端形态：最后一个 session 正常结束 → 约 1 分钟内 worker 进程退出；随后新 turn 入队 → worker 与对应记忆 agent 按需拉起并正常提取
