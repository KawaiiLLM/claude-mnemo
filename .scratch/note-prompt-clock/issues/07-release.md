# 07 — 发布工程

**What to build:** 全部功能票合入后的发布机械:版本号多站点同步 bump(package.json、marketplace 清单 ×2、plugin 清单、SDK query 版本常量 ×2、release-artifacts 守卫与其测试)、bundle 重建、发布校验。发布动作本身(push/tag)等用户明示「发布」。

**Blocked by:** 01、02、03、04、05、06 —— 全部功能票。

**Status:** ready-for-agent

- [ ] 旧版本号全仓 grep 零残留(json、tests、src 三域)
- [ ] bundle 重建且 release-artifacts 校验通过
- [ ] 全量测试绿
- [ ] commit 就绪;push 与发版等待用户明示
