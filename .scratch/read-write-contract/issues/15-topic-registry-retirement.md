# 15 — topic 注册表退役

**What to build:** topic 的信息折入 tags,注册表整体退役;段只以 `E<n>` 寻址。

规范:spec 视图节 roster 重建条 + [S15069/T979-981] 裁决(「tag 本就是记录 topic 的」——同类信息两套机制=机制层同义分裂)。

- `remember(create)` 去掉必填 `topic` 参数;`attach` 只认 `E<n>` 地址,按名解析退役(传名字→拒绝并回显 `E<n>` 语法)。
- **迁移**:每个段的 topic 名折入该段 tags(bare tag,小写连字符归一,去重)——信息在幸存机制中存续;随后 `topics` 表与 `segments.topicId` 退役(rebuild 迁移,schema.ts 既有惯例)。
- 消费面清理:结算 roster 条目去 topic 字段;段卡片头 `(topic)` 去除;`getTopic`/`getSegmentsForTopic`/`listTopics` 等注册表读面随消费者清理。
- 风险背书:全库无计分/过滤依赖 topic,纯展示+解析。

**Blocked by:** 14(roster/attach 同域)。

**Status:** ready-for-agent

- [ ] create 无 topic 参数可用;attach 传名被拒回显地址语法
- [ ] 迁移后每段 tags 含原 topic 名(归一、去重);行数零丢失
- [ ] fresh 库无 topics 表;legacy 库迁移幂等
- [ ] topic 无功能性引用(grep;历史注释豁免)
