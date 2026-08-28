# 里程碑选举盲标研究 — 报告

2026-08-28。研究 agent 执行（Opus，判断外包给三名互不通气的新判官），审阅者落盘。
原始产物同目录：`labels.tsv`（80×35 特征+标签）、`labels-validation.tsv`（40 条
out-of-sample 盲验证）、`protocol.md`（标注协议）、`analysis.txt`/`simulation.txt`
（统计原始输出）、`extract.ts`/`sample.py`/`analyze.py`/`simulate.py`（可重跑）。
生产库全程只读，src/ 零改动。

## 方法与地雷对策

标注问题："一个半年后回来接续这个任务的 agent，第一屏索引里需要这一行吗？"
MUST / USEFUL / NO，MUST 配额 ≤25%（实测 20/80 = 25%，压线）。

- 带内评分 null result（93-100% 同分）→ 禁 rubric 打分，只用三值标注 + 配额纪律。
- 判官泄漏 ×2 → 盲标只见 title+content+insight 且统一截断；图特征、当选结果、
  长度全部不可见；协议先写死后机械执行。
- 执行偏离（比原设计更强）：研究 agent 本人已见过两张真卡，故标注全部外包给
  三名禁读仓库/禁查库的新判官；分析者与标注者硬隔离。
- 一致性改为 inter-rater（第二判官重标 20%）：精确 13/16=81%，MUST-vs-其余
  14/16=88%，翻转全在 USEFUL 与邻值之间，无 MUST↔NO 对穿。

## 头条数字

- 现行选举 vs MUST：**precision 0.29 / recall 0.40**（E60、E70 各自相同；
  TP=8 FP=20 FN=12）。未当选者 MUST 率 0.23 vs 当选者 0.29 —— 富集仅
  **1.26×，n=80 下与噪声无异**。
- 放宽到 MUST+USEFUL：precision **0.93**。卡不塞垃圾；它只是没把稀缺席位
  优先给不可再生的判断。

## 真正区分 MUST 的特征（有 vs 无）

1. **`type` 含 `design`：0.67 (16/24) vs 0.07 (4/56)** — 全表最大落差；选举
   完全没读 type。反向：research 0/15、fix 0/9、review 1/16。
2. **入度按词分解**：narrows 0.55 (6/11)、verifies 0.50 (5/10) vs
   **extends 0.27 ≈ 基线** — 等权入度用信息量最低、数量最多的词
   （E60 extends 466 vs verifies 57）稀释最高的词。
3. **标题含用户裁定痕迹：0.50 (6/12) vs 0.21**。
4. **extends 链深 ≥5：0.14 vs 0.27 — 链长与重要性反向**。
5. **五个 tier 判据全部贴 25% 基线**（①0.25/0.25、③0.23/0.26、⑤0.21/0.28）。
   身份分档在测"谁被写过边"，不是"谁重要"。

机械层两条（全语料）：E60 有 235 条候选排在 tier④ 之前而席位仅 66 ——
**E60 的卡结构上坐不进任何一条 corrector**（实测当选档位 {②33,③22,①11}，
④⑤为 0，E60 有 88 条 tier④）。全语料入度 max=7、93% 在 0-2 —— 档内
"入度降序"几乎全同分，**事实主键是 recency**：当年带内评分"93% 同分让
次级键接管"的失效模式在机械层原样复发。

## backfill 假阳性类判决

落座机制不是链入度，是 **tier③ 提拔**：收口行 T1888 的 indexes 扇出把
T1876/77/82/83 整批提进 tier③。判官判决：T1877/T1883/T1885/T1855 全 NO
（混洗盲评），同形 E70 T688/T721 也 NO — T721 入度 4，样本内最高档。而同为
tier③、入度 3 的 E70 T294（HARNESS_SPEC v2）被判 MUST 且未当选。
**分开它们的是 type（ops/delegate vs 含 design）+ 标题语法**
（`Job \d+`/dispatch/backfill 的"派发播报"形状 vs "裁定/定版"形状）。

## 假阴性

12 条 MUST 被拒，9 条含 design。三条假说查证：

- **用户裁定 turn 无入边 — 成立**。E60 有 257 条裁定标题（15%），77% 落
  tier⑤，仅 10 条当选。裁定行是**图的源点**：它开启工作而非总结工作，
  没人 indexes 它，它也不写 indexes —— 每一档判据都要求"已被写过边"，
  对源点系统性失明。
- override 跨 session 失效 — **不成立**（全库 256 条 override 全同 session；
  corrector 丢失纯因档位挤占）。
- 关闭问题的 measure — 成立但稀有（1 条）。

## 提案（对现行 tier 的 diff）

- **D1** 加权入度替换等权：`2*(narrows+verifies+indexes) + 1*(grounds+consume)
  + 0.5*extends`（顺带修复同分-recency 接管）。
- **D2** 新增「决策档」插在 ②③ 之间：`type∩{design,correction}≠∅ AND
  (out_override≥1 OR 标题匹配裁定 pattern)`；corrector 升到
  indexed-by-elected 之前（依据：E60 结构性零 corrector，定性缺陷）。
- **D3** 派发形状降档：标题 `/\bjob \d+|dispatch|backfill/i` 且
  type⊆{ops,delegate,implement,review,measure} 且无发版标记 **且非 tier①/②**
  （末门必须——否则误伤收口行 T1888、E70 T219）。
- **D4** 档内主键 = 加权入度。

**预测**（席位 K 不变）：E60 old 35 席动 2、E70 old 38 席零变化；改动集中
recent 侧 —— E60 recent：ops 65%/派发 9 席 → design 55%/派发 1 席，裁定行
4/31 → 22/31；E70 recent：design 33%→62%。五条 backfill 全落，T1888 保住。

**Out-of-sample 盲验证**（第三判官，40 卡两臂混洗）：
提案新增臂 MUST 35% / NO 0%；提案剔除臂 MUST 15% / NO 25%（其中 3 条 NO
正是 backfill 链）。全研究唯一未用训练标签评估的一处。

## 样本量定不了的事

1. 端到端增益未测出（A 通道落 recent 侧样本太少）；要发布级结论需 recent 侧
   再标 60-80 条。
2. **type 与标签不独立**（同段文本产出，"design 预测 MUST"部分同义反复）；
   价值在"已落库而选举没读的廉价代理"。
3. 一致性是 inter-rater 下界，三判官同族同代，共享盲区测不出。
4. **type 可信度未验**：本项目有 grading drift 前科，落地 D2 前应抽查 07 月
   vs 08 月两窗口的 design 语义一致性。
5. **边覆盖率混杂**：E60 08-15 周 666 turn 仅 54% 有边当选 15，08-22 周 79%
   有边当选 45 —— 席位分布部分反映"这窗口结算到了没有"。D2 不依赖入边，
   只能部分缓解。
6. 未调：extends 权重 0.5 仅有方向性支撑；corrector 位次 n=5 不足定论。
7. 未测：tags facet、insight 质量、E60/E70 之外的 segment。
