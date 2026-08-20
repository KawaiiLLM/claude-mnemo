# 06 — ADR 与教学面收口

**What to build:** 决策史读起来是连续的:新 ADR 记录本批次的三个不可逆转向,旧
ADR 的被回收条款有显式指针;工具描述与 CONTEXT.md 与最终契约一致。

**Ruling base:** spec 全文;CONTEXT.md 已在 spec 阶段同步(Settlement 重写、
Backfill、Citation graph 三词条),本票核对不重写。

**Blocked by:** 01–05(契约定型后才写文档)。

**Status:** blocked

## Pinned decisions

- **Rubric 补撤边一行**(用户核准于 [S15069/T1130],逐字):`## 关系` 节末尾
  (发布仪式之后)加「- 撤边:发现边为伪时撤除,按需改写——撤除与改判同为判
  断行为,不为整洁而撤。」同步草案已改;`MEMORY_RUBRIC_TEXT` 照搬,hash 自重
  算,守卫测试随动。这是本票唯一允许的共享文本改动。

- 新 ADR 一份,记三个转向及其 trade-off:(1) 边与正文脱钩(回收 C7 双通道,
  含「为什么放弃正文锚与读被引检查」的诚实记述——C8 的语义伪边风险照旧存在,
  由 rubric 判断与撤边纠错承担);(2) 多关系对 + 硬删撤边;(3) 结算重武装
  (显式回收 settlement-agentic 的「结算不再重建笔记」与 C7 先存栅栏,ADR-0007
  相应补注指向本 ADR)。
- 工具描述清扫:note 的关系参数 describe 删 C7 语言、加撤边参数教学;recall 描
  述不动(完整读教学是 write-mode 批次的,与本批无关)。
- CONTEXT.md 三词条核对与最终实现一致,措辞偏差回来报告,不静默改。
- 报告明确:签入 bundle 需发版重建;在 rebuild + /plugin 更新 + 冷重启前,线上
  插件仍教旧契约(2× 硬拒、C7 共现、25 窗)。
- spec 的挂起区(D10)在 ADR 里留一句指针,防止后来者以为计分现状是终态。

## Acceptance criteria

- [ ] 新 ADR 覆盖三转向,每个含被回收裁决的出处指针;ADR-0007 补注就位。
- [ ] 全仓 grep 无教学面存活的 C7 共现/先存栅栏/25 窗措辞(历史记述标 retired
      除外)。
- [ ] CONTEXT.md 三词条与实现一致。
- [ ] 报告含 bundle 重建窗口声明。
- [ ] typecheck 干净;全套绿,只余既定的陈旧包守卫红。

## Ground rules

- NO git write commands。报出改动文件清单,主会话提交。
- 不碰 `~/.claude-mnemo/`、`plugin/scripts/`、版本号;`src/` 只许描述文本级修
  改,逻辑不动。
- 不自行重建 bundle。
