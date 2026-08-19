# 06 — commit 重定位 + Stop hook 探针 + 重试状态机

**What to build:** commit=claim 检查+计数回执+终态标记;Stop hook 以「已认领未终态」为探针并记账;作业失败按类别区分、事件驱动重试、弃窗留欠账。

规范:spec「commit 重定位」「Stop hook 重实现」「重试」「作业状态机相应扩展」。

- commit:claim 有效性+本 run 写入计数+终态标记;不判职责覆盖;空手窗口干净完成。
- Stop hook:探针=job 已认领未终态(staged 计数语义作废);持 jobId/claim generation;agent 未调 commit 即停 → 确定性失败记账;「commit 是唯一 writer」旧文案改写;拦截上限行为保留。
- 状态机:失败类别列(暂时性=网络/连接/SQLITE_BUSY——不计 attempts、不 backoff、留队列等下个 turn-stop 事件;确定性——计 attempts,上限 1);废除「claim 即 attempts+1、失败一律 backoff、上限 3」;新增 abandoned 终态+欠账记录(窗口区间+原因,供手动 /settle);既有 failed 行按确定性语义迁移。

**Blocked by:** 05(直写落地后 commit/hook 语义才成立)。

**Status:** ready-for-agent

- [ ] commit 三件事各一测;空手窗口完成
- [ ] 未调 commit 即停:hook 记账、消耗那次重试
- [ ] 网络失败不计 attempts、无 backoff、下个事件重试;确定性 1+1 后 abandoned+欠账行
- [ ] 旧 failed 行迁移语义测试
