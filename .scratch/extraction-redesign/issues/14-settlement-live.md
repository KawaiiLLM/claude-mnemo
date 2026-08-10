# 14 — 结算上线

**What to build:** 切换的第二阶段（spec D9/D11，裁决 27）。把 `settlementEnabled` 打开，让已合入但一直暗着的结算机器进生产：{连续 50、compact} 两个触发器、段归属与成员边、type/tag 复核、session summary 维护、残留会话附带结算（含裁决 18/19 的阈值与 20 的中间洞补写）。timeline 在新 era 默认渲染段脊柱 + 孤儿锚点。

**Blocked by:** 09 — era 转正写路（没有正式笔记就没有可结算的窗口）。

**Status:** ready-for-agent

- [ ] `note_settlement_cursors` 在 era 边界初始化，结算不磨 era 之前的历史窗口
- [ ] 触发器恰为两个（连续 50 / compact），sessionEnd、resume、worker 启动、定时器一律不触发——测试断言 + 全库 grep 双重验证
- [ ] 段、边、type/tag、session summary、游标推进在单一成功事务内提交，带 job generation 校验
- [ ] 残留派发遵守 ≥20 阈值、不写终态标记；认领时先清空 pending，中间洞按裁决 20 补写并带结算侧 provenance
- [ ] 生产首个窗口人工验收：段粒度合理、引用抽查准确、开放段留 open 正确
- [ ] 全量测试绿
