# 05 — settlement 兜底:sessionend 边界、机械回填与存续

**What to build:** spec D7 + D10 的 settlement 侧全量。SessionEnd hook 同步落边界+入队,泄流点显式化:worker 每次 settlement 入口(任何会话的 turn-stop/compact/flush)在自身逻辑后扫描并派发全库到期 sessionend 作业,finishSession 补一次尝试 —— 泄流是被定义的行为,不是被假设的副作用;尾窗豁免 20-turn 下限。载荷职权改为机械回填:运行时现查窗口内仍缺笔记的 turn 逐个补写,删除「无债务记录=琐碎」与「尾部缺口拒收」两条裁量;回写只填空缺,writer_origin='agent' 的行永不触碰。getDecidedPrefixEnd 弃用游标与 pending 截断,各触发类型上界显式:compact→既有 anchor(行为不变)、sessionend→冻结边界、consecutive→作业创建时最高已结束 turn;窗口越过存量历史照常推进。

**Blocked by:** 02 — turn 结算迁出;03 — prompt 时钟台账(缺口现查复用其派生口径)。

**Status:** ready-for-agent

- [ ] sessionend 由 hook 同步落边界+入队;不即时执行;同会话重复 end 事件幂等;end 后 resume 的新 turn 归下一窗口且已入队作业不失效
- [ ] 泄流点覆盖测试:仅有 sessionend 作业在队、随后任一会话发生 turn-stop(未满 50)→ 作业被派发;finishSession 也触发尝试
- [ ] sessionend 尾窗 1–19 turn 也开窗;compact 触发行为不变(立即)
- [ ] 载荷对窗口内运行时缺口逐个补写;「trivial」「trailing-hole」两条裁量从载荷判定中删除
- [ ] 回写只填空缺;触发后主 agent 已写的 turn 不被覆盖、writer_origin 不被篡改(测试固定此竞态)
- [ ] 分界线之后的 turn 不进入兜底窗口
- [ ] decided-prefix 三种触发类型上界各自成立(compact 语义回归不变);含存量 pending 历史的会话窗口照常推进
- [ ] 空缺场景端到端跑出 notesReconstructed > 0 的日志记录
- [ ] 全量测试绿
