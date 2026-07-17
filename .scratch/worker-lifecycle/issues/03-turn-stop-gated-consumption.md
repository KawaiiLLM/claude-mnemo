# 03 — 消费触发权收敛到 turn-stop

**Parent:** ../spec.md

**What to build:** 打开 CC 看一眼（resume 后不产生任何 turn 即关闭）不引发任何后台活动——不 spawn worker、不排空积压、不重建记忆 agent。消费只由 turn-stop 驱动：SessionStart 的 wake 不再触发排空；SessionEnd 仅当本次运行产生过新 turn 才通知 flush；遗留积压等任意 session 的下一次 turn-stop 全局排空时顺带处理。记忆 agent 的缓存热度由此天然跟随主 agent。

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] glance 场景（SessionStart + SessionEnd，期间无新 turn）：不 spawn worker、无排空发生、无记忆 agent 创建
- [ ] SessionEnd 门控：hook 侧判定该 session 是否存在晚于本次运行 start 的新 turn，有才发 flush 通知（无则连 spawn 都不发生）
- [ ] 正常 turn 流不受影响：Stop / PostToolUse 的 wake 照常触发排空，既有 hooks 与 worker 测试不回退
- [ ] 遗留的未提取 turn 在下一次任意 session 的 turn-stop 全局排空中被处理（既有全局排空行为保持）
