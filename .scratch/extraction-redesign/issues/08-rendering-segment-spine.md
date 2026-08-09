# 08 — 渲染层：段脊柱 timeline 与 recall E 选择器（P2）

**What to build:** 读端切换到段结构（spec D8/D11）。timeline 新 era 默认视图 = 段脊柱（段行：主 type glyph + tag + title + status + 成员数/跨度 + 相位轨迹）+ 孤儿锚点行（未归段但机械信号强的 turn）；段内下钻 = anchor 优先占位 + 派生 rank（词典序 ORDER BY 事实列，(citing,cited) 跨 provenance 去重）补齐渲染预算；按天视图在新 era 移除。era 按 turn 级 epoch cutoff 分路（R2#7）：同一会话内旧 turn 走 legacy 渲染路径（全套保留只读），新 turn 走段脊柱。recall 新增段选择器 `E`（`[E47]`），段记录以同 schema 进入命中集与 type:/tag: 过滤；obs 行渲染机械字段。SessionStart 弧骨架注入改查段表，预算沿用现有合同。

**Blocked by:** 06 — 段/主题/边 schema 与机械层（07 完成前用 fixture 数据验收）。

**Status:** done

- [x] 跨 era 会话双路渲染正确：旧 turn legacy 视图、新 turn 段脊柱，同屏无混读
- [x] `recall(id="E47")` 往返可用；`tag:` / `type:` 过滤同时命中段与成员 turn
- [x] 段内下钻顺序确定且可解释：固定信号列的 fixture 断言完整排序
- [x] 孤儿锚点（高机械信号、无段归属）独立成行
- [x] 注入的段骨架不超既有预算合同
- [x] replay 原文轴零改动（回归断言）
- [x] 追加（票 06 实现发现）：FTS 解耦后 `queryTurnsByScope`（src/db/search.ts）无 turn status 谓词，skipped/在飞 turn 已可被检索命中——本票补渲染侧状态过滤（D11：status 只影响渲染）；obs 读路径已有 `status='extracted'` 过滤，不需动

## Comments

**实现记录（本票落地时的取舍，票 09 需知）**

- era 开关落在 config 的 `eraCutoffEpoch`（可空整数，默认 `null`，`clampConfig` 已注册；0/负数/浮点/字符串一律读作 `null`——epoch 0 会把全部历史推上新路）。**票 09 只需把它设成发布时刻的 epoch**，读端全部就位。MCP 与 SessionStart 两个入口各自在构造时读一次 config（非每次调用），可注入覆盖供测试。
- 新 era 段脊柱挂在 **`milestones`（弧）视图**，不是 `turns`/`phases`：后两者是原始行与 type 派生，跨代语义不变。连带效果：turns 表的 `G` 列对 era turn 打 `—`（era turn 不在 legacy `effGradeByTurnId` 里），这是对的——grade 是 legacy 语义。
- legacy 选择器改吃 `legacyWindowTurns` + `legacySessionTurns`（连解析引用的全集一起过滤），否则 era turn 会被 pull-through 拉进 legacy 块按 grade 语义渲染。
- 段行 glyph = **成员 type 众数**，但众数并列时改用段自身 `type[0]`（结算的判断优于任意 tiebreak），两者皆无则不给 glyph。见 `deriveDominantType`。
- 派生 rank 的 SQL 排序键末尾补了 `t.id DESC`（spec 列表止于 `created_at DESC`）——同秒两 turn 否则不是全序，两次渲染可能互换。另：`type` 为 NULL 时 `type = 'rolled-back'` 是 NULL，而 SQLite 的 ASC 把 NULL 排最前，故用 `COALESCE(t.type,'')`，否则「无 type」会白拿第二键的头名。
- 孤儿锚点的「机械信号强」定义为**别的记录为它背书**：是纠正者 / 被引 ≥1 / type 含回退。文件数与工具数**故意不算**——几乎每个实现 turn 都有，收进来就退化成段结构要取代的那张平铺表。skipped/undone 不出现（与 `isTimelineLiveTurn` 一致）。
- 段进 FTS（`layer='segment'`，`type`+`tags` 落 `extra` 槽）——否则 `tag:`/`type:` 只能命中 turn，段无法「以同 schema 进入命中集」。写入点：`createSegment` 与 `applySegmentWrites`，`rebuildSearchIndex` 同步。段命中 `sessionId` 为 NULL（段不绑会话），recall 把它们渲染在会话组之前。
- 注入预算沿用 `MILESTONE_INJECTION_TOKEN_BUDGET`：脊柱先自减到能单独装下（先丢孤儿锚点、再丢最老的段，都留 `… +N` 折行），余额交给既有 legacy 预算 fitter，两级都用 `estimateDiaryTokens` 量整份输出——没有第二套预算系统。
- **本票唯一活行为变更**：`queryTurnsByScope` 两条分支都加 `t.status = 'extracted'`（与 obs 读路径对称，也正是解耦前索引删除所强制的行为）。`queryRecentTurns`（无过滤的 scope=turns 近期表）**未加**，因为票只点名 `queryTurnsByScope`，且 recall 永不走那条路径——票 09 若要统一，改那一处即可。
- 连带改了票 06 的两条 FTS 测试断言：它们原本用 `searchMemory` 证明 skipped turn「可被检索」，现在拆成「索引层仍在 + 渲染层不出现」两句——与票 06 注释里「obs 截断原文只在索引层可验证」同一逻辑。
