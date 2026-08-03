# 04 — SessionStart 注入切换

**What to build:** SessionStart 的 milestones 段改为弧视图调用结果：titleCap=100 字符与 tokenBudget=2500 为注入内部参数，超预算按票 03 的降级阶梯砍单元；删除现有四档静默降级（80→50 REDUCED）与渲染后字符串手术。state/recent/digest/persona/rules 四段及其触发矩阵（resume/compact 分支）逐字节不变。完成后长会话 fixture 的注入输出可对照：预算内、全保真行、被砍的是低分单元而非所有标题。

**Blocked by:** 03 — 统一行渲染器与单元预算。

**Status:** ready-for-agent

- [ ] 注入 = 弧视图渲染；REDUCED 路径与字符串手术零残留（grep 无 REDUCED_PROMPT_CAP）
- [ ] 超预算时低分单元先 desc→title 再移除；标题不再被降到 50 字符
- [ ] 注入矩阵测试：其余四段与触发行为逐字节不变
- [ ] 旧四档阶梯测试删除、新预算用例替代
- [ ] 全量套件绿＋rebuild

详见 spec §D（注入矩阵范围）。
