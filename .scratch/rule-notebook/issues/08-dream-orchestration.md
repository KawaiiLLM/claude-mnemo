# 08 — dream 夜间编排：归纳与评审 prompt + experience 停产

**What to build:** 完整夜间闭环的编排层。dream agent 的 prompt 新增两段职责：(1) 归纳——分析当天轨迹，经 `propose_rule` 提出经验假设（判重由工具强制，prompt 只负责判断质量）；(2) 评审——经 `list_rule_hits` 取当天命中，`read_turn_detail` 下钻，按「遵从≠有用，只认正面作用」原则经 `submit_judgment` 给出开放标签 + 理由 + 计数，附带调整动作。commit 时重渲染编译触发索引。同时停产 experience 文档（该文档从未被注入，属顺手维护的死产出——从夜间产出清单与 commit 流程中移除）。

**Blocked by:** 06、07

**Status:** ready-for-agent

- [ ] 夜间运行后：当天轨迹产生的新假设入库（或对既有规则追加佐证），当天 hit 均有 judgment 事件
- [ ] 索引在 commit 后与 DB 状态一致（新规则/降级立即反映）
- [ ] experience 文档不再生成，既有 commit 流程与守卫测试相应更新
- [ ] prompt 中写明判定原则与工具使用次序；预算合同覆盖新增读写工具调用

## Comments
