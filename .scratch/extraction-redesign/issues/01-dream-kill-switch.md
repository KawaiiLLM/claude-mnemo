# 01 — dream 停运旗标（P0）

**What to build:** 一个 config 旗标关停 dream agent 整条链路。旗标关闭时，dream 的**全部三个独立入口**（R2#P2-1）都不入队、不执行、不重试；开启时行为与现状完全一致。reload 后生效。P0 裁决：默认关闭。

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] 旗标关闭时，三个入口均无 dream 作业入队或执行（含重试路径与 backlog 回扫）
- [ ] 旗标开启时现有 dream 测试全绿，行为无差异
- [ ] diary index / persona 注入在停运期继续以末次生成态工作（冻结可读）
- [ ] spec D12·P0 的「非零码」承诺兑现：改动仅旗标 + 门控判断，无其他逻辑变更
