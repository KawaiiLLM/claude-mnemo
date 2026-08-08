# 02 — note 工具与影子笔记存储（P1）

**What to build:** 主 agent 可调用的 MCP `note` 工具（spec D1）：参数 turn（`S<id>/T<n>` 全限定地址，经 (session_id, prompt_number) 唯一索引解析）、title、content、insight?。写入落**影子存储**，turns 表及其 status 字节不动（R2#2/#3）——旧管线的盲评隔离靠这一条。remember payload 过既有 strip 管线剥 private 内容（D10）。writer_model 与 ride_turn（笔记实际写入时所在 turn）机械回填。note 调用产生的观测带排除标记，旧提取管线忽略之。

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] `note(turn:"S15069/T332",…)` 落影子行；非法/不存在地址返回参数错误
- [ ] 同一 turn 重复写为覆盖语义（唯一键幂等），影子行保留最新
- [ ] 任意 note 写入前后，对应 turns 行字节一致（含 status）
- [ ] 含 private 标记内容的 payload 入库前被剥除
- [ ] note 调用的 tool-use 观测不进入旧提取输入流
- [ ] writer_model、ride_turn 机械记录，无需调用方提供
