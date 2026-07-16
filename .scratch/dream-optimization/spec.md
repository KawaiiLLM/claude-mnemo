# Dream 优化 — 缓存 TTL、增量提交、4 点日界

**Status:** ready-for-agent

## Problem Statement

每晚一次的 dream agent 在成本与「天」的判定上都有可量化的浪费，三处彼此独立：

1. **缓存 TTL 错配**：dream 实测跑在 1 小时缓存（transcript 里 `ephemeral_1h_input_tokens` 全 > 0）。但 dream 是一次性会话——5～6 轮、几分钟跑完、每轮间隔几秒，全在 5 分钟内，且每晚内容全新、一小时后没有任何跨次复用。1h 写入的 2× 溢价（对比 5m 的 1.25×）买了个用不上的东西。以 07-16 那次为例，cacheWrite 107,308 token 被按 $10/M 计价（$1.07），若按 5m 的 $6.25/M 只需 $0.67。

2. **全量重发**：`commit` 工具把五份文档（日记、INDEX、user-profile、experience、archive）作为参数整体传入，即使当晚只改了其中一小片。这些参数是模型生成的、计入 output token；07-16 那次 output 40,153 token（$1.00）里 96% 是这份 commit 参数。日记每天全新无可避免，但 profile/experience/archive/INDEX 属于「edit-on-top」，每晚全量重写是纯浪费。

3. **内容归日按午夜 0 点**：判定一段内容属于哪一天，现在用本地午夜为界。凌晨 01:00 的会话被归到新的一天，落不进前一天的日记，要等下一晚的 dream 才捞。人的作息里，凌晨那段活儿属于前一天。

## Solution

三项各自独立、可分别上线的改动：

- **A 缓存 TTL**：dream 强制使用 5 分钟缓存；summary agent 保持 1 小时（它跨会话生命周期、turn 间隔可能超 5 分钟，缓存真有复用，不动）。
- **B 增量提交**：dream agent 改用受限的 Write/Edit 工具，把文档写进一个 staging 工作区（复制自当前有效记忆），只写改动、不重发未变内容；`commit` 变成不带文档参数的「校验并原子发布 staging」信号。原子性、快照历史、成功标记全部复用现有 `commitNight` 事务机器。
- **C 4 点日界**：引入统一的「日界小时」（默认本地 4 点），内容归日、按日拉取、手动触发的「今天」判定三处套同一位移；触发小时与日界小时合一。

按 07-16 实测，A 单独就把该次 dream 从 $2.17 降到 $1.77（省 $0.40，约 18%）；B 再削 output 约 1/4～1/3；C 不省钱，修正内容归属正确性。

## User Stories

1. 作为项目维护者，我希望 dream 用 5 分钟缓存，从而不为用不上的 1 小时缓存多付 60% 的写入溢价。
2. 作为项目维护者，我希望 summary agent 保持 1 小时缓存，因为它在一次会话内跨多个 turn 复用缓存前缀、turn 间隔可能超过 5 分钟。
3. 作为项目维护者，我希望 dream 与 summary 的缓存策略彼此解耦，从而能一个 5m、一个 1h，而非被同一个旋钮绑死。
4. 作为项目维护者，我希望能从 dream transcript 事后验证它确实用了 5 分钟缓存（`ephemeral_5m_input_tokens` > 0、`ephemeral_1h` 为 0）。
5. 作为 dream agent，我希望能用 Write 写新文档、用 Edit 改已有文档，从而只把当晚真正变化的内容变成 token，而非每晚重发五份全文。
6. 作为 dream agent，我的 Write/Edit 只能作用于本次运行的 staging 工作区，写不到其它任何目录，从而不会误伤有效记忆或越界到工作区之外。
7. 作为项目维护者，我希望被 watchdog 中途杀死的 dream 不污染有效记忆——agent 只动 staging，有效目录在原子发布前分毫不动。
8. 作为项目维护者，我希望 dream 提交仍保留现有的快照历史、5k-token/文档校验、成功标记「最后落」的原子契约，改造不削弱任何既有保证。
9. 作为项目维护者，我希望每次成功提交仍在 `memory/history/` 留下带日期的快照，作为可回滚、可审计的归档。
10. 作为使用者，我希望凌晨（本地 4 点前）产生的会话内容被归到前一天，从而落进前一天的日记而非孤悬到新一天。
11. 作为使用者，我希望「按日拉取当天素材」的时间窗以本地 4 点为起止，与内容归日的边界一致。
12. 作为使用者，我希望凌晨 2 点手动 `/dream` 时，系统对「今天／昨天」的判定也按 4 点日界，从而我能正常补做「昨天」而不被「昨天还是未来」的判定拦住。
13. 作为项目维护者，我希望日界小时与 dream 触发小时是同一个配置值，从而「D 这天的 dream 在 D+1 日界时刻触发」这一关系天然成立、不必维护两个旋钮。
14. 作为项目维护者，我希望日界小时可配置、有合理默认（4），并对越界值做钳制。
15. 作为项目维护者，我希望这三项能分别切分成独立可上线的 ticket，缓存 TTL 这样零风险的改动不被增量提交这样较重的改造阻塞。
16. 作为项目维护者，我希望这次行为变更以一次可发布的补丁版本收尾，版本号在既有全部站点同步、bundle 重打包、release-artifacts 测试转绿。

## Implementation Decisions

三条工作流彼此独立，可各自成票；共享一次收尾发布。

### A — 缓存 TTL 解耦（dream → 5m，summary 不动）

- **单一接缝**：dream 的 SDK query options 现在**完全不传 `env`**，spawn 的 CC 因此继承 worker 进程环境（无缓存 flag）→ 落 CC 默认的 1h。修复即在该 options 注入 `env`，以 `buildIsolatedEnv()` 为底（与 summary 路径同源，避免漏掉必需环境或泄露被屏蔽的 key），叠加 `FORCE_PROMPT_CACHING_5M: "1"`。
- **不复用 `cacheMode` 配置**：`cacheMode`（默认 `"auto"`）只作用于 summary 路径，且一个旋钮无法同时表达 summary=1h、dream=5m。dream 走**硬编码 5m**，不引入新配置旋钮（YAGNI——用户的决策是固定策略，非「让它可变」）。
- summary 路径不改：`cacheMode` 保持 `"auto"`，CC 默认 1h，符合其跨 turn 复用特性。

### B — 增量提交（staging + 受限 Write/Edit + payload-free commit）

- **复用现有原子机器**：`memory-store.ts` 的 `commitNight` 已经做 recover → snapshot（`memory/history/` 带 manifest 的日期快照）→ validate（5k-token/文档硬上限）→ prepareTransaction（写事务 staging）→ publishTransaction（原子）→ writeSuccessMarker（最后落，故未落即视为未处理）。**diary、INDEX、user-profile、experience、archive、migration-state 本就在同一事务里原子提交**。本工作流只改文档的**来源**，不改这套事务契约。
- **不引入 symlink、不重构 `memory/` 布局**：原子性已由 `publishTransaction` 保证，无需整目录交换；用户设想的「日期归档目录」即现有 `memory/history/<snapshot>` 快照，已存在。
- **新增一个 dream 运行级 staging 工作区**：worker 在调起 agent 前，把当前有效记忆的六份文档播种进该工作区（日记文件以当天为名，可为空或含既有草稿）。
- **给 agent 挂受限 Write/Edit**：加进 SDK 的内置工具集，经 `canUseTool` 把可写路径限死在该 staging 工作区子树内（与现有 `read_doc` 的 `allowedDocumentSubtrees` 同一种作用域机制）；越界路径一律拒绝。
- **`commit` 改为不带文档参数**：现有 `dreamCommitInputShape` 的六个文档字段移除，commit 退化为「本次 staging 已就绪，请校验并发布」的信号；`commitNight` 从 staging 工作区读取文档内容，替换原先从工具参数读取。单次提交契约（"Dream agent attempted more than one commit" 守卫）保留。
- **原型验证过的接口形状**（来自现有代码，非新造）：`commitNight` 事务映射逻辑路径 → 文档内容字符串，改造后这些字符串改由读 staging 文件得到：

  ```
  prepareTransaction("commit", date, {
    "memory/user-profile.md": <read staging>,
    "memory/experience.md":   <read staging>,
    "memory/archive.md":      <read staging>,
    "memory/migration-state.json": serializeMigrationState(false),
    "diary/<date>.md":        <read staging>,
    "diary/INDEX.md":         sortDiaryIndexRecentFirst(<read staging>),
  })
  ```

- **提示词相应调整**：curate 指令从「输出五份全文调用 commit」改为「用 Edit 增量修改 staging 中的 profile/experience/archive、用 Write 落当天日记、改完调用无参数 commit」；`sortDiaryIndexRecentFirst` 的 recent-first 归一仍在发布侧兜底。

### C — 4 点内容日界

- **新增配置 `dayBoundaryHour`**（默认 4，钳制到合法小时区间 0–23），与 dream 触发调度共用——触发小时来自 `dreamSchedule.hour`（`context` 钩子喂给 `dreamTriggerWindow`），二者合一，使「内容日 D 在 D+1 的日界时刻收口，D 的 dream 恰在此刻触发」自然成立。
- **单一位移，`calendar` 模块为唯一接缝**：内容归日改用 `contentDateAt(epoch, tz, boundaryHour) = calendarDateAt(epoch − boundaryHour 小时, tz)`；`calendarDayBounds` 的起止各加 `boundaryHour` 位移，得到 `[D 04:00 本地, D+1 04:00 本地)`。
- **三处调用点改用带日界的判定**：新内容进来时标记「哪天」需重生、按日拉取当天素材的 epoch 窗口、手动 `/dream` 的「今天」判定，全部从午夜版切到 `boundaryHour` 版。
- **DST caveat**：`epoch − N 小时` 的位移在有夏令时的时区，一年两次会在切换点差 1 小时。默认时区 `Asia/Shanghai` 无夏令时，精确无误；若将来支持 DST 时区，`calendarDayBounds` 侧改用二分定位当天 `boundaryHour:00` 的 epoch。先记为已知边角。

### 收尾

- 三项落地后，按既有 7 处版本 bump 清单收一次补丁版本（`0.4.2`），`bun run build` 重打包，`release-artifacts` 转绿。

## Testing Decisions

好测试只验外部行为，不锁实现细节。

- **A 缓存 TTL**：沿用现有 `diary-sdk-query.test.ts` 的接缝——它已断言 `seenCalls[0].options` 的 tools/allowedTools/mcpServers/systemPrompt 等字段；加一条 `options.env.FORCE_PROMPT_CACHING_5M === "1"` 即可。summary 侧现有 `cacheMode` 测试保持不变以证明未回归。TTL 的事后探测已有 `cache-ttl.ts` 的 `detectCacheTtlFromLines` 可复用作端到端断言（部署后一份真实 dream transcript 应报 `ephemeral_5m` > 0）。
- **B 增量提交**：最高接缝是 `commitNight`——它已有 `faultInjector` 在 `after-snapshot`/`after-staging`/`after-publish`/`before-success-marker` 注入故障来验证原子性与回滚，改造后这组测试原样验证「文档来源换成 staging 后，原子契约不变」。新增：`canUseTool` 拒绝 staging 子树之外的写路径（作用域测试，仿 `read_doc` 的作用域现有测试）；payload-free `commit` 触发一次完整发布且单次提交守卫仍生效。
- **C 4 点日界**：`calendar` 模块是纯函数，沿用现有 `calendar` 单测——对 `contentDateAt` 与带 `boundaryHour` 的 `calendarDayBounds` 断言边界样例（本地 03:59 归前一天、04:00 归当天、跨日窗口起止落在 04:00）。三处调用点各加一条「凌晨内容归前一天」的行为断言。
- **收尾**：`release-artifacts.test.ts` 的版本一致性 + stale-bundle guard 全绿。

## Out of Scope

- **summary agent 的成本优化**：summary 单次 cacheWrite 远大于 dream，是真正的成本大头，但本 spec 明确保留其 1h 缓存（跨 turn 复用有效）。压 summary 成本是另一条独立的线，不在此。
- **dream 读入语料量（cacheRead / cacheWrite 体量本身）的削减**：output 见底后的下一块杠杆，独立议题，不在此。
- **memory/ 改 symlink 版本目录**：讨论中提出但经论证不必要（现有 per-file 原子发布已足），明确排除。
- **日记内容长度／voice 调整**：日记全量写是内容硬成本，不在本次优化范围。

## Further Notes

- **ROI 与风险排序**（供 `/to-tickets` 切分与排期参考）：A（缓存 TTL）改动最小、回报最大（每次 dream 省约 18%）、零架构风险，应排最前；C（4 点日界）是小改动的正确性修复，接缝单一；B（增量提交）改动最大、$ 回报中等（output 削 1/4～1/3），但顺带把「全量重发」这一偶然复杂度清掉，并复用现有事务机器故风险可控。三者无相互依赖，可并行推进，共享收尾发布。
- **成本口径更正记录**：先前口头估算把 dream 的 cacheWrite 按 5m 的 1.25× 计，实测是 1h 的 2×，故此前报的 dream 单次成本（$1.77）偏低，真实为 $2.17；同一口径下 cacheWrite（$1.07）实际略高于 output（$1.00），是最大单项——这正是 A 优先的依据。
- **部署**：worker 单例版本盲，任何 bump 后需冷重启全部会话方生效（与 0.4.0/0.4.1 同）。
