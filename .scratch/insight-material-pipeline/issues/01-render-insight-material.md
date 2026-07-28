# 01 — dream 素材渲染 insight（B）

**What to build:** dream 每晚素材在 extracted turn 上渲染非空 insight——dream agent 不经额外工具调用即可看到当天全部机制级教训。insight 走既有字段处理链：隐私剥离、每字段 200 token 预算截断、内部 `[T<n>]` 引用改写为 `[S<n>/T<m>]`（引用收集的扫描范围从 title/content 扩到 insight）。空/NULL insight 不渲染该键；非 extracted 分支输出与现状一致。

**Blocked by:** None — can start immediately.

**Status:** done (2026-07-28, codex; 验货通过)

- [ ] 非空 insight 的 extracted turn → 渲染输出含 insight 键，内容经隐私剥离、截断与引用改写
- [ ] 空/NULL insight → 输出不含该键
- [ ] 超预算 insight → 按 200 token 截断
- [ ] insight 内 `[T<n>]` → 改写为 `[S/T]`，引用收集扫描含 insight（title/content 无引用、仅 insight 有引用时也能解析）
- [ ] 非 extracted 分支（active/skipped 等）输出逐字节不变（回归测试）
- [ ] 全量 bun test 绿（HOME 沙箱内）
