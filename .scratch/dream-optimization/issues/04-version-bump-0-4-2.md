# 04 — 版本 bump 0.4.2 + 重打包

**What to build:** 把本次三项行为变更收尾为一次可发布的补丁版本 `0.4.2`——按既有 7 处版本 bump 清单同步，重打包，使 `release-artifacts` 测试全绿、bundle 内嵌版本号一致。三项一起随 0.4.2 上线（批量发布）。

**Blocked by:** 01、02、03（三项行为全部落地后才收尾发布）。

**Status:** done — 12 处 0.4.1→0.4.2（package.json、plugin.json、marketplace.json ×2、diary-sdk-query 常量、release-artifacts 标题+5 断言、diary-sdk-query 测试断言），`bun run build` 重打包 `BUILD_ID 0.4.2-mrn3c70l`。896 pass / 0 fail，tsc 干净，stale-bundle guard 转绿，无残留 0.4.1。

- [ ] 7 处版本号从 0.4.1 同步到 0.4.2（package.json、marketplace.json ×2、plugin.json、diary-sdk-query 版本常量、release-artifacts 测试断言、diary-sdk-query 测试断言）。
- [ ] `bun run build` 重打包，`BUILD_ID` 前缀与新版本一致，无残留旧版本号。
- [ ] `release-artifacts` 全绿：版本一致性 + stale-bundle guard（源已改、bundle 已重打包）。
- [ ] 全量 `bun test` 与 `tsc` 干净。
