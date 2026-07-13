# 02 — 限工作区的 Read/Grep 工具面

**What to build:** 安全地给 dream agent 真正的 Read 与 Grep。SDK query 放开内建 Read 与 Grep 工具，一个权限守卫把所有文件系统工具（Read、Grep、read_doc、commit）钉死在 diary 与 memory 工作区子树内。这样提回/去重才能用 Grep 搜 archive 与日记。

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] Read 与 Grep 对 diary/memory 子树下的路径成功
- [ ] Read/Grep 对原始转录项目目录、DB/config、以及工作区子树之外的任意路径被拒绝
- [ ] Grep 能从 archive 与日记文档返回匹配（支撑去重/提回）
- [ ] symlink 逃逸被拒绝
- [ ] 权限守卫有单元测试覆盖放行与拒绝两侧
