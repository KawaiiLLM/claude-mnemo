# 07 — 统一渲染器内核 + 浏览形态

**What to build:** recall 无 query 时的新浏览形态:filter 选字段、pageBudget 溢出分页、turn 字段刀、session 首现带 title;结算会话摘要同源渲染带大 turn 预算。

规范:spec「视图(读面)」。

- 渲染器内核:全部读面唯一出货点;**保留 01 的授权记录接缝**(换内核不丢记录)。
- 浏览形态:全局时序;session 交替仅首现带 title;折叠/展开二态废除,字段选择走 filter(每字段 schema 描述各自成段+报错完善)。
- 预算:pageBudget 页级,溢出=**分页**,绝不截断整块;turn=item 级字段刀(词边界,均摊);obs 恒截断。
- rewind turn 渲染带标记;序数 T 只作选择、`S<n>/T<m>` 唯一引用(报错回显语法)。
- 结算的 session 摘要消费方改走此渲染器,传**独立大 turn 预算**(全文可见);旧「溢出→截断+recall 指针」路径退役。

**Blocked by:** 01(记录接缝)。

**Status:** ready-for-agent

- [ ] pageBudget 溢出产生第 2 页而非截断;turn 刀词边界截字段
- [ ] filter 任意字段组合;session 首现带 title、交替不重复
- [ ] rewind 标记;obs 恒截断
- [ ] 结算摘要全文渲染(构造超 2000 tok content 验证);旧 elision 路径无消费者
- [ ] 渲染即记录授权(与 01 的表断言)
