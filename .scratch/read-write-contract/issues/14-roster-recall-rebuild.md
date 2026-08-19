# 14 — roster 重建于统一渲染器 + 选择器多选

**What to build:** roster 块变成统一渲染器出货的段列表(独立块、分页);recall 的 id 选择器支持逗号多选。

规范:spec「视图(读面)」roster 重建与选择器多选两条([S15069/T978]/[T979] 裁决)。

- **roster 块**:段列表经统一渲染器渲染——活跃时近序,item 100 tok,page 2000 tok,分页默认第一页;字段仅 title、tags;渲染即记录读授权(与门同构)。退役:topic 分组表头、type facet 字形、40 段上限、标题字符截断、与 rubric 的合租(rubric 独占其块,超预算拒绝逻辑相应简化)。挂靠溢出指路行为保留(语义等价即可)。
- **选择器多选**:`id="E31, E32"` 等逗号列表——各项既有语法解析、按序渲染、共享页预算;授权记录覆盖全部项;混合类别或任一项非法→整调用拒绝并回显语法。S/T 地址列表同理支持。
- roster 的空态 create 提示语义保留(措辞可随新渲染调整)。

**Blocked by:** 11(recall/session-composition 领地)。

**Status:** done (2026-08-19)

### Implementation record

- **roster 重建**:`src/mcp/recall.ts` 新增 `renderSegmentRosterFeed`(统一渲染器出货,活跃时近序 `listLiveSegmentsByActivity`,字段仅 title+`segment.tags`——持久化派生字段,无需再现算 member facet,故不再需要 type facet 的存在);token 分页(item 100 tok / page 2000 tok,greedy pack,同构 `buildBrowseFeed` 的分页手法);渲染即经 `recordReadGrants` 记录读授权。`src/hooks/session-composition.ts` 的 `renderSegmentRosterBlock` 是其瘦包装(补 `enforceHardCharLimit` 安全网+挂靠溢出指路语义)。
- **rubric 独占块**:`renderRubricAndRosterBlock`(合租+INCOMPLETE 逃生舱)整体退役;新增 `renderRubricBlock`(纯 rubric,自己的 `enforceHardCharLimit`)。`src/hooks/handlers/context.ts` 的 `buildContextOutput` 现顺序拼接两块(`[rubric, "", roster].join("\n")`),挂线仍是单一 `context` hook 命令输出(未拆分新 hook 命令——判断:重接 hook 注册面比本票范围大,且规范未要求)。
- **选择器多选**:`recall.ts`(`recallMemoryBody`)在 `id` 含逗号时逐项经既有 `parseRoutedId` 语法解析;kind 不一致或任一项解析失败→整调用拒绝并回显语法提示(`ID_SELECTOR_GRAMMAR_HINT`);合法时逐项调用既有 `renderRoutedId`(共享同一 `pageBudget`/`turnBudget`/`sequence`),按序 join。timeline 的 `id` 未做多选(判断:其语法结构性不同——单 session 限定+区间,票据示例只提 recall)。
- **P1-3 渲染前快照**:`write-gate.ts` 的 `recordReadGrant(s)` 改为强制显式 `sequence` 参数(不再内部惰性取值);新增导出 `snapshotWriteGateSequence`。每个渲染入口(`recallMemoryBody`、`timelineQuery`、`renderSegmentRosterFeed`、`buildNoteSettlementContext`)在自身开始处快照一次,贯穿到底部的记录调用。构造性测试见 `tests/db/write-gate.test.ts`。
- **P1-2 记录实际渲染**:recall 的 `S<n>` 详情路由(`renderSession`/`renderSessionDetail` 改返回 `{text, turnIds}`)现记录 session+预览 turn 授权;O* 三路由(`observation-list`/`session-observation-list`/裸 `O<n>`)记录其 turn/session 上下文授权(观察本身无受管实体类型,故不记);timeline 的 session 路由补 session 实体授权。
- **P2-5 搜索加粗**:新增 `withBasicSearchSnippet`(title+content,session/observation 共用)与 `withTurnSearchSnippet`(turn 专用,加 promptPreview/responsePreview/insight 逐行);段命中维持原判(plain,未便宜到值得改)。
- **propose 撞键刷新 title**:`note-settlement-proposals.ts` 从 `INSERT...ON CONFLICT DO NOTHING`+回退 SELECT 改为 UPDATE-先-INSERT-后两语句(UPDATE 命中即刷新 title 且天然给出 `alreadyExisted=true`)。

### 判断记录(Judgment calls)

1. rubric/roster 拆块后仍走同一个 `context` SessionStart hook 命令输出(字符串拼接两段),未拆成两个独立 hook 命令——规范只说「独立块」未指名基础设施层面的 hook 拆分,重接线风险/收益不对称。
2. roster 的 tags 字段改读 `segment.tags`(持久化派生,无计数后缀 `#tag`)而非现算 `computeSegmentMemberFacetCounts`——两者本应等价(同一 `recomputeSegmentFacets` 输入),但省一次现算、且与 spec「字段仅 title、tags」的字面意思更贴合(tags 是 segment 记录的字段,不是渲染时二次派生的 facet)。
3. 选择器多选只加到 recall 的 `id`,不动 timeline 的 `id`——票据两个例子均为 recall 语法(E/S 单地址),timeline 的 `id` 语法结构不同(session 限定+区间),spec 原文「S/T 地址列表同理支持」在上下文中紧跟 recall 的选择器段落,读作 recall 内部 S/T 混合列表而非要求 timeline 新增能力。
4. `sequence` 参数在 `recordReadGrant(s)` 上设为必填(非可选默认惰性求值)——强制每个调用点显式快照,避免同一 bug 在新调用点悄悄重生;所有既有测试直接调用点相应改为显式传参。

- [x] roster 块按新形态渲染:时近序、100/2000 双预算、title+tags、分页
- [x] rubric 块独立,合租逻辑退役
- [x] `id="E31, E32"` 与 `id="S12, S15"` 各一条端到端;非法项整拒回显语法
- [x] roster 渲染记录授权(与 01 的表断言)
- [x] 授权序列渲染前快照(构造性:渲染-记录间插入他人印章→写被正确判 stale)
- [x] S 详情/O* 路由/timeline session 路由的授权记录各一断言
- [x] 非 content 字段命中的搜索呈现加粗邻域
- [x] propose 同址异 title 撞键:不插新行、title 更新

本票同时吸收 2026-08-19 提交审查的三条渲染接缝修复(peer P1-2/P1-3/P2-5)与一条行为修订:

- 授权序列**渲染开始时快照**并随记录接缝传递——渲染与记录之间他人的写入不得使授权显得比渲染新(现记录点在渲染后取计数器现值,读侧 TOCTOU)。
- **渲染什么记什么**统一化:`S<n>` 详情路由(含 turn 预览)、`O*` 观察路由、timeline 的 session 路由全部记录其实际渲染实体的授权(现状:S 详情零记录)。
- **搜索加粗覆盖全部被索引字段**:title/insight/user_prompt/assistant_response 命中时同样走 boldSearchSnippet,而非只有 content(命中证据不可见)。
- **propose 撞键刷新 title**(spec 已修订:键=session+addresses,title 不入键、撞键取新)。

(验收清单见上方 Status 区块——已全部勾选)
