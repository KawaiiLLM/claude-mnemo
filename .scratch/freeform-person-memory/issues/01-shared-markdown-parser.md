# 01 — 共享 markdown 解析模块

**What to build:** 一个无 IO 的纯函数解析模块，把 free-form markdown 文档切成节序列（节 = 标题＋层级＋正文行数组），供动态加载器（票 02）与 persona 校验器（票 05）共用——两处对同一文档必须产出同一节结构，禁止各自用正则。解析规则以 spec「可解析子集」为准：ATX 标题（`#{1,6}`＋空格）仅在 fenced code block 之外识别；引用块内的 `#` 不是标题；首个标题之前的内容视为一个无标题前言节；空节正文行数计 0。

**Blocked by:** None — can start immediately.

Status: done

- [ ] 解析模块为纯函数（输入文档字符串，输出节序列），不触碰文件系统
- [ ] 节模型含：标题文本（前言节为空）、标题层级、正文行数组
- [ ] 单测覆盖：fenced code 内 `#` 不识别为标题、引用块内 `#` 不识别、前言伪节、空节计 0 行、多级标题混排、无标题文档（仅前言节）、空文档
- [ ] `bun test` 与 `tsc --noEmit` 全绿

## 参考

- Spec：`.scratch/freeform-person-memory/spec.md`（「文档 schema 与维护原则」一节的可解析子集条款）

## Comments

- 实现：`src/shared/markdown-sections.ts`；测试：`tests/shared/markdown-sections.test.ts`。
