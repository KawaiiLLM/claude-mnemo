# 09 — 结算顺手维护 session 叙事

**What to build:** 每个结算窗后 session 的 title/content 增量更新;note 的 session 面退役。

规范:`.scratch/ownership-and-note-cadence/spec.md` session 字段节([S15069/T913]);ADR-0006 推翻注记(peer 发现 2)。

- 结算提示新增叙事职责:`content` = 对话弧的增量叙事(发生了什么,**非任务状态**);`title` 首窗定值、后续极少改;同一 staged-commit 落库。
- note 的 session 地址入口移除(定义与处理器)——session 无主 agent 写者,三层写者各归其位(turn/段=主 agent,session=结算)。
- ADR-0006 正文标 superseded(title-only、主 agent 懒写已被 [S15069/T910]–[T913] 推翻)。

**Blocked by:** 05(结算提示与通道)。与 01/04 有 definitions/注入的文件亲和,派工同线程规避,非逻辑依赖。

**Status:** ready-for-agent

- [ ] 窗口结算后 content 含该窗叙事增量;title 为空时被定值
- [ ] note(session) 调用被拒,报文指向结算写者
- [ ] ADR-0006 带 superseded 注记
