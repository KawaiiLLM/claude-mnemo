# 11 — 视图旧 API 退役(depth 二态 + truncate 字符参数)

**What to build:** 读工具的体量控制只剩 pageBudget/turn 两个 token 预算与 filter 字段选择;depth 与 truncate 从 schema 到渲染路径整体退役。

规范:spec「视图(读面)」预算 bullet([S15069/T972] 裁决)。

- `depth`(collapsed/expanded 二态)全仓退役:参数从 schema 移除,所有渲染路径改由 filter 字段选择表达细读(07 的 `filter.fields` 从加法机制升为唯一机制)。
- `truncate` 字符参数(默认 200/上限 2000)及字符上限机制退役:字段截断只由 `turn` token 预算驱动(词边界);obs 恒截断同样走 token 预算。
- 拒绝报文与工具描述随语法同步;既有测试按新契约改写。
- 07 票判断记录里「depth 保留」「truncate 双刀」的过渡状态由本票清算。
- `hooks/session-injection.ts` 及其测试(旧 elision 渲染路径)已于缝合针失去全部消费者,**物理删除归本票**(留而不用状态与 staging 引擎同款);`mcp/session-output.ts` 的 elision 机制若随 truncate 退役而无消费者,一并清算。

**Blocked by:** 07(渲染器内核,已 done)。

**Status:** ready-for-agent

- [ ] schema 无 depth/truncate;传入被拒并回显新语法
- [ ] 全部渲染路径字段截断仅由 turn token 预算驱动(构造性测试:同内容不同 turn 预算)
- [ ] filter.fields 覆盖原 expanded 的全部信息面
- [ ] 既有测试迁移,无 depth/truncate 残留引用(grep 断言)
