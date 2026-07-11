# 09 — 发布 0.3.0

**What to build:** 版本收口：全部版本位一次跳到 0.3.0 并被同一守卫测试锁住（含此前漏网的 SDK MCP server 硬编码常量），产物重建，全量测试绿。

**Blocked by:** 02、03、04、06、07、08（全部实现票）。

**Status:** done

- [ ] 版本 0.3.0 落五处：package.json、.claude-plugin/marketplace.json（metadata + plugins[0]）、plugin/.claude-plugin/plugin.json、tests/shared/release-artifacts.test.ts（断言 ×4 + 标题）
- [ ] SDK MCP server 的硬编码版本常量改 0.3.0 并纳入 release-artifacts 守卫
- [ ] 重建 plugin/scripts/*.cjs 产物（BUILD_ID 行时间戳漂移属正常，不视为脏）
- [ ] 全量 `bun test` 绿
- [ ] 开发机旧 diary/persona 数据清理一句话说明（CHANGELOG 或 README；无迁移逻辑进产品代码）
