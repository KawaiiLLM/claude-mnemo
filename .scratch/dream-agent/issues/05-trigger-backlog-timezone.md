# 05 — session-start 触发＋断档补跑＋时区

**What to build:** dream agent 惰性触发。每次 session-start，若配置时刻已过且尚有未处理日，则从「上次成功日期＋1」补到「昨天」，单次入队封顶，逐日独立事务，安静日也写 durable 日记。时区用 IANA；DST 跳/重时以 success marker 判「一天一次」。某个 turn 在当日 dream 之后才落盘时，重新标记该日待再生。

**Blocked by:** 04

**Status:** ready-for-agent

- [ ] 缺三天后一次 session-start 补齐三天，而非只跑昨天
- [ ] 逐日独立事务；某日失败不阻断其余日
- [ ] 「一天一次」跨 DST 成立；非法时区回退默认并告警
- [ ] 落盘迟到的 turn 重新入队其日，重跑幂等替换当日日记与当日记忆增量
- [ ] 单次 session-start 入队封顶（默认 7，可配）
