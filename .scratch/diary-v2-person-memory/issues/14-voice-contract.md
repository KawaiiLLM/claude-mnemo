# 14 — 人称契约与语义准入收紧

**What to build:** 修复冒烟发现的人称混同：日记与 persona 的「我」一律指 agent，用户一律称「用户」，用户画像改第三人称——防止注入后 agent 把用户特质误认成自己的人设。连带钉死三个语义瑕疵的 prompt 规则。

**Blocked by:** 13。

**Status:** done

冒烟证据（真实数据首跑）：日记人物节把用户行为写成「我拒绝了…建议」；fold 后用户画像五节全部以「我」自述；注入端 agent 将误读。sakiko 先例 = 正解：agent 第一人称 + 用户第三人称分离。

- [ ] **日记 prompt 人称规则**：「我」= agent（日记是 agent 的日记）；用户一律写「用户」；工作节协作叙事用「我帮用户…」「用户要求…我…」；人物节以第三人称观察用户（「用户拒绝了…」）；反思节保持 agent 第一人称
- [ ] **persona prompt 人称规则**：user-profile 全文第三人称（「用户…」），禁止「我」；experience 的「我」= agent 的经历视角，用户称「用户」
- [ ] **语义准入三条**：项目首行印象句是概括、不得与任何印象 bullet 重复表述（同引用复用允许，措辞须概括级）；`反馈：` 只装协作纠正/教训（设计决策归印象或进度）；`进度：` 只装状态，不混成本估算等旁支事实
- [ ] **canonical fixture 同步**：diary 与 persona 示例改为人称分离形态（含「用户」字样）；contract 测试断言 prompt 含人称规则关键句、user-profile fixture 无「我」、diary fixture 人物节以「用户」开头
- [ ] 重建 bundles；全量 `bun test` 0 失败；`bunx tsc --noEmit` 通过

## Comments

- 2026-07-12 双轮真实冒烟验收：日记 17 bullet 零删除，人物节全部「用户」第三人称，反思节为真实 agent 教训；persona attempt 1 超预算（1540/1400）触发结构化反馈，attempt 2 收缩达标发布，operation 清零。人称契约与重试反馈机制均经真实 LLM 验证。
