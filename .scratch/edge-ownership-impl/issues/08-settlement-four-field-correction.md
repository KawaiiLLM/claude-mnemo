# 08 — 结算的四字段检查纠错

**What to build:** 结算窗按 rubric 复核 type/tags/归属/边,经 staged-commit 纠正。

规范:`.scratch/ownership-and-note-cadence/spec.md` 所有权节([S15069/T912]/[T926]);`.scratch/turn-edge-mechanism/spec.md` 校验表=边 rubric。

- staged-commit 通道扩展四种修正:**type**(词表+减法槽位契约)、**tags**(命名空间规则)、**边**(关系×阶段合法性;可补漏边、纠错关系)、**归属**(复用 02 的搬家原语;值域=该会话已挂靠段 ∪ 无归属,越界拒绝并报出该段不在挂靠集合,[S15069/T913])。
- rubric 文本进结算提示,各自引用其源;纠错是**复核不是首写**——无可纠时窗口空手完成(05 已立)。

**Blocked by:** 01(边词表)、02(搬家原语)、05(腾空的通道)。

**Status:** ready-for-agent

- [ ] 四字段各一条「错 → 纠 → 落库」端到端测试
- [ ] 归属越界(未挂靠段)拒绝并报出
- [ ] 错挂 turn 纠成 homeless 后原段 facets 不计入(与 02 的 fixture 同源断言)
- [ ] 空手窗口正常完成
- [ ] 边纠错走票 01 的同一共享校验器(同模块同常量);合法/非法阶段对在结算路径各测一例,与 note 路径镜像([S15069/T939])
