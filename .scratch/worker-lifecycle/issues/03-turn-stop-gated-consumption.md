# 03 — 消费触发权收敛到 turn-stop

**Parent:** ../spec.md

**What to build:** 打开 CC 看一眼（resume 后不产生任何 turn 即关闭）不引发任何后台活动——不 spawn worker、不排空积压、不重建记忆 agent。消费只由 turn-stop 驱动：SessionStart 的 wake 不再触发排空；SessionEnd 仅当本次运行产生过新 turn 才通知 flush；遗留积压等任意 session 的下一次 turn-stop 全局排空时顺带处理。记忆 agent 的缓存热度由此天然跟随主 agent。

**Blocked by:** None — can start immediately.

**Status:** implemented

- [x] glance 场景（SessionStart + SessionEnd，期间无新 turn）：不 spawn worker、无排空发生、无记忆 agent 创建
- [x] SessionEnd 门控：hook 侧判定该 session 是否存在晚于本次运行 start 的新 turn，有才发 flush 通知（无则连 spawn 都不发生）
- [x] 正常 turn 流不受影响：Stop / PostToolUse 的 wake 照常触发排空，既有 hooks 与 worker 测试不回退
- [x] 遗留的未提取 turn 在下一次任意 session 的 turn-stop 全局排空中被处理（既有全局排空行为保持）

## Comments

- 新增 `session_run_state`，SessionStart 以当前 session 的最大 turn id 记录持久化运行边界；SessionEnd 用单条 `EXISTS` SQL 判断是否出现更大的 turn id。compact 来源不会重置边界，避免一次运行内压缩后误判为 glance。
- SessionEnd 在构造 `asyncWork`、调用 `notifyWorkerFlush` 之前完成门控。glance 回归将 worker 设为 down，并断言 health fetch 与 spawn 均为 0 次，因此不会排空或创建记忆 agent。
- SessionStart 保留 dream backlog 的 best-effort 对账/入队及记忆上下文注入，但移除了 `kickWorkerFast` 依赖和 500ms wake 路径；延迟 dream 继续遵循票 02 的 connection +15min 重试语义，等待后续 turn-stop wake。
- worker main 不再在普通 boot 后调用全局 `scanAndDrainQueue`；由门控 SessionEnd spawn 的启动参数只触发对应 session 的 `flushSession`，不顺带全局排空。`POST /wake` 的全局 drain 保持不变。
- 新增 boot 静默 + 显式 `/wake` 回归：两个 session 中较早遗留的未提取 turn 与触发 wake 的当前 turn 一并被全局处理。原 production dream runtime 测试同步改为显式 `/wake`，仅修正旧 boot 自排空前提。
- Stop / PostToolUse 定向回归通过；相关 hooks/schema 定向测试 61 pass / 0 fail，worker server 66 pass / 0 fail，dream runtime 7 pass / 0 fail；`bunx tsc --noEmit` 通过。
- 全量 `bun test`：903 pass / 1 fail，相对接受基线 901 pass / 1 fail 无回退。唯一失败仍为 `tests/shared/release-artifacts.test.ts` stale-bundle guard；按约束未重建或触碰 release 产物。无规格偏差。
- 调用方验收备注：门控对「无 session_run_state 行」的会话 fail-closed（不 flush）——SessionStart 未触发的旧会话与部署过渡期存量会话的 SessionEnd 尾批会延迟到下次任意 turn-stop 处理。属可接受的软失效：最后一个 turn 的 Stop wake 已排空主体，且延迟提取是本 spec 的既定取舍；fail-open 反而会让旧会话的 glance 重新 spawn worker，违背不变量。
