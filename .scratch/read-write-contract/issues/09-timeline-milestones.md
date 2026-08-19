# 09 — timeline 两视图 + 里程碑选择 + SessionStart 注入

**What to build:** timeline 支持段选择器;里程碑视图按字典序信号自动选重要 turn;SessionStart 注入里程碑视图作全局索引。

规范:spec「timeline」「里程碑」。

- 段选择器(新能力):数据范围=段成员 turn 跨 session 时序;输出一律 `S<n>/T<m>` 回指;分页语义与会话视图同构;`timeline(id="E31/T1...")` ≡ `timeline(id="E31")`。
- turn 视图与里程碑视图仅差 pageSize 驱动的重要性选择。
- 里程碑选择=字典序:**第 0 键 overridden 除名**;encodes 降序;refines 超额入度降序(**decision 桶先于 delivery 桶**);时近。填满 pageSize;选择是唯一显示权威;无边图安全退化(平铺时序)。信号消费 edge-signals,不重算。
- 旧纪元 turn 整体退出里程碑渲染(既有裁决,勿回退)。
- SessionStart 注入里程碑视图。

**Blocked by:** 07(渲染器内核)。

**Status:** ready-for-agent

- [ ] 段选择器跨 session 时序+S/T 回指+分页
- [ ] 字典序四键构造性测试(含 overridden 除名与桶序)
- [ ] 无边图退化;旧纪元退出
- [ ] SessionStart 注入块渲染
