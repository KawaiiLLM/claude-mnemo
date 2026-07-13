# 04 — dream 作业处理器（合并单趟）＋curate 提示词＋模型配置

**What to build:** 取代日记作业与 persona 维护的单一夜间 dream agent。给定某天，它读当天材料清单，用 recall/timeline/read_doc/Read/Grep/commit 跑一个 agent，产出当天日记、日记索引更新、curate 后的画像与经历、以及 archive 的降级/提回——全部经 commit 工具原子发布。curate 提示词编码：人味记忆（进度、结果、印象深刻的对话、这个人是谁），工程细节排除到日记；画像＝谁 / 经历＝发生了什么，项目清单只在经历；分层遗忘（休眠降级进 archive，写新事实前先 Grep archive＋日记、命中带原 citation 提回）；每份记忆 ≤3k 中文字软提醒 / ≤5k token 硬界。模型经配置键可配，默认写死一个具体 opus id。

**Blocked by:** 01, 02, 03

**Status:** ready-for-agent

- [ ] 一个 agent 单趟产出日记＋更新记忆并原子提交；无 material 日写「安静的一天」并跳过 curate
- [ ] pre-curate 快照发生在 curate 之前
- [ ] 画像不含项目清单/进度；经历承载项目脉络；记忆排除工程细节
- [ ] resurface 的 archived 事实经 Grep 找到并带原 citation 提回，不重复写
- [ ] 模型从配置读取；非法值回退默认并告警
- [ ] 经注入的假 agent runner 验证（单测不跑真 LLM）
