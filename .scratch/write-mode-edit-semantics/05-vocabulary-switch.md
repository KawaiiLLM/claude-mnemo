# 05 — 两个写面统一到 write/edit 一套词汇

**What to build:** 写者在 `note` 与 `remember` 上用同一套模式词汇:`write` 整
字段替换,`edit` 在字段内精确替换一段。`append` 与 `replace` 两个旧词一并退
役,被送来时得到指名替代词的报文。

**Ruling base:** spec D1、D3、D4、D10、D14([S15069/T1050]、[S15069/T1051])。

**Blocked by:** 03(`write` 在段面需要那条整字段写路径)。

**Status:** blocked

## Pinned decisions

- `mode.<field>` 从字符串扩为可辨识联合:`"write"`,或
  `{ mode: "edit", oldString, newString }`。一次调用可对不同字段各取其一。
- **`note` 的解析器现在把任何非 append 的 mode 当整字段覆盖。** 只把 enum 换成
  `write|edit` 会让 `edit` 静默变成整写——必须显式改这条落空分支,并写一条测试
  钉住它。
- `remember` 的 `append` / `replace` 两个动词退役,字段写入统一表达为「哪个字
  段、什么模式」。`create` / `attach` / `close` / `assign` 不动。
- `edit` 的三态沿用段面 `replace` 已有形态:`oldString` 缺失或空 → 参数错误;
  找不到 → 拒绝并回显 `oldString`;命中多于一处 → 拒绝并报出命中次数。
  `newString: ""` 删除命中段。
- `type` / `tags` 拒绝 `edit`,报文说明 `oldString/newString` 对集合无意义。
  **范围仅限 `note` 面**:段的 type/tags 由成员 turn 派生、title 是
  create-only,都不在可编辑字段里,不要给它们加限制。
- 字段值与 edit 形态同时出现 → 参数错误(edit 的新内容在 `newString` 里)。
- 退役字面量**保留在 schema 里并挂自定义报文**,否则只会得到 zod 无信息的通用
  枚举错误。两个入口都要测。
- 工具描述写明加行惯用法:锚定末行 `edit`;字段可整读且需重排时用 `write`。这
  是 `append` 退役后唯一的操作空白,不写明写者就会反复试错。

## Acceptance criteria

- [ ] `note` 与 `remember` 都接受 `write` 与 `edit`,语义一致。
- [ ] `edit` 唯一命中成功;找不到、命中多处各自拒绝并指名是哪一种。
- [ ] `mode: "edit"` 不会退化成整字段覆盖(专门的回归测试)。
- [ ] `type`/`tags` 上的 `edit` 被拒;段字段不受此限制。
- [ ] 字段值与 edit 形态并存被拒。
- [ ] `overwrite` / `append` / `replace` 在两个入口都得到指名替代词的报文,而
      非通用枚举错误。
- [ ] 工具描述含加行惯用法,且描述长度未超预算。
- [ ] typecheck 干净;全套绿,只余既定的陈旧包守卫红。

## Ground rules

- NO git write commands。报出改动文件清单,主会话提交。
- 不碰 `~/.claude-mnemo/`、`plugin/scripts/`、版本号、`src/worker/`(结算面是
  票 07)。
- 自己文件之外的瞬时红:窄范围重跑,绝不回滚工作树。
