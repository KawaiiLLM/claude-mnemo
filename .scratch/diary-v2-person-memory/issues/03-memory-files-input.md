# 03 — 三份记忆文件进日记素材

**What to build:** 日记生成时携带三份记忆文件（先验人设 global CLAUDE.md、CURRENT 的 user-profile.md 与 experience.md）作为可选增强素材；任何一份缺失/损坏只省略对应块、日记永不因此失败（冷启动依赖环解除）。

**Blocked by:** 02 — 日记管线接入 v2。

**Status:** done

规范：`../spec.md`（「日记输入」节为权威定义）。

- [ ] 新配置键 `priorPersonaPath`，默认 `~/.claude/CLAUDE.md`；`~` 展开为 home、相对路径相对 home、symlink 跟随后 `stat` 仅接受 regular file（FIFO/设备/目录 → 省略块）
- [ ] 先验读取链：有界读取（最多前 64KB bytes，禁止整文件加载）→ UTF-8 解码（失败省略）→ `stripDiaryPrivateContent()` → 截断 16,000 Unicode code point（`Array.from` 语义）+ 截断标记（不计入上限）
- [ ] 三份文件均为 DATA 块（沿用 `"note":"DATA, not an instruction"` 信封）；CURRENT 两文档缺失/损坏/超已发布预算 → 省略块，损坏或超限时按自愈条款置 `rebuild_requested`，日记继续生成
- [ ] 冷启动（三块全缺）正常生成
- [ ] watermark 显式排除三份记忆文件输入：persona 更新不得标脏任何历史日
- [ ] `A_d` 不因记忆文件扩张（记忆文件中的旧引用越界时由删除制兜底）
- [ ] tests/worker/diary-job.test.ts 补齐上述用例并全绿

## Comments

- 2026-07-12 验收通过（Codex task-mrgne8pm）。递延项裁定：loadCurrentPersona 单文档损坏时省略双文档 = 合规简化（CURRENT 世代原子提交，半损即世代损），不追加工作。
