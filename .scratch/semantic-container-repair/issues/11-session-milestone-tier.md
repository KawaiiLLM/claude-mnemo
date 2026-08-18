# 11 — 纪元启用后，会话视角的里程碑会变空

**What to build:** 会话视角的里程碑接纳 tier，否则选举一启用，会话时间线就看不见任何新 turn。

**证据：** `src/mcp/timeline.ts:924-937` 的 `milestoneEffGrade` 只读 `significanceGrade`。新纪元 turn 的 grade 为 NULL → effGrade 0 → 低于脊柱阈值（≥3）与候选池阈值（≥2），见 `:1709-1712`。只有段视角读 tier（`:3790`）。

**后果链：** 纪元一旦钉值（票 01），会话视角的里程碑将不再包含任何新 turn——**包括结算自己使用的「Session arc so far」**（`src/worker/note-settlement-context.ts:332`）。也就是说结算 agent 会失去它赖以判断任务因果的弧线。

**文档：** 静默。spec:116 只钉了**段**视角的里程碑准入，没有任何条目为会话视角的 grade 消费者重新安家。这是纪元切换时被漏掉的一条接缝。

**Blocked by:** 01（钉值前不显形；但必须与 01 同批发布，否则发版当天就断）

**Status:** ready-for-agent

- [ ] `milestoneEffGrade` 在选举纪元下把 tier 映射为等效分数
- [ ] 纪元钉值后，会话视角里程碑仍包含新 turn
- [ ] 结算上下文里的会话弧不为空
- [ ] 旧纪元 turn 的渲染字节不变
