# 03 — 笔记节奏改积压制

**What to build:** 逐 prompt 注入只剩当前 turn 地址;积压 ≥5 出提醒、降回 <5 停;时机契约单一归家。

规范:`.scratch/ownership-and-note-cadence/spec.md`「笔记节奏」节。

- **欠账后缀退役**:current-turn line 不再携带 owed 信息(结构性恒真——shift-0 全库实测 0 次,见 spec Problem 节)。地址供即时的段归属与边操作使用。
- **积压提醒**:阈值沿用 `NOTE_RELIEF_PENDING_THRESHOLD` = 5,持续重渲染直到降回 5 以下([S15069/T870])。
- **契约改写不叠加**:现行规则二(「欠账在本轮第一批工具调用里结清」)整体改为「积压提醒出现时开一批补写」;规则一(只给已完结 turn 写笔记)不变。措辞在工具描述与 SessionStart 文本中**只出现一次**——0.11.1 的事故即两处各说一套,测试须断言单一归家。

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] 0 条、4 条积压无提醒;5 条渲染;降回 4 条后停
- [ ] current-turn line 无任何欠账后缀
- [ ] 笔记时机措辞的单一归家断言(工具描述与 SessionStart 文本不得各说一套)
