# 07 — dream 读路径：list_rule_hits / read_turn_detail

**What to build:** dream agent 完成评审所需的读取面。`list_rule_hits(date)` 返回该内容日的待评审 hit、所属规则与已解析 turn_ref（含 unresolved 标记），dream agent 无需自行拼装定位逻辑。`read_turn_detail(turn_ref, opts)` 返回 turn 三段文本（user_prompt / assistant_response / assistant_transcript）与 observations 序列——默认截断、永远先报真实长度，语义与既有 raw 轴 CLI 的预算习语一致（单条工具结果可达数百 KB，必须限幅）。两工具计入 dream agent 的预算合同。

**Blocked by:** 05

**Status:** ready-for-agent

- [ ] list_rule_hits 返回结构含规则、turn_ref、unresolved 标记，空日返回空集而非错误
- [ ] read_turn_detail 默认截断 + 真实长度元数据；不存在的 turn_ref 报错而非空对象
- [ ] 大 observation（构造数百 KB fixture）经默认参数返回不超预算
- [ ] 工具注册与允许列表更新，dream agent 会话可见可调

## Comments
