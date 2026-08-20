# 10 — recall 的 turn metadata 行渲染 type 与 tags

**What to build:** recall 的 turn 行,metadata 槽在 time、gap、stats 之后再带上
这一轮的 type 与 tags;两者同时进入逐字段完整性记录,票 06 的门因此有据可依。

**Ruling base:** [S15069/T1066](用户提出把 type/tags 放进 metadata 行)、
[S15069/T1078](集合字段不豁免完整读,故渲染是唯一出路)、
[S15069/T1079](样例扩项已确认)。

**Blocked by:** `.scratch/view-render-repair/05`——**文件级阻塞,非逻辑阻塞**:
`composeTurnMetadata` 目前住在 `src/mcp/timeline.ts`,而票 05 的 worker 正在该
文件内作业。等它落地再开工。

**Unblocks:** 本批票 06。

**Status:** blocked

## Pinned decisions

- **先搬家,再扩项。** 票 05 落地后 timeline 完全不再使用
  `composeTurnMetadata`,它继续住在 `timeline.ts` 而由 `recall.ts` 跨文件引用就
  是纯粹的错位。把它移到 `src/mcp/format.ts`(共享渲染面的家),跨文件引用随之
  消失。搬家是纯移动,行为逐字节不变——先搬、跑绿、再扩项,两步分开做。
- **行的形态**(用户已确认):

  ```
  [T823] 结算把 grade 写面整个退役
      08-17 18:19 · +2h14m · 3 tools · design, research · #claude-mnemo #write-gate
      - content: ...
  ```

  顶层分隔仍是 ` · `;type 槽内多值用 `, ` 连接(type 是词数组,不是单值);
  tags 每个带 `#` 前缀、空格分隔,与花名册的既有写法一致。
- **空槽整个省略**,不留孤立的分隔符:type 为空数组则没有那一段,tags 同理。
- **两者都要进完整性记录。** 票 04 的 `GATED_TURN_FIELDS` 目前只有
  title/content/insight,本票把 `type`、`tags` 纳入,沿用同一套推送与落库路径。
  短则天然记为完整;metadata 行被预算截断时记为不完整——那正是票 06 要读的信
  号。
- **不做 `topic:` 命名空间的特殊处理。** 已查产线库:带 `topic:` 前缀的 tag 计
  数为 **0**。不要为它写分支,也不要过滤 tags——渲染全部,否则 `tags` 的完整性
  记录就是假的。
- **不碰 timeline 的行式。** timeline 按 [S15069/T1067] 的定案没有 metadata
  行,本票与它无关。

## Acceptance criteria

- [ ] 搬家一步单独可验:`composeTurnMetadata` 移入 `format.ts` 后,recall 输出逐
      字节不变,既有夹具不改而绿。
- [ ] metadata 行按上面的形态带上 type 与 tags。
- [ ] type 为空 / tags 为空时,对应段整个消失,不留多余分隔符。
- [ ] 多 type 的 turn 渲染出全部 type,不只第一个。
- [ ] `type` 与 `tags` 各自产生逐字段完整性记录;未截断记为完整,截断记为不完
      整。
- [ ] recall 的金样例夹具按新形态更新——**逐条列出改了哪些字节、为什么**。
- [ ] timeline 输出逐字节不变。
- [ ] typecheck 干净;全套绿,只余既定的陈旧包守卫红。

## Ground rules

- NO git write commands。报出改动文件清单,主会话提交。
- 不碰 `~/.claude-mnemo/`(产线库只读,演练只在 /tmp 副本上)、
  `plugin/scripts/`、版本号、`src/worker/`。
- 不要自行重建 bundle。
- 开工前先确认票 05 已落地,否则 `timeline.ts` 会与另一个 worker 撞车。
