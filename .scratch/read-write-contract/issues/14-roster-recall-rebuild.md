# 14 — roster 重建于统一渲染器 + 选择器多选

**What to build:** roster 块变成统一渲染器出货的段列表(独立块、分页);recall 的 id 选择器支持逗号多选。

规范:spec「视图(读面)」roster 重建与选择器多选两条([S15069/T978]/[T979] 裁决)。

- **roster 块**:段列表经统一渲染器渲染——活跃时近序,item 100 tok,page 2000 tok,分页默认第一页;字段仅 title、tags;渲染即记录读授权(与门同构)。退役:topic 分组表头、type facet 字形、40 段上限、标题字符截断、与 rubric 的合租(rubric 独占其块,超预算拒绝逻辑相应简化)。挂靠溢出指路行为保留(语义等价即可)。
- **选择器多选**:`id="E31, E32"` 等逗号列表——各项既有语法解析、按序渲染、共享页预算;授权记录覆盖全部项;混合类别或任一项非法→整调用拒绝并回显语法。S/T 地址列表同理支持。
- roster 的空态 create 提示语义保留(措辞可随新渲染调整)。

**Blocked by:** 11(recall/session-composition 领地)。

**Status:** ready-for-agent

本票同时吸收 2026-08-19 提交审查的三条渲染接缝修复(peer P1-2/P1-3/P2-5)与一条行为修订:

- 授权序列**渲染开始时快照**并随记录接缝传递——渲染与记录之间他人的写入不得使授权显得比渲染新(现记录点在渲染后取计数器现值,读侧 TOCTOU)。
- **渲染什么记什么**统一化:`S<n>` 详情路由(含 turn 预览)、`O*` 观察路由、timeline 的 session 路由全部记录其实际渲染实体的授权(现状:S 详情零记录)。
- **搜索加粗覆盖全部被索引字段**:title/insight/user_prompt/assistant_response 命中时同样走 boldSearchSnippet,而非只有 content(命中证据不可见)。
- **propose 撞键刷新 title**(spec 已修订:键=session+addresses,title 不入键、撞键取新)。

- [ ] roster 块按新形态渲染:时近序、100/2000 双预算、title+tags、分页
- [ ] rubric 块独立,合租逻辑退役
- [ ] `id="E31, E32"` 与 `id="S12, S15"` 各一条端到端;非法项整拒回显语法
- [ ] roster 渲染记录授权(与 01 的表断言)
- [ ] 授权序列渲染前快照(构造性:渲染-记录间插入他人印章→写被正确判 stale)
- [ ] S 详情/O* 路由/timeline session 路由的授权记录各一断言
- [ ] 非 content 字段命中的搜索呈现加粗邻域
- [ ] propose 同址异 title 撞键:不插新行、title 更新
