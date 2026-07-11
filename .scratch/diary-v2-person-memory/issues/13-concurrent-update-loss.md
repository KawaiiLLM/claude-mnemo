# 13 — 并发更新丢失修复（pending 凭据清除 + rebuild epoch）

**What to build:** 修复两类「旧 operation 发布覆写运行期新状态」的竞态（同日重结算的 pending 标记被吞、新 rebuild 请求被清），以及 partial_missing 继承语义、90 天边界、bundle 字节级守卫三个 Important。

**Blocked by:** 12。

**Status:** done

- [ ] **B1 pending 凭据清除**：operation 冻结每个 pending 日期的 watermark + file_sha256；提交清除用 `WHERE date=? AND watermark=? AND file_sha256=?`——同日新版本（新 watermark/hash + 重新置 pending）不被旧 operation 清零；测试「batch 1 后同日重新结算 → pending 保留」
- [ ] **B2 rebuild epoch**：`rebuild_requested` 布尔升级为单调递增 epoch（请求值/确认值）；operation 启动冻结 epoch，发布（正常 + 崩溃恢复两条路径）只确认冻结 epoch，晚于它的请求保留；测试「batch 运行期间新请求 → 发布后仍在」
- [ ] **I3 partial_missing 继承**：fold 原样继承 baseline manifest 的 partial 集合；rebase 仅移除本次确实吸收的日期；rebuild 用启动时冻结的 rebuild-gate 快照；测试「partial bootstrap 后普通 fold 不抹掉未恢复的 terminal 日期」
- [ ] **I4 90 天严格边界**：最老 pending「早于」90 天才升级 rebuild（严格 `<`，即 91 天升级、90 天不升级）；测试 89/90/91 三点
- [ ] **I5 bundle 字节守卫**：release-artifacts 测试构建到临时目录，剥除 BUILD_ID 行后与 checked-in bundles 做字节/hash 比较——marker 字符串存活但周围逻辑变化的旧 bundle 也会被发现
- [ ] 重建 bundles；全量 `bun test` 0 失败；`bunx tsc --noEmit` 通过
