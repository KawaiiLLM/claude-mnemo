# 12 — metadata 回归默认行(金样例回归修复)+ 归因与注释清偿

**What to build:** turn 卡片的默认渲染回到金样例:title 行 + **metadata 行**
+ content 槽——时间锚回到每张默认卡;结算的紧凑渲染同样带上 metadata 行,
type/tags 盲区关闭。spec/票据的 prose 退役归因改正;过期注释清偿。

**Ruling base:** [S15069/T1135](用户重钉金样例:metadata 是默认行,
「默认只有 content」限定其他字段槽位;d0590fe 把它误分类成槽位是回归);
peer 终审必改 7、建议 5。

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

## Pinned decisions

- `DEFAULT_TURN_RENDER_FIELDS` 加入 `"metadata"`(title、metadata、content)。
  filter.fields 作为唯一选择机制**不变**——变的只是默认集;显式窄选(如只要
  content)仍然可行。
- 结算上下文的每 turn 渲染(note-settlement-context.ts 的 formatTurnCompact
  路径)带上同一条 metadata 行;completeness 记录随渲染自然落账(type/tags
  从此对结算可见)。**不要**顺手把 requireCompleteRead 铺到结算的 type/tags
  ——那是票 11 之后的独立小票,先有可见性。
- 完整读救济文案(note.ts 的 completeReadRemedyForTurnField、recall 描述里的
  教学)按新默认减负:普通 recall 即挣得 type/tags completeness,救济措辞相应
  简化,但 filter 选择机制的教学保留。
- 金样例的行序为准:`[T823] title [rewind]` 下一行 metadata,再往下字段槽。
  受影响的 golden/固定文本测试逐一改判,在报告里列明每处。
- 归因改正(必改 7):`spec.md`、`04-settlement-rearmed.md`、
  `06-adr-and-docs.md` 三处把 prose 退役归 settlement-agentic 的,统一改为
  ownership-and-note-cadence;C7 先存栅栏仍归 settlement-agentic。
- 注释债(建议 5):`citations.ts` 约 71–75、776–781(仍称关系不入 pair
  身份/同对无多关系)、`config.ts` 约 57–59 与 settlement-context 的 25-turn
  旧例——改为现契约,历史记述标 retired。

## Acceptance criteria

- [ ] 普通 recall 的 turn 卡片含 metadata 行(时间在内),与金样例行序一致;
      显式 fields 窄选仍可去掉它。
- [ ] 结算上下文渲染含 metadata 行;type/tags 的 completeness 随普通渲染落账。
- [ ] 救济文案与新默认一致(不再要求 filter 才能挣 type/tags completeness)。
- [ ] 三处归因改正;注释债清偿,grep 无「关系不入身份」类的现在时残留。
- [ ] typecheck 干净;全套绿,只余既定的陈旧包守卫红。

## Ground rules

- NO git write commands。报出改动文件清单,主会话提交。
- 工作面:`src/mcp/format.ts`、`src/mcp/recall.ts`、`src/mcp/definitions.ts`
  (描述文案)、`src/worker/note-settlement-context.ts`、`src/db/citations.ts`
  (仅注释)、`src/shared/config.ts`(仅注释)、`.scratch/edge-mechanism-revision/`
  三个文档、对应测试。turn-facade / direct-write / membership /
  note-settlement.ts / timeline.ts / memory-edges.ts 有并行 worker,只读;
  citations.ts 的**代码**也有并行 worker(票 10),你只许改它的注释——若与其
  改动冲突,注释部分回来报告,不要抢。
- 不碰 `~/.claude-mnemo/`、`plugin/scripts/`、版本号;不重建 bundle。
