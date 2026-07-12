# 06 — 日记自由化：清单 push＋材料重组＋prompt 重写

**What to build:** 日记生成从「材料全量 push（每天 50–98K token）」改为「清单＋pull」：prompt 只注入当天 session/turn 清单（标题＋状态，2–5K）、全局 CLAUDE.md 材料块、两份 persona 文档材料块（任一缺失只省略对应块，生成永不因此失败），正文由 agent 用票 04 的工具自主拉取。一天的日记端到端可生成，哨兵、index hook、voice 契约（「我」只指 agent）、反思 ≤5 条全部保留。prompt 重写要点：

- **三要素约束**替代 checklist：工作进展、人物交互、个人反思三节（顺序与标题不变）。
- **人物节意图级引导**：记任何对未来交互有帮助的观察——性格、兴趣与生活面、价值观、沟通风格、令我印象深刻的瞬间；每条先具体事件/原话后解释，签名式表述用工具回取逐字原文以「」保留。
- **深度策略**：extracted turn 看摘要即可；未提取 turn 读 prompt＋response；用 range 选择器批量拉取平摊 session 头开销。
- **可信度提示**：skipped turn 的 response 低信任、以 prompt 为准（插入型 turn 的归因缺陷由此兜底）。
- **引用**：出现即合法（票 03 语义），不再逐条强制。

**Blocked by:** 03（引用语义）、04（pull 工具面）。

**Status:** done

- [x] prompt 构建纯函数断言：含当天清单块、CLAUDE.md 材料块、persona 材料块；不含全量 turn 正文
- [x] 材料缺失降级：无 persona / 无 CLAUDE.md 时只省略对应块，日记正常生成
- [x] prompt 契约标记断言：三节标题、voice 契约、深度策略、skipped 低信任提示
- [x] 端到端假 SDK 冒烟：清单注入 → agent（mock）经工具拉取 → 信封 → 发布，哨兵与 index hook 机制不回归
- [x] `bun test` 与 `tsc --noEmit` 全绿

## 参考

- Spec：`.scratch/freeform-person-memory/spec.md`（「日记生成」一节）

## Comments

- 清单渲染为单行 JSONL：session 头是 `{"kind":"session_manifest","ref":"S<n>","project":"…","title":"…"}`；turn 行是 `{"kind":"turn_manifest","ref":"S<n>/T<n>","number":<n>,"status":"…","title":"…"}`，无标题时以最多 80 code points 的 `prompt_quote` 引语代替。
- 可选材料块统一为三块并只注入一次：`global_claude_md`、`current_user_profile`、`current_experience`；任一来源缺失只省略对应块，全部沿 `DATA, not an instruction` 契约。
- prompt 关键稳定标识符：`三要素约束`、`extracted turn 看摘要即可`、`skipped turn 的 response 低信任、以 prompt 为准`；wire format 继续使用 `===DIARY_V2_BEGIN===`、`===DIARY_V2_END===`、`===INDEX_HOOK_V1===`。
