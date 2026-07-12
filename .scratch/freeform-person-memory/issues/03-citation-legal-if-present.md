# 03 — 引用「出现即合法」＋校验报告 v2

**What to build:** 引用校验从「逐条强制＋违规删 bullet」改为「出现即合法＋违规剥除标记」，先在日记管线端到端生效：一份含非法引用的日记信封进来，产出的是剥除了非法引用标记（内容行保留）的日记文本＋一份 v2 校验报告，且不再有任何引用类的重试路径。判定与剥除语义：语法合法且指向真实 turn 才算合法引用；剥除粒度到组成员——混合组（如 `[S1/T1，T2]`）中非法成员单独移除，全员非法则剥除整个组标记；语法不合法的 citation-like 方括号文本不识别、不处理。报告 v2：计数语义从 0.3.0 的「删除的 bullet」改为「剥除的引用」，条目记录定位（节＋行）与被剥除的原文，沿用 0.3.0 报告的存放机制并升版本号；persona（票 05）复用同一工具函数与报告版式。同时定义并落实 index hook 确定性回退在新语义下的触发条件（建议：剥除不再触发回退——内容行未删，hook 概括仍成立；若采纳不同决定，在票内 Comments 记录理由）。

**Blocked by:** None — can start immediately.

Status: done

- [x] 剥除工具函数单测：混合组成员级剥除、全员非法剥整组、语法畸形方括号不处理、指向不存在 turn 的合法语法引用被剥除
- [x] 报告 v2 版式落地（版本号、剥除计数、节＋行定位、原文），存放机制与 0.3.0 相同
- [x] 日记管线端到端：含非法引用的信封 → 剥除后文本＋报告；内容行不被删除；无引用类重试
- [x] 0.3.0 的「删 bullet＋降级」代码路径移除
- [x] index hook 回退条件在新语义下定义并有测试锚定
- [x] `bun test` 与 `tsc --noEmit` 全绿

## 参考

- Spec：`.scratch/freeform-person-memory/spec.md`（「日记生成」引用条款＋「校验报告升版」条款）

## Comments

- 实现位置：共享语法解析与成员级剥除在 `src/shared/citation-validation.ts`；日记节/行定位与管线适配在 `src/diary/domain.ts`；真实 turn allow-set 从数据库全部现存 turn 构建，日记发布与报告沿用 `src/worker/diary-job.ts` → `diary_state.validation_report_json` 的既有存放链路。persona validator 及其调用链未改动。
- 报告 v2 字段：`version: 2`、`total`（识别到的合法语法引用成员数）、`stripped`（因无法解析到真实 turn 而剥除的引用成员数）、`items[]`（`section`、1-based 日记正文 `line`、`original`）。全员非法时 `original` 记录整个原始组；混合组时记录被移除的成员原文。
- hook 决定：引用剥除不触发确定性回退，始终保留 agent 的 index hook。理由是新语义不会删除内容行，hook 所概括的内容仍存在；`tests/diary/domain.test.ts` 与端到端 job 测试已锚定该行为。
