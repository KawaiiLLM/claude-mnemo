# 02 — 4 点内容日界

**What to build:** 判定「一段内容属于哪一天」从本地午夜为界改为本地 4 点为界。凌晨（本地 4 点前）产生的会话内容归到前一天、落进前一天的日记；按日拉取素材的时间窗、手动 `/dream` 的「今天／昨天」判定，三处一致地按 4 点日界。日界小时与 dream 触发小时是同一个配置值。

**Blocked by:** 无 — 可立即开始。

**Status:** done — 复用现有 `dreamAgentHour`（默认 4）作日界，不新增配置字段。calendar 加 `contentDateAt` + `calendarDayBounds` 带 `boundaryHour` 位移；三处调用点（bucketing 读 `dream_hour` KV、diary-material 传参、server 手动 guard）+ reconcile 播种 `dream_hour` + diary-runtime/dream-job 透传 config 值。新增 calendar 2 条、diary-material 1 条、diary-state 1 条边界测试；DST 测试显式传 0 保留原意。888 pass、tsc 干净，唯一 fail 是 stale-bundle guard（待 04）。

- [ ] 新增可配置的「日界小时」，默认本地 4 点，越界值钳制到合法小时区间；与现有 dream 触发调度共用同一小时值，使「内容日 D 在 D+1 日界时刻收口、D 的 dream 恰在此刻触发」成立。
- [ ] calendar 模块提供带日界位移的「内容归日」与「按日起止窗口」：本地 03:59 归前一天、04:00 归当天、跨日窗口起止落在 04:00。
- [ ] 三处调用点改用带日界的判定：新内容进来标记哪天需重生、按日拉取当天素材的 epoch 窗口、手动触发的「今天」判定。
- [ ] 凌晨 2 点手动 `/dream` 能正常补做「昨天」，不被「昨天是未来」的判定拦截。
- [ ] calendar 纯函数单测覆盖日界边界样例；三处调用点各加一条「凌晨内容归前一天」的行为断言。
- [ ] DST 边角记为已知限制：默认时区 `Asia/Shanghai` 无夏令时、精确；有 DST 的时区留待后续。
- [ ] 全量 `bun test` 与 `tsc` 干净。
