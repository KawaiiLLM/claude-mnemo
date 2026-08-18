# 10 — 文档收尾

**What to build:** 词表、ADR 与两份 spec 对落地状态对齐。

- CONTEXT.md:Settlement 词条=四字段检查纠错+会话叙事;Election 词条退役;note 词条去 session title;新增**序数 T vs 地址 T**的区分([S15069/T921]:段内 T 序数只作选择,`Sxx/Txx` 是唯一引用形式)与 ops 词义(交付+运维,[S15069/T928])。
- ADR-0004 flagging 半边退役注记([S15069/T906])。
- 两份 spec 标 implemented;十票 Status 核对。

**Blocked by:** 06、08、09(全部实现落地后)。

**Status:** done

- [x] 词表五处更新 — Settlement 改四字段纠错+会话叙事、Election 标 retired、note 去 session title、新增 Addressing 小节(地址 T vs 序数 T)、ops 词义入 Judging;头部纪元行更新到 ADR-0007
- [x] ADR-0004 注记 — Status 行 amended + 正文 Amendment 节:flagging 半边随 T906 退役,citation floor 独存
- [x] 两份 spec 与十票状态一致 — 两 spec 各加 implemented 状态行(边 spec 注明消费侧归视图 spec);票 01–09/11 均 done,本票随本次提交闭合
