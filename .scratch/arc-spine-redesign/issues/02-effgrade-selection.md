# 02 — effGrade 词典序选择与拉入

**Status: done** — 见 feat(selection) 提交（含 codex 审查轮 3 项修复、mutation 验证；门禁 1320/0）。给 03 的两个接缝注意：`ranked` 与 `pulled` 在 G2 带上**不相交集**（渲染器必须去重否则双渲染）；overflow 的 firstPrompt/lastPrompt 是稀疏隐藏集的 min/max、不是连续区间。

**What to build:** 里程碑选择改为等级主轴：effGrade 真值表（era 门控修复——基础分与内容分同门控，legacy 按 type 映射封顶 G3、永不为锚）＋六步优先级（受害降级先于 corrector 晋升 → always-keep → 脊柱准入 effGrade≥3 → 拉入 → 预算排序）＋supersedes 边直接派生受害降级与反链数据（不再依赖 rolled-back tag 前置）＋拉入集计算（被脊柱引用的 ≤G2 与 skipped turn）＋删除 type 基础分表/tag-family 权重/files 空守卫/日预算常数族。完成后 fixture 会话（覆盖 era 边界、corrector-as-victim、被引用 skipped、legacy 端点）的 kept/pulled 集逐一可断言。

**Blocked by:** 01 — cites 引用基础设施。

**Status:** ready-for-agent

- [ ] 真值表与六步优先级按 spec §C 实现；存量 761 条 legacy 等级不再直接进基础分
- [ ] supersedes 边派生受害降级＋反链数据；tie-break 维持现有次序（分数→工具数→更早 prompt）
- [ ] 拉入集含被引用 skipped（新数据最小标题、存量 ≤60 字符 prompt 前缀伪标题）；era 前经行内适配器
- [ ] compact 退出 always-keep 与 kept 槽位
- [ ] 对抗用例：era 边界 effGrade、corrector-as-victim、legacy 端点紧凑保留、G0 corrector 晋升、被推翻 G4 落锚于 corrector
- [ ] 全量套件绿＋rebuild

详见 spec §C。
