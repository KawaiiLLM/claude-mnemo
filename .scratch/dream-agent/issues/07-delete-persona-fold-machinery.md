# 07 — 删除 persona fold 机制

**What to build:** dream 路径已完全替代旧 persona 生命周期后，退役被取代的机制。移除 fold/rebase 算子、generations 与 CURRENT-generation 协议、terminal tombstone 与 persona 操作状态机、发布 token 预算校验器。旧的死锁场景不再可构造。

**Blocked by:** 04, 05, 06

**Status:** ready-for-agent

- [ ] fold/rebase/generations/CURRENT/tombstone/操作状态机/发布预算校验 代码路径全部移除
- [ ] 0.3.2 死锁场景不可复现（其状态机已不存在）
- [ ] 测试套件绿：被删路径的测试同步删除或迁移
- [ ] 现有 diary/persona 相关测试无残留对已删符号的引用
