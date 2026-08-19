# 14 — roster 重建于统一渲染器 + 选择器多选

**What to build:** roster 块变成统一渲染器出货的段列表(独立块、分页);recall 的 id 选择器支持逗号多选。

规范:spec「视图(读面)」roster 重建与选择器多选两条([S15069/T978]/[T979] 裁决)。

- **roster 块**:段列表经统一渲染器渲染——活跃时近序,item 100 tok,page 2000 tok,分页默认第一页;字段仅 title、tags;渲染即记录读授权(与门同构)。退役:topic 分组表头、type facet 字形、40 段上限、标题字符截断、与 rubric 的合租(rubric 独占其块,超预算拒绝逻辑相应简化)。挂靠溢出指路行为保留(语义等价即可)。
- **选择器多选**:`id="E31, E32"` 等逗号列表——各项既有语法解析、按序渲染、共享页预算;授权记录覆盖全部项;混合类别或任一项非法→整调用拒绝并回显语法。S/T 地址列表同理支持。
- roster 的空态 create 提示语义保留(措辞可随新渲染调整)。

**Blocked by:** 11(recall/session-composition 领地)。

**Status:** ready-for-agent

- [ ] roster 块按新形态渲染:时近序、100/2000 双预算、title+tags、分页
- [ ] rubric 块独立,合租逻辑退役
- [ ] `id="E31, E32"` 与 `id="S12, S15"` 各一条端到端;非法项整拒回显语法
- [ ] roster 渲染记录授权(与 01 的表断言)
