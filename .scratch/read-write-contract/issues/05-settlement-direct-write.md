# 05 — 结算逐笔直写

**What to build:** 结算的 remember/note 每笔即时过门+落库、回执即收;staging 留而不用;失租的旧认领者被新鲜性门自然拒绝。

规范:spec「结算(直写改造)」。

- handler 从 stage* 改直写:每笔在门的同一事务里判定+写+盖章;staging 引擎不再被接线(代码保留,物理删除 out-of-scope)。
- **结算写者身份=claim generation**(01 钉的 `claim:<jobId>:<generation>` 编码):新旧认领者互为「其他写者」——A 失租后 B 重跑,B 写过的字段对 A 失效,无独立 CAS。
- yield 包摄:agent 晚到笔记已为 turn 的 type/tags 盖章(01 的映射)→结算对这些字段的写触发「已失效」,报文即新的 yield 语义;专用 noteSupersedesReview 检查退役。
- 归属纠错**写事务内重验**该段仍挂靠本会话(roster 快照仅提示)。
- propose 幂等键(job+规范化 payload 唯一约束),重试回执「已存在」。
- pre-run 资格快照(eligibleRelationPairKeys)保留原样。
- 结算 context 构建接入 01 的记录接缝(渲染即授权)。

**Blocked by:** 01、02(门与印章)、04(新窗口/prompt 结构)。

**Status:** ready-for-agent

- [ ] 每笔直写落库可查,无 commit 前置
- [ ] 失租场景:B 写后 A 的同字段写被「已失效」拒(写者=claim generation)
- [ ] 晚到笔记场景:type/tags 纠正被门拒,报文指向重读——与旧 yield 行为语义等价的测试改写
- [ ] 归属越权(渲染后 detach 的段)在写时被拒
- [ ] propose 重复窗口重试不产生第二行
