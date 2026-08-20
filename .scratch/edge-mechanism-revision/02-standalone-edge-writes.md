# 02 — 边写入与正文脱钩,撤边上线

**What to build:** note 工具的关系参数不再要求同调用触碰引用字段、不再检查写后
状态含目标地址;新增撤边入口;text-ref 降级为纯展示信号。

**Ruling base:** spec D1、D3、D4;[S15069/T1109](脱钩)、[S15069/T1124]
(被引 turn 不做读检查;撤边双写者同权)。

**Blocked by:** 01(多关系形态与撤边原语必须先存在)。

**Status:** blocked

## Pinned decisions

- 关系参数可单独出现:不带任何字段的纯关系调用**合法**(「at least one field」
  门对纯关系/纯撤边调用放行)。被写(citing)turn 的写门照常跑——read grant
  作用于被写方,被引方零检查([S15069/T1124])。
- C7 共现校验整体删除,不是旁路:`spec C7` 措辞的拒绝路径、写后状态扫描、
  「uncited target rejects」逻辑全部移除;工具描述与参数 describe 同步删 C7 语言。
- 保留的机器检查:地址存在、阶段合法(validateRelationTarget 不动)、自引拒绝
  (01 的原语)、跨会话 crossSession 确认。
- 撤边 wire 形态:与七个关系字段镜像的撤除参数(同为地址列表,命名以「retract」
  为词根,具体拼法工作时定并报告);结算 facade 在票 04 接同一原语。
- text-ref:解析器保留,采集照旧;删除一切把 bare pair 当「可升级为关系」底座
  的路径与注释。展示端(↳、被引计数)不动。
- 多关系:同对第二条关系写入走 01 的增行语义;工具回执报「新增/幂等」。

## Acceptance criteria

- [ ] 纯关系调用(无任何字段)成功挂边;被写 turn 无 read grant 时被写门拒。
- [ ] 正文完全不含目标地址时关系照常写入(C7 断言的反向测试)。
- [ ] 同对两条不同关系经两次调用并存。
- [ ] 撤边参数删除指定关系;对不存在的关系报文明确。
- [ ] 全仓 grep 无存活的 C7 共现逻辑(注释里的历史记述除外,须标 retired)。
- [ ] text-ref 采集行为不变的既有测试绿;升级路径的测试删除或改判。
- [ ] typecheck 干净;全套绿,只余既定的陈旧包守卫红。

## Ground rules

- NO git write commands。报出改动文件清单,主会话提交。
- 不碰 `~/.claude-mnemo/`、`plugin/scripts/`、版本号、`src/worker/`。
- 不自行重建 bundle。变异候选:被写方写门检查、阶段合法性。
