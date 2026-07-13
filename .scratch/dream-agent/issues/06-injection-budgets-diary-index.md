# 06 — 注入预算＋日记索引

**What to build:** session-start 注入反映新分层。注入加载器渲染当前画像 2k token、当前经历 2k token、recent-first 日记索引 1k token；archive 永不注入。dream agent 把日记索引维护成 recent-first 的诸日记指针列表。

**Blocked by:** 01

**Status:** ready-for-agent

- [ ] 注入上下文含画像（≤2k）、经历（≤2k）、日记索引（≤1k），截断处各带「还有 N 行，见 <path>」指针
- [ ] archive 从不出现在注入上下文
- [ ] 日记索引 recent-first 排序，每次 dream 运行后更新
- [ ] 加载器纯函数单测覆盖新预算与 archive 排除
