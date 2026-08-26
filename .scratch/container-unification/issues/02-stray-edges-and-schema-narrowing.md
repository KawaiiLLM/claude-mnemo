# 02 — 清掉异类边并收紧 schema

**What to build:** 关系图里只剩 turn→turn。今天有 4 条 `provenance='judged'` 的
`turn→segment` / `segment→segment` 行,是关系词收紧之前的残留。

对应 spec:D10。

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] 一次性迁移删除那 4 条行(实现时**重新测量**,数量会变)
- [ ] schema 收紧:带 relation 的行只允许 turn→turn;bare 的 `text-ref` 行不受影响
- [ ] 迁移守卫的成功标记必须**单调地**活过之后每一次 schema 变更——不得用会被后续
      收缩删掉的 DDL 文本做判据
- [ ] 幂等:第二次打开是无操作
- [ ] 突变:去掉 CHECK 的收紧,必须有测试变红
