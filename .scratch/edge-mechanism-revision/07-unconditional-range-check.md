# 07 — 结算 turn 寻址的范围检查无条件化(终审必改 1)

**What to build:** 结算面上,凡以 turn 地址为写入对象的调用——含纯关系、纯撤边
——一律先过 `reviewableTurnIds` 范围检查;窗口外/未渲染的 citing turn 直接拒,
不再依赖写门的偶然拦截。

**Ruling base:** peer 终审必改 1([S15069/T1138] 转达);spec D6「渲染即授权」。

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

## Pinned decisions

- 病灶:`note-settlement-turn-facade.ts` 约 703–717 行,范围检查只在
  `touchesReview || proseFields.length > 0` 时执行;关系/撤边参数不触发它,之后
  只验地址、自引、相位与 citing 的 type 门——隐藏 turn 无 type 章时,写门第三判
  (从未写过)放行。peer 已复现:T2 不在 reviewableTurnIds、无章、
  `T2 depends-on T1` 写入成功。
- 修法:把 **citing turn** 的范围检查提为一切 turn 寻址调用的**无条件前置**。
- **不要顺手限制 cited 靶**:被引方不受范围约束是已裁定的(边只写 citing 侧,
  被引方零检查,[S15069/T1124]);在这里偷加新规则是越权。
- 主 agent 面(mcp/note.ts)**不在本票范围**:它没有窗口概念,写门是它的唯一门。

## Acceptance criteria

- [ ] 窗口外 citing 的纯关系调用被拒,报文指名范围原因(与写门拒绝可区分)。
- [ ] 窗口外 citing 的纯撤边调用同样被拒。
- [ ] 窗口内的关系/撤边行为不变,既有测试不改而绿。
- [ ] peer 的复现路径(无章隐藏 turn)转为回归测试,红→修→绿。
- [ ] typecheck 干净;全套绿,只余既定的陈旧包守卫红。

## Ground rules

- NO git write commands。报出改动文件清单,主会话提交。
- 只碰 `src/worker/note-settlement-turn-facade.ts` 与
  `tests/worker/note-settlement-turn-facade.test.ts`;并行 worker 在
  direct-write/membership、note-settlement.ts、citations/timeline、
  format/context 各处,全部只读。
- 不碰 `~/.claude-mnemo/`、`plugin/scripts/`、版本号;不重建 bundle。
