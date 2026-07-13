# 10 — opus 复验冒烟（验证 08＋09）

**What to build:** 08＋09 落地后，在隔离副本上用生产默认模型 claude-opus-4-8 重跑一次 dream agent（同 2026-07-12），验证三个缺口已修复。由 reviewer 亲跑——codex 沙箱无 claude 登录态跑不了真 agent（首次冒烟即因 `Not logged in` 失败，最终由 reviewer 在本机环境跑通）。

**Blocked by:** 08, 09

**Status:** done（reviewer 亲跑 opus-4-8，五项全过；elapsed 388s）

用真实「继承基线」重跑：第一次冒烟已 `retireLegacyPersonaLayout` 删掉迁移源，直接重置只会退化成空文档 full-fill（测不到自清/降级）。改用第一次那份「开头即项目清单」的产物做种子（profile 6169B + experience 6245B + 空 archive + 无 marker），才真正复现票 08 场景。

- [x] 画像开头不再是工程项目清单——新画像首段为「沟通风格与思维习惯」，`## 基础信息（当前处境）` 项目清单整段消失；6169B→3139B，按「这个人是谁」重组
- [x] archive.md 收到降级条目——空→655B，「降级于 2026-07-12」4 条，各带原始 [S/T]，判据为偏工程/低人味
- [x] 无 10 分钟超时——elapsed 388s（6.5min），远低于新 30min 看门狗；success/EXIT=0
- [x] 日记仍然工程细节丰富、按项目、带 [S/T]——4 项目分段、第一人称、粗体里程碑、envelope 冲突/崩溃窗口/单例/成本数字全留、通篇 [S/T]
- [x] 全程隔离，live ~/.claude-mnemo 未被动——live memory `*.md` 前后均 0 个；冒烟驱动结构上只写 /tmp 隔离路径
