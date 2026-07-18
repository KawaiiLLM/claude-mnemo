# 01 — 连接错误绝不把 turn 标 `failed`

**What to build:** 一个撞上连接错误（`ECONNRESET` 等，无论以抛出异常还是以 agent 流上 `system subtype=api_error` / `server_error` 形态浮现）的抽取工作单元，永远走 suspend/释放 claim 的路径，把 turn 留在**可重抽态**——绝不进入 derailment floor、绝不被 finalize 成 terminal `failed`、绝不出队。确定性内容错误（agent 反复不 remember 必需 ID）**不受影响**，仍走 3-strike → corrective resend → floor → 无内容 turn 标 `failed` 的既有全链路。

**Blocked by:** None — can start immediately.

**Status:** implemented

## 设计要点（见 ../spec.md 「Implementation Decisions §1/§3」）

- 现有 `suspendSessionAfterConnectionError` 已做正确的事（`resetClaimedQueueItemsForSession` 释放 claim、清 buffer/batch、关 agent query、登记退避）。**复用它，不新建释放机制。**
- 把 agent 流上的 `system subtype=api_error`（connection 类：ECONNRESET / connection error / socket closed 等）识别为**一等 connection 信号**，使这类失败在到达 derailment floor **之前**就被判为 connection、路由到 suspend 链。扩展 `error-classifier.ts` 覆盖这一流信号；保留「未知错误默认 deterministic」的保守缺省不变。
- derailment floor（`applyFloor`）只对确定性内容失败生效。连接类失败永不 finalize 成 `failed`。

## 关键文件

- `src/worker/error-classifier.ts` — connection 分类扩展（新增 api_error 流信号识别）
- `src/worker/server.ts` — flush / work-unit 状态机中连接类失败的路由（在进 floor 前分流到 suspend）
- `tests/worker/server.test.ts`、`error-classifier` 现有单测 — 回归与新增断言的先例

## Acceptance criteria

- [x] 注入一个「抛 ECONNRESET」的 mock agent → 该会话被 suspend、其 claim 被释放、涉及的 turn 行**不**变 `failed`、未出队。
- [x] 注入一个「以 `server_error`/`api_error` 流形态浮现连接错误」的 mock agent → 同样走 suspend、turn 不被 finalize 成 terminal `failed`。
- [x] 回归：注入「反复不 remember 必需 ID」的确定性失败 mock → 仍走 corrective resend → floor → 无内容 turn 仍 `failed`（现有行为不回退）。
- [x] `error-classifier` 单测扩展覆盖「api_error 流信号 → connection」，且「未知 → deterministic」缺省不变。
- [x] `bunx tsc --noEmit` 通过；`bun test` 相对基线不回退。

## 约束

- 不执行任何 git 命令；只编辑文件。
- 不做版本号变更、不重建 `plugin/scripts/*.cjs`（stale-bundle 守卫 1 fail 是预期基线）。
- 不触碰 `~/.claude-mnemo` 下的任何线上数据。

## Comments

- `classifyWorkerError` 现把流上的 `system/api_error` 与 assistant `server_error` 识别为 connection；未知流错误仍默认 deterministic。
- work-unit 暂存连接流信号，并在 corrective resend、fresh-session 与 derailment floor 之前抛回既有 `suspendSessionAfterConnectionError` 链。
- 验证：`bunx tsc --noEmit` 通过；`bun test` 为 960 pass / 1 fail，唯一失败仍是预期的 stale-bundle guard。
