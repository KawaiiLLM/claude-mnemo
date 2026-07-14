# 05 — 版本 bump 0.4.1 + 重打包

**What to build:** 把本次行为变更收尾为一次可发布的补丁版本 `0.4.1`——按既有 7 处版本 bump 清单同步，并重打包，使 `release-artifacts` 测试全绿、bundle 内嵌版本号一致。

**Blocked by:** 01、02、03、04（所有行为落地后才收尾发布）。

**Status:** done — 7 处 0.4.0→0.4.1（package.json、marketplace.json ×2、plugin.json、diary-sdk-query 常量、release-artifacts 测试标题+5 断言、diary-sdk-query 测试断言），`bun run build` 重打包。全量 885 pass / 0 fail，tsc 0，stale-bundle guard 转绿。

- [ ] 7 处版本号从 0.4.0 同步到 0.4.1（package.json、marketplace.json ×2、plugin.json、diary-sdk-query 版本常量、release-artifacts 测试断言、diary-sdk-query 测试断言）
- [ ] `bun run build` 重打包，`BUILD_ID` 前缀与新版本一致，无残留旧版本号
- [ ] `tests/shared/release-artifacts.test.ts` 全绿（版本一致性 + stale-bundle guard）
- [ ] 全量 `bun test` 与 `tsc` 干净
