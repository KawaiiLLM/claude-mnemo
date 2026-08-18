# 08 — 段卡片的预算顺序与字符截断

**What to build:** 段卡片在 2000 token 的注入块里不再按 200 字符截断；摘要层参与省略阶梯；挂靠会话行有上限。

**用户裁决：** T829「段字段不强制规定 token 数，但渲染时如果超过 1000 token，从占用最多的字段开始省略」；T830「默认折叠表示 1000 token 截断，否则不截断」。spec:109 明写「The character `truncate` knob retires」。

**实现现状：**
- `src/mcp/segment-card.ts:320` `truncate = options.truncate ?? DEFAULT_TRUNCATE`（200 **字符**，`format.ts:19`）；`:330` 与 `:367-372` 把 title/content/insight 按 200 字符切断，与 2000 token 的块预算无关。结果是摘要层在句子中间被截，而块里还有大量余量。
- `:375-379` 的省略阶梯只覆盖六个 Working State 字段；摘要层先渲染且从不参与省略，于是**全部预算压力由 Working State 承担**，与 spec:53 story 17「Working State rendered before the summary layer, so the operational half survives budget pressure first」正好相反。
- `:355-362` 每个挂靠会话渲染一行且**无上限**，而 ADR-0005 裁定绑定行只增不减；header 随挂靠数单调增长，最终把字段预算压到 0。

**证据等级：** story 17 出自 spec user story，审计未在用户原话中找到对应句子。若认为渲染顺序本就该是摘要优先，请改 spec；但字符截断与 header 无上限两条与 T829/T830 直接冲突，无论顺序如何都要修。

**Blocked by:** 05（`content`/`insight` 有写入者后，摘要层才会真正占预算）

**Status:** ready-for-agent

- [ ] 卡片自身渲染不再使用字符级 `truncate`
- [ ] 摘要层与 Working State 同在一个省略阶梯里，按占用最多优先省略
- [ ] 挂靠会话行有上限，溢出给计数
- [ ] 构造一个挂靠数很大的段，证明字段预算不被 header 吃光
