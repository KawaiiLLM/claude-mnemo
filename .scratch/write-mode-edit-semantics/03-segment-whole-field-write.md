# 03 — 段字段第一次拥有整字段写(prefactor)

**What to build:** 数据层能对段的八个可编辑字段各自做整字段替换。段面此前只有
追加与字面替换,**没有整字段写**——`write` 模式因此不是换个名字,是新增能力。

本票只建能力,不接工具面(票 05 接)。这是 prefactor:先让改动容易,再做容易的
改动。

**Ruling base:** spec D11。

**Blocked by:** none。

**Status:** ready-for-agent

## Pinned decisions

- 覆盖 `SEGMENT_EDITABLE_FIELDS` **全部八个**字段(六个 Working State 字段加
  content、insight),不挑选子集。
- 明确并实现空串与 `null` 的语义,与 note 面一致:`null` 是清空,而清空是一次
  写(「被写过」而非「从未写过」),不是无操作。
- 写后必须**重建引用关系(citations)并重索引 FTS**。既有的追加/替换路径已经承
  担这两项职责,新路径漏掉就会让整覆盖过的字段从检索里消失、让它的
  `[S<n>/T<m>]` 引用失联。先读那两条路径怎么做,照做。
- **不碰 `applySegmentWrites`** ——那是结算的 CAS 路径且明确排除 Working
  State,与本票是两件事。
- 不引入新的写门判定:门在票 06。本票的函数假定调用方已经放行。

## Acceptance criteria

- [ ] 八个字段各自可被整字段替换,读回即新值。
- [ ] `null` 清空后,该字段是「被写过的空」而非「从未写过」。
- [ ] 整覆盖后 FTS 能检索到新内容、检索不到被覆盖掉的旧内容。
- [ ] 整覆盖后引用关系与新文本一致(旧文本里的引用不再残留)。
- [ ] 既有的追加/替换路径行为不变,其测试不改而绿。
- [ ] typecheck 干净;全套绿,只余既定的陈旧包守卫红。

## Ground rules

- NO git write commands。报出改动文件清单,主会话提交。
- 不碰 `~/.claude-mnemo/`、`plugin/scripts/`、版本号、`src/worker/`。
- 自己文件之外的瞬时红:窄范围重跑,绝不回滚工作树。
