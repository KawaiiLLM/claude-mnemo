# 05 — 提取提示词与校准包

**What to build:** 提取端的评分与写作纪律升级：rubric 六条修法（链条规则；G4 弧作用域起源义务——暂定、结算按弧规模确认；worked example；发布/派发反例与 eval-validity 正例；skip 不得只看工具数且 skipped turn 须给最小标题；等级落终稿不落草稿）；title=结论 ~10 token / desc=过程与证据 ~50 token、互不重复；强制引用类（supersedes/implements/紧邻允许）写入结构化 cites；校准块改造为 actual-vs-target（G4/G3/G2 ≈ 2/10/25、分母含 skipped 与 ungraded、样本 <30 不出百分比、G3 >15% 触发指名工件 before→after 举证门、删除密度警报）。完成后 fixture 提取产出新风格字段、cites 与暂定等级，校准块渲染可断言。

**Blocked by:** 01 — cites 引用基础设施。

**Status:** ready-for-agent

- [ ] 提示词含全部六条修法与 worked example；密度警报移除
- [ ] 校准块 actual-vs-target＋偏离举证门有纯函数测试（含 <30 样本分支与 15% 边界）
- [ ] skipped turn 产出最小标题；title/desc 措辞与不重复纪律入提示词
- [ ] 强制引用类入提示词并要求结构化 cites（可为空数组）
- [ ] 断言旧校准行为（raw counts、无百分比）的既有用例重写
- [ ] 全量套件绿＋rebuild

详见 spec §E 与 §A（校准提示）。
