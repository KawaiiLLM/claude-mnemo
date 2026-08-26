# 05 — `create` 两级统一,`declare` 退役

**What to build:** 建任务和建泳道是同一个动词,层级由 id 决定。

对应 spec:D3。

**Blocked by:** 03(地址)

**Status:** ready-for-agent

- [ ] `create` 按 id 层级路由:`E<n>` 建任务,`E<n>/#<tag>` 在该任务下建泳道
- [ ] 两级共用同一条前置:花名册里没有合适的就问用户,同意了才建,不静默新建
- [ ] `declare` 返回指向 `create` 的拒绝,不静默转发
- [ ] 突变:让 `declare` 继续工作,必须有测试变红
