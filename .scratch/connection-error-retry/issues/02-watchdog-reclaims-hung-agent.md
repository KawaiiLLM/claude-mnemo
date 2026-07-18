# 02 — 挂起的 agent 被看门狗回收

**What to build:** 一个撞上连接错误后**卡死不 throw**（agent 子进程内部重试再干等、0% CPU）的抽取会话，会被 stall-watchdog 识别并中止，中止归类为 connection、走 01 建立的 suspend/释放路径——不再无限挂起、不再永久占着 claim 焊死队列。

**Blocked by:** 01（复用其 connection 分类与 suspend 路由）。

**Status:** implemented

## 设计要点（见 ../spec.md 「Implementation Decisions §2」）

- 根因：`onMessage` 对**每条**流消息（含 `system subtype=api_error`）刷新 `lastMessageAt`/`lastActivity` → api_error 洪流把 stall-watchdog 的停滞计时反复喂饱、十几分钟不触发。
- **决定：api_error（连接类）流消息不计入「有进展」的活跃信号**——活跃以「产出了抽取进展（assistant 文本 / remember 工具调用）」为准，而非「流上有任何字节」。
- watchdog 触发中止时，**该中止必须被归类为 connection 并路由到 01 的 suspend 链**（释放 claim + turn 可重抽），而非走确定性中止/floor 路径。

## 关键文件

- `src/worker/server.ts` — `onMessage`（活跃信号来源）、stall-watchdog（`WATCHDOG_INTERVAL_MS` / `createWorkerAbortError("stall-watchdog")`）、中止后的分类路由
- `tests/worker/server.test.ts` — mock 驱动 main + 时钟推进的先例

## Acceptance criteria

- [x] 注入一个「发若干 api_error 后永不产出 assistant/remember」的 mock agent，推进到 watchdog 阈值 → agent 被中止、`resetClaimedQueueItemsForSession` 被调用（claim 释放）、turn 不变 `failed`、会话进入待重试态。
- [x] 对照：一个「持续产出 assistant/remember 进展」的 mock agent 不会被 watchdog 误杀（活跃信号只认真进展）。
- [x] watchdog 中止走 connection 路由，而非把 turn 送进 floor。
- [x] `bunx tsc --noEmit` 通过；`bun test` 相对基线不回退。

## 约束

- 不执行任何 git 命令；只编辑文件。
- 不做版本号变更、不重建 `plugin/scripts/*.cjs`（stale-bundle 守卫 1 fail 是预期基线）。
- 不触碰 `~/.claude-mnemo` 下的任何线上数据。

## Comments

- `onMessage` 只把 assistant 实质文本与 `mcp__mnemo__remember` 工具调用计为抽取进展；connection 流信号不再刷新 watchdog 时间戳。
- `onRemember` 也刷新进展时间，覆盖工具执行回调；watchdog 的 `stall-watchdog` abort 继续由 01 路由到 suspend/释放链。
- 验证：`bunx tsc --noEmit` 通过；`bun test` 为 962 pass / 1 fail，唯一失败仍是预期的 stale-bundle guard。
