# 04 — stranded 补收覆盖连接释放的 turn

**What to build:** 若网络中断期间**会话结束**了（没有新 turn 来触发事件驱动重试），那些「被连接错误释放但仍未抽取」的 turn 在**下次 `SessionStart`** 时被 `recoverStrandedTurns` 重新入队补收——不永久搁浅。这是 03 事件驱动主路径的死会话兜底。

**Blocked by:** 01（需要「claim 已释放、status 仍非终态」这一 turn 态存在；01 保证连接错误不再把 turn 标 `failed`）。

**Status:** implemented

## 设计要点（见 ../spec.md 「Implementation Decisions §5」）

- 事件驱动恢复（03）只在会话仍活跃、有新 turn 入队时生效。会话已结束则无触发点。
- **决定：`SessionStart` 的 `recoverStrandedTurns` 必须覆盖「因连接错误被释放但未抽取」的 turn。** 确认其判据能捞到这类 turn（claim 已释放、status 非终态、未 extracted），而非仅覆盖崩溃遗留的 stranded。

## 关键文件

- `src/worker/server.ts` / stranded-turn 恢复路径 — `recoverStrandedTurns` 的捞取判据
- `tests/worker/server.test.ts` 或既有 stranded/SessionStart 恢复测试 — 先例

## Acceptance criteria

- [x] 连接错误释放一个 turn（未抽取、非终态）后会话结束 → 下次 `SessionStart` 触发 `recoverStrandedTurns` → 该 turn 被重新入队。
- [x] 已 `extracted` 或真 terminal `failed` 的 turn 不被误重入队（判据只捞可重抽的）。
- [x] `bunx tsc --noEmit` 通过；`bun test` 相对基线不回退。

## 约束

- 不执行任何 git 命令；只编辑文件。
- 不做版本号变更、不重建 `plugin/scripts/*.cjs`（stale-bundle 守卫 1 fail 是预期基线）。
- 不触碰 `~/.claude-mnemo` 下的任何线上数据。

## Comments

- 当前连接 suspend 语义已保留原 turn-stop 行并只释放 claim；`recoverStrandedTurns` 对已有队列项幂等去重，因此 SessionStart 后该 active/provisional turn 仍恰好有一个可认领 turn-stop。
- 生产恢复判据无需改写；新增精确持久态回归，确认连接释放项保留、claim 为 NULL，且有效 extracted / terminal failed 均不误入队。
- 设计偏离：没有人为删除再重复插入 turn-stop；这样保留 01 明定的“释放 claim、持久行不动”语义。
- 验证：`bunx tsc --noEmit` 通过；`bun test` 为 965 pass / 1 fail，唯一失败仍是预期的 stale-bundle guard。
