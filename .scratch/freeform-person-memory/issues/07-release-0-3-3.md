# 07 — 0.3.3 发布集成

**What to build:** 0.3.3 可发布：版本号在全部既有站点一致（package.json、两处 marketplace.json 字段、plugin.json、release-artifacts 守卫、diary SDK server 版本常量），bundle 重建且内容哨兵反映新实现（新 prompt 标记替换旧 checklist 类标记，加载器/read_doc/无顶 recall 的标识符进 worker 哨兵清单），发布验收清单文档化（追加到 spec 附录）：部署后触发全量 persona rebuild，人工核查——现存项目全部保留、画像含带日期事件与「」原话、引用全部可解析。

**Blocked by:** 02、05、06（即 01–06 全部完成）。

**Status:** done

- [x] 旧版本号（0.3.2）grep 无残留（*.json、tests/、src/）
- [x] `npm run build` 后 bundle 的 BUILD_ID 前缀为 0.3.3；stale-bundle 字节比对守卫通过
- [x] release-artifacts 哨兵更新：删除已不存在实现的旧标记，加入 free-form 关键标识符
- [x] 发布验收清单写入 spec 附录（Further Notes 后）
- [x] `bun test` 全套件与 `tsc --noEmit` 全绿

## 参考

- Spec：`.scratch/freeform-person-memory/spec.md`（「发布与迁移」＋Testing 的发布守卫/发布验收条款）
- 版本 bump 站点清单以 release-artifacts 测试为准（六站点）

## Comments

- 哨兵删除：worker 的 `Maintain the two person-memory documents`（仍存在但过于宽泛，由具体 free-form 契约标识替代）。
- 哨兵新增：hook-command 的 `renderPersonaDocumentInjection`；worker 的 `workerRecallInputShape`、`allowedDocumentSubtrees`、`session_manifest`、`建议维度（非强制，可自由增删改组织）`（按 bundle 实际字节使用 Unicode 转义）；mcp-server 的 `workerRecallInputShape`。
- 最终验证：`bun test` 920 pass / 0 fail（2958 expect，78 files）；`bunx tsc --noEmit` 通过。发布守卫单测 7 pass / 0 fail（44 expect）。
- 审查修复：① `src/shared/citation-validation.ts#createCitationLineLocator` 统一 citation offset→行号定位，`src/diary/domain.ts#validateDiaryCitations` 与 `src/worker/persona-maintenance.ts#stripPersonaDocumentCitations` 改为调用共享实现；② `src/worker/persona-maintenance.ts#sanitizePersonaOutput` 内联 `collectDiaryCitationRefs(requestSources(request))` 并删除 `buildPersonaAllowSets`；③ `src/worker/persona-maintenance.ts#runPersonaMaintenance` 移除正常发布与恢复发布后的自动裁剪，`src/diary/file-store.ts#prunePersonaGenerations` 选择删除（全仓无其他调用方或专属单测，保留只会留下与只读历史合同冲突的未使用能力）；④ `src/worker/diary-job.ts#buildMergePrompt` 及分批归约调用注入完整 session/turn 清单与实际存在的 `global_claude_md` / `current_user_profile` / `current_experience` 材料块，`tests/worker/diary-job.test.ts` 覆盖 merge prompt；修复后 `bun test` 920 pass / 0 fail（2959 expect，78 files），`bunx tsc --noEmit` 与 `bun run build` 通过。
