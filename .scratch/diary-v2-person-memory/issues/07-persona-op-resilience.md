# 07 — persona operation 韧性

**What to build:** CURRENT 或世代文件在任何时点损坏都能自愈：读取入口检出损坏即调度 rebuild；进行中的多批 operation 凭启动时冻结的代次字段照常完成发布，不因 live CURRENT 损坏而 terminal 或代次回退。

**Blocked by:** 05 — persona 产物切换 experience.md。

**Status:** done

规范：`../spec.md`（「persona 文档」节的自愈条款）。

- [ ] operation 状态启动时持久化 `base_generation` 与 `target_generation`；恢复与最终发布只依赖冻结字段 + checkpoint/input hash，不读 live CURRENT
- [ ] CURRENT/世代文件在任何读取入口（注入、日记素材装载、操作基线装载）解析/哈希失败或超已发布预算 → 一个事务内置 `rebuild_requested=1`，本次消费按缺失处理
- [ ] 用例：批 1 成功后人为损坏 CURRENT，批 2 凭冻结字段仍成功发布且代次不回退
- [ ] rebuild 标志仅在成功发布后清除；调度沿用既有 wake 尾检查
- [ ] tests/worker/persona-maintenance.test.ts、tests/hooks/context.diary.test.ts 补齐用例并全绿
