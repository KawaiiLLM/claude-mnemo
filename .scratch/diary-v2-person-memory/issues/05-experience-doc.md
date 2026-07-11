# 05 — persona 产物切换 experience.md

**What to build:** persona fold 产出 user-profile.md + experience.md 双文档（self.md 退役），经历文档承载项目条目（路径/进度/反馈/印象）与通用桶；fold/rebase/rebuild 三算子的 prompt 按新准入与衰减规则重写并适配三节日记输入。假 runPersona 喂新 envelope 可发布完整世代。

**Blocked by:** 01 — 日记 v2 格式与删除制（三节名与引用组定义）。

**Status:** done

规范：`../spec.md`（「persona 文档」节；结构门与预算门在票 06，本票先落格式、命名与 prompt）。项目条目形态（模拟原型定案）：

```markdown
- **<语义项目名>**：一句话印象 [引用]
  - 路径：["/abs/path/a", "/abs/path/b"]
  - 进度：<恰一行，fold 时覆写不累积> [引用]
  - 反馈：<协作教训，分号连接> [引用]
  - [YYYY-MM] <印象事件> [引用]
```

- [ ] 哨兵 `===SELF_V1_*===` → `===EXPERIENCE_V1_*===`，双块同现规则保留；self.md → experience.md 全链路改名（世代文件、冻结输入、checkpoint、manifest；无兼容负担，直接替换）
- [ ] 封闭节校验（标题层）：user-profile 五节（身份与背景/专长与判断力/品味与兴趣/沟通风格/协作偏好）、experience 两节（项目/通用），顺序固定、不得增删；违规 = 操作失败重试
- [ ] 三算子 prompt v2：项目条目形态如上；进度行覆写语义；衰减规则（最弱印象向上合并进首行印象句再淘汰；通用桶按支撑最弱→最陈旧；长期项目归档形态 = 首行+路径行+`进度：已归档——<一句话>`）；准入规则（单事实 bullet、诊断性/元观察禁入、跨项目教训归通用桶、双写允许同文件去重、强化特质追加引用、矛盾标（已变化）、源路径命中既有条目必须并入）
- [ ] persona 输入的可信素材裁剪逻辑适配三节日记（原「未决与杂记」剔除规则更新）
- [ ] tests/worker/persona-maintenance.test.ts、tests/diary/file-store.test.ts 更新并全绿
