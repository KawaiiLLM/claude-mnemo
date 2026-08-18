# 14 — 跟进项（不阻塞发版，逐条独立）

每条都已核实，但严重度不足以进发版批次。按需拆票。

**1. 提案没有终止状态。** `src/db/note-settlement-proposals.ts:15-19`、`:110-124`：既无采纳标记也无驳回标记，读取是全局最新 3 条。一条已被采纳的提案会在每次 SessionStart 继续渲染，直到被三条更新的挤掉。T821 的流程（「主 agent 获知后主动询问用户，再用 remember 工具进行操作」）没有终点。

**2. 每段两块的上限是 3。** `src/hooks/session-composition.ts:68` `ATTACHED_SEGMENT_BLOCK_SLOTS = 3`，hooks.json 注册 6 条槽位命令，第 4 个及以后的挂靠段只在花名册里得到一个指针。T825 的原话是「注入块数取决于挂靠段的数量」，没有上限。票 10 自陈「no number was pinned」。上限本身可能是对的，但**花名册的溢出提示没说明原因**，用户看不出为什么这个段没有块。

**3. `decisions` 的豁免被收窄。** ADR-0002 与 spec:98 说 `decisions` 的追加「完全在节奏之外」；`src/mcp/remember.ts:486-493` 的注释自陈只豁免「过于频繁」提示，20 轮提醒仍然适用。二选一：改实现或改 ADR，别两头挂着。

**4. 花名册按 topic 分组，裁决说的是粗粒度项目 tag。** spec:130「coarse project tag as group header」；`session-composition.ts:193/203` 用 `topicName`。真实数据上两者不是一回事,而 `topic` 是 `remember(create)` 的必填人工输入,与自动派生的项目 tag 并存为两套项目键。用户已判为「初版不需要,以后的优化项」。**注意与票 02 不同**——票 02 是遗留段泄漏,即使加了项目维度也仍然存在。

**5. 花名册没有项目维度。** `listLiveSegmentsByActivity` 只有 `WHERE status='open'`,冷启动时在 A 项目会看到 B 项目的段。段表无项目字段,需从成员 turn 所属会话的路径推导。用户已判为以后优化。

**6. 结算 facade 与 remember 只共享工具名。** `note-settlement-membership-facade.ts:57-67` 的参数是 `action: assign|propose`,`definitions.ts:311` 的是 `verb: create|attach|append|replace`——参数名不同、动词零交集。ADR-0007 写的是「not a dedicated facade set」。至少统一参数名为 `verb`,或把 ADR 改成「共享名字与字段对象,动词集按调用方分」。

**7. spec 仍停在 T849 之前的合并块设计。** `.scratch/semantic-container/spec.md:122-124` 与 story 16 仍写「one block per attached segment, 2000 tokens each — recall collapsed (1000) + timeline (1000)」;ADR-0006 已带修正,实现也是对的。spec 是下一个 worker 读的东西,应改写。

**8. 声明的块顺序与 ADR 相反。** ADR-0006:28-29「Roster follows the segment blocks, proposals last」;hooks.json 声明的是 roster → persona → digest → notes → proposals → segment1..3。CC 按完成序拼接故顺序本就不保证,但声明序是唯一可控信号,现在表达的是相反意图。二选一:调整声明,或在 ADR 里记明顺序不可控。

**9. recall 的字段集参数叫 `depth`,裁决与 spec 都叫 `view`。** `definitions.ts:108`;`recallInputSchema` 是 `.strict()`,所以按裁决的名字调用会直接解析报错。

**10. `maintenanceTurnsAgo` 把每个挂靠会话的距离相加。** `src/mcp/segment-card.ts:263-272`;挂 5 个会话就报 5 倍,与 10/20 阈值不可比。

**11. `attach` 的描述说返回「full fields」,实际返回折叠卡。** `definitions.ts:81` vs `remember.ts:401-404`。按 T830「默认折叠表示 1000 token 截断」,**代码对、描述错**。

**12. `remember(create)` 不自动挂靠。** `remember.ts:276-365`;而结算只能向已挂靠段派成员(`membership-facade.ts:155`)。刚建的段在本会话拿不到任何成员,除非同时传 `members` 种子。

**13. 发版操作项:hooks.json 与 bundle 必须同批更新。** 现行 bundle(8/17)的分发函数只认 `persona|recent|digest|milestones|notes`,其余全落 `"sessions"` 兜底。hooks.json 已写入 7 条新命令,若在重建 bundle 之前 reload 插件,SessionStart 会注入 **8 份重复的旧 sessions 块**。stale-bundle 守卫(逐字节比对重建产物)会拦住发版,但拦不住手动 reload。
