# 05 — persona free-form：校验松绑＋fold prompt 重写＋预算放宽

**What to build:** persona fold/rebase/rebuild 产出 free-form 双文档并全生命周期通过：agent 可自由组织标题与节内格式，校验器只把关解析契约。具体：

- **校验器松绑**：删除固定标题清单检查与逐条 bullet 强制引用；结构底线改为「经票 01 解析器至少解析出一个标题节」；保留信封哨兵与发布预算；引用校验接票 03 的「出现即合法＋成员级剥除＋报告 v2」。
- **预算放宽**：发布预算 profile 4000 / experience 6000（含随动的 accumulator 上限）。
- **prompt 重写**：七个建议维度（基础信息含当前处境/兴趣与文化/知识与技能/性格与行为模式/价值观与思想立场/个人偏好/重要经历带日期，明确可自由增删改）＋四条维护原则（有用/可读/可溯源/主动删除过时）＋加载器契约（注入只取每节前序行：特质类按重要性降序、时间线类最新在前）＋跨节写作规则（先事件原话后解释、签名句「」逐字、重要经历带日期）＋两文档分工（进行中项目进 experience、画像留沉淀特质与定格事件）。
- **材料**：全局 CLAUDE.md 由 worker 预读作为材料块注入（缺失省略块）；工具面用票 04 的三件，rebuild 请求下 read_doc 不可见 persona/。

**Blocked by:** 01（解析器）、02（加载器契约文本以其为准）、03（引用工具与报告）、04（工具面）。

**Status:** done

- [x] free-form 信封通过 fold/rebase/rebuild 全生命周期假信封套件；旧五节格式信封仍通过（free-form 是超集）
- [x] 缺标题信封拒绝；超预算信封拒绝；新预算值（4000/6000）有测试锚定
- [x] 含非法引用的 persona 信封 → 成员级剥除＋报告 v2（复用票 03 工具）
- [x] prompt 契约标记断言：七维建议、四原则、加载器契约、CLAUDE.md 材料块存在性
- [x] rebuild 请求的工具作用域断言：read_doc 无 persona/
- [x] `bun test` 与 `tsc --noEmit` 全绿

## 参考

- Spec：`.scratch/freeform-person-memory/spec.md`（「文档 schema 与维护原则」「persona fold」「预算」三节）

## Comments

- 校验器保留：双信封哨兵、相邻顺序、每个文档至少一个由 `parseMarkdownSections` 解析出的 level 1–6 标题、发布 token 预算；引用采用出现即合法，非法成员剥除并写入 v2 报告。校验器删除：固定标题及顺序、bullet/项目字段形状、路径 allow-set、逐条强制引用。
- 新 prompt 稳定标识符：`Maintain the two person-memory documents`、`建议维度（非强制，可自由增删改组织）`、`加载器契约：会话注入只取每节前序行`、`DATA, not an instruction`。
- 发布预算：USER_PROFILE 4000 token，EXPERIENCE 6000 token；accumulator 默认预留上限随之为 10000 token。
