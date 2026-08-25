# 04 — 删掉节点死亡:全局否决、valid、E5、自引

**What to build:** 模型里不再有「节点被杀死」这回事。随之消失的是候选资格排除、`dead`、`lastDeclarer`、`valid`、单 source/单 sink 的阻断性错误,以及整条自引规则 —— 控制台与渲染器也不再讲这些概念。

**Blocked by:** None — can start immediately.

**Status:** done — landed, not released

- [x] 里程碑候选资格排除的**边那一支**整条删除(无 tag `override`/`refutes` 不再把被引节点逐出候选)。**实测是 21 个存活 turn 重新入选,不是 18** —— spec D5 的数字是更早快照。金标夹具(925/935 重新入选)与单元测试各钉一条。回合级「无效节点」(rewind/skip)那一支保留,rubric v12 仍然要它。
- [x] `dead` / `lastDeclarer` / `valid` 从 lane 状态与选举中消失;tier ② 变为「closed 终点」;`open-last-declarer` 席位不再出现,单独一条测试钉它。附带:无 tag `override` 不再产生任何 lane 事件(rubric v12「未结算的边不参与收敛计算」),否则全局否决会以「只掀终点」的形态留下来。
- [x] E5(单 source / 单 sink)删除 —— 校验器、渲染器、CLI、结算两处教学面同批下线(错误类在教学面上是**封闭列表**,留着会让 agent 等一个永不到来的拒绝)。
- [x] 自引规则整条删除:`grounds` 的例外、它的 delivery 相位半条、事后 Gate C(`checkSelfGroundsTerminus` 及其证据类型)、四个拒绝理由,全部消失,合并为一条 `self-edge`。全库唯一那条自引边由 M-C 撤回(`runLaneModelV12SelfEdgeRetraction`,挂在票 01 建好的 `runLaneModelV12EdgeMigration` 槽里,不读任何 lane 列)。
- [x] **控制台**:载荷删掉 lane 的两个字段与逐 turn 的死亡标记,渲染器只剩 closed/open,前端撤掉死亡叉与失效匕首、图例改口。哨兵在**载荷边界**上做(整个响应里任一层级都不得出现那三个键名),比 grep 源码强。
- [x] 每一处删除一条哨兵,集中在 `tests/shared/lane-model-v12-deletions.test.ts`(控制台那条在载荷边界上)。六处都做了突变验证:把删掉的规则加回去,哨兵变红。

**File ownership:** 选举、lane 状态归约、checker 的错误类与渲染器、控制台载荷与前端,**以及写入判定里自引那一条**(见下)。其余词表与写入判定归票 02。

## 一处所有权更正

自引规则同时被三张票声称:本票的清单、票 02 的地盘(它住在写入判定里)、票 08 的验收项。**由本票执行**,写入判定里那一条归本票;票 08 的对应验收项改为「确认自引已被拒绝」而不是「实现拒绝」。

