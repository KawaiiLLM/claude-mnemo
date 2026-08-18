# 13 — ADR-0004 的矛盾核对退化成了引用格式检查

**What to build:** 把「摘要层与成员轮是否矛盾」交回给模型作为只读职责，机械检查保留但不再冒充它。

**用户裁决（T824）：** 「结算窗顺带核对摘要与成员轮是否矛盾，只标记不改写」。
> 证据等级注记：T824 的 prompt 只有 `/grill-with-docs` 一个斜杠命令，用户的选择以选项形式落在该轮观察里，故此处引用的是被选中选项的原文，不是自由输入的原话。

**文档忠实：** ADR-0004 §2 写得对——「checks attached segments' summary layers **against their member turns** and flags contradictions or unsupported claims」。

**实现偏差：** `src/db/note-settlement-summary-flags.ts:59-109` 只做两条机械启发式：**完全没有引用**，以及**引用了本窗口内被推翻的 turn**。没有任何一处把断言与成员轮的内容做比较。`src/worker/note-settlement-prompt.ts:45-51` 还明确把它从模型职责里移除，理由是「the model is never asked to self-audit its own segment writes」。

**为什么这不等价：** 一条写着「revision complete and verified」而带一个合法引用的 `content` 会直接通过——正是提出这个问题时想防的场景。矛盾核对本质上需要读懂两段文字，机械规则做不到。

**注意「不自审」这条理由是成立的**：段字段由主 agent 写，结算 agent 核对的是**别人**写的东西，不是自审。这两件事在实现里被混为一谈了。

**Blocked by:** 04（结算 agent 先要能看见段的字段，才谈得上核对）

**Status:** ready-for-agent

- [ ] 结算提示含一条只读职责：核对挂靠段的摘要层与本窗口成员轮是否矛盾
- [ ] 发现的矛盾进入面向操作者的结算报告，不改写任何段字段
- [ ] 现有两条机械启发式保留，但报告里与模型判断分列，不混为一谈
- [ ] 构造一个「断言与成员轮相反但引用合法」的样例，证明它被标记
