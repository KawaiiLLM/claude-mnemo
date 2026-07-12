# 02 — 动态加载器＋会话注入接线

**What to build:** 会话启动时注入的 persona 块不再是全文，而是经动态加载器渲染的「全部标题＋每节前序行」视图：主会话 agent 看到文档骨架与每节最重要的前几行，被截断的节尾带「（本节还有 N 行，完整见 <绝对路径>）」指针行，可自行 Read 全文。加载器为纯函数 `(文档文本, 注入预算, 展示路径) → 注入块`，用票 01 的解析器切节；算法先预留强制骨架（全部标题＋最坏情况每节一行指针），剩余预算按文档顺序装填正文前序行，全装入的节不输出指针行。骨架超预算时确定性降级：先降为顶层标题＋一行文档级指针，再降为单行「（<文档名> 过大，完整见 <路径>）」下界——永不报错。注入预算为独立常量（两文档合计初值 2500 token），与发布预算解耦。fold 的编辑对象输入不经加载器，永远全文。

**Blocked by:** 01 — 共享 markdown 解析模块。

**Status:** done

- [x] 加载器单测：预算内全量（无指针行）、超预算截断＋指针行＋N 计数正确、无标题文档、空文档、单节超预算、骨架超预算降级为顶层标题＋文档级指针、极小预算降级为单行下界
- [x] 会话注入链路改走加载器（user-profile 与 experience 各一块），替换全文渲染
- [x] fold/rebase/rebuild 的 prompt 输入侧不受影响（编辑对象仍全文），既有假信封套件不回归
- [x] token 估算沿用现有 estimateDiaryTokens 口径
- [x] `bun test` 与 `tsc --noEmit` 全绿

## 参考

- Spec：`.scratch/freeform-person-memory/spec.md`（「动态加载器（新纯函数）」一节）

## Comments

- 加载器实现：`src/diary/persona-render.ts` 的 `renderPersonaDocumentInjection`；SessionStart 注入接线：`src/hooks/handlers/context.ts` 的 `appendDiaryContext`、`renderBoundedPersonaBlock` 与 `renderBoundedExperienceBlock`。
- 注入预算常量：`PROFILE_INJECTION_TOKEN_BUDGET = 1_000`、`EXPERIENCE_INJECTION_TOKEN_BUDGET = 1_500`、`PERSONA_INJECTION_TOKEN_BUDGET = 2_500`（两文档合计）。
