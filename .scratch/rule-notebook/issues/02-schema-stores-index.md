# 02 — rules / rule_events 双表 + store + 触发索引 renderer

**What to build:** 规则的持久化本体与它的编译投影。种入若干规则行后，能渲染出确定性的编译触发索引（JSON），名额淘汰算法在渲染时生效。spec（`.scratch/rule-notebook/spec.md`）的「数据模型」一节是权威定义，其中 `trigger_spec` discriminated union、`rule_events` 统一事件账本 schema、判重与淘汰算法均为定案，照此实现。

要点（详见 spec）：

- `rules` 表：status 含 `digest_only`；refuted/retired 为墓碑永不删除；时间字段 epoch 秒，毫秒字段须带 `_ms` 后缀
- `trigger_spec` 三形态（prompt/tool/result），初版无正则，字段上限照 spec
- `rule_events`：`event_uid` 幂等键、`source_event_id` 外键、`adjustment_json`、`status_before/after`
- 索引 renderer：候选池 = global + 项目规则；可推送 ≤10，淘汰优先级 confirmed > provisional、同级按 `last_evidence_at_epoch` 新者优先，挤出者降级 `digest_only`（可回补）
- 发布守卫覆盖 renderer 与索引 schema，不覆盖用户运行时索引

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] 双表 migration 落入现有 schema 体系，store 层 CRUD 沿用既有 db store 测试模式
- [ ] `trigger_spec` 三形态的校验（含各字段数量/长度上限）有测试，非法形态被拒绝
- [ ] renderer：同一 DB 状态渲染结果确定；淘汰算法边界（第 11 条规则、同级并列、digest_only 回补）有测试
- [ ] 墓碑不可删除性在 store 层有防护（delete 路径不存在或显式拒绝）
- [ ] 新增一个 status 值已按项目惯例 grep 审计全部既有 status 比较

## Comments
