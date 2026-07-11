# 10 — 实现层审查修复（3 Blocker + 4 Important）

**What to build:** 修复 0.3.0 实现的 Codex 审查 findings：生产 prompt 缺 wire-format 模板、persona 世代正文无 hash、rebuild 置位的 read-modify-write 竞态，以及空日阻塞/分批预算/INDEX 修复/三代保留四个 Important。

**Blocked by:** 01–09（全部已完成）。

**Status:** done

- [ ] **B1 wire-format 模板**：diary prompt 嵌入完整可复制的 envelope 模板（`===DIARY_V2_BEGIN/END===`、`===INDEX_HOOK_V1===` 行位置、三节标题、项目引导行/bullet/延续行语法、引用组格式、禁止项如代码围栏/额外文本）；persona prompt 同样嵌入 USER_PROFILE_V1 + EXPERIENCE_V1 完整 sentinel 模板与顺序要求；测试断言两个 prompt 含全部 literal sentinel；persona parser 拒绝块倒序与块间/末尾多余文本
- [ ] **B2 世代正文 hash**：manifest 增加 `user_profile_sha256`/`experience_sha256`；CURRENT 与 target-generation 的所有读取先验 hash，失败按损坏处理（省略/置 rebuild）；新增分别篡改两个正文文件的 diary 素材、SessionStart 注入、operation recovery 三路测试
- [ ] **B3 原子 rebuild 置位**：删除 context 与 diary-job 里「读整 cursor → 重写整 cursor」的 helper，全部入口改调原子 `requestPersonaRebuild()`；并发测试：读旧 cursor → persona 发布 → 请求 rebuild，断言只有标志位变化、发布结果不倒退
- [ ] **I1 空日不被 persona 阻塞**：空日路径的 coverage 读取损坏时原子请求 rebuild 并按无 coverage 继续提交 tombstone，不进 retry/terminal
- [ ] **I2 rebuild 分批预算**：后续批规划时为 accumulator 预留最大预算；批溢出新建单篇批时重新验证完整 request 可装入；150K 边界测试
- [ ] **I3 SessionStart 修复 INDEX**：注入前从 diary_day_state 重渲染 canonical INDEX（ensureIndex 语义）再读；删除与篡改 INDEX 后启动即修复的测试
- [ ] **I4 三代保留**：CURRENT 提交 + DB 对账成功后只保留当前代及前两代；清理失败仅记日志不回滚发布；发布第 4 代后的目录断言
- [ ] 全量 `bun test` 0 失败；`bunx tsc --noEmit` 通过
