# 06 — dream 写路径：propose_rule / submit_judgment

**What to build:** dream agent 的规则写入面。`propose_rule` 内置判重：claim 对全库（含墓碑）trigram 相似度检索，超阈值拒绝并返回候选——命中墓碑附当初驳回理由，命中活跃规则提示改走佐证追加；坚持新建须携带 `distinct_from` 显式表态并入事件账本。`submit_judgment` 以 `source_event_id` 指向被评审 hit，label 开放词汇、rationale 必填、adjustment 结构化载荷（含替换/优化的前后值）。所有写操作以内容决定性生成 `event_uid` 幂等键——重试不产生重复 evidence/judgment；规则写入独立即时提交，不与日记文件事务原子一致。两工具注册进 dream agent 工具面与允许列表。

**Blocked by:** 02

**Status:** ready-for-agent

- [ ] 判重三路径（墓碑拒绝带理由 / 活跃转佐证 / distinct_from 强制表态入账）各有测试
- [ ] 同参数重复调用（模拟 dream 重试）产生的 DB 状态与单次调用一致
- [ ] adjustment 触发的 status 变更在账本记录前值与后值
- [ ] 工具注册后 dream agent 会话可见可调（沿用既有工具注册测试先例）

## Comments
