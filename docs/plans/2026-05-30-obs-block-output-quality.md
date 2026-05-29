# Observation block 输出质量

**TL;DR**:obs block 现在是**上下文专用**(streaming 下 agent 提取 turn,不再提取单条 obs),它的唯一职责是给 turn 提取够用的工具调用信号。但非白名单工具——尤其占用量最大的 MCP 一族——的 `out:` 直接 dump 裸 JSON,真正的文本被转义和括号埋掉。本 spec 用一个**通用输出提取**兜底覆盖整条 MCP 长尾,补两个高频原生工具(`Task*`),并把 obs 预算放宽到 ~1k(`in:200`/`out:800`、偏向输出)——同时截断 tool name、抬高 `MIN_MINI_TURN_CHARS` 以保住「单条 obs < floored budget」的不变式。纯代码改动,无迁移。

## 背景:obs block 干什么、问题在哪

D6(session 摘要重设计)确认 streaming 模型下**不再单独提取 observation**:obs block 只作为 turn mini-turn 内的上下文出现,agent 据此写 turn 的 title/content/decision。所以评判标准是「最低 token 给 turn 提取够用的信号」,不是「独立复原一次工具调用」。

当前每条 obs(`buildObsBlock`,`src/worker/processors.ts:139`):

```text
<obs id="O<n>">
  🔧 ToolName
  in:  <cleanInput,  ≤300>
  out: <cleanOutput, ≤300>
</obs>
```

`cleanOutput`(`processors.ts:76`)对白名单内工具按键提取,白名单外的工具走 `return rawJson`(`:82`)→ 裸 JSON 截到 300。问题:**最大的非白名单群体是 MCP**。活体库(横跨多个项目)实测分布:

| 工具 | 次数 | 白名单内? | 实际输出形状 |
|---|---|---|---|
| Bash / Read / Edit / Grep / Write / Glob | 13k+ | ✅ | — |
| WebSearch / WebFetch / Agent / ToolSearch / Skill | 1.5k+ | ✅ | — |
| **TaskUpdate** | 394 | ❌ | `{"success":true,"taskId":"11","statusChange":{…}}` |
| **TaskCreate** | 200 | ❌ | `{"task":{"id":"11","subject":"…"}}` |
| **mcp__\*(blender / playwright / bilibili / godot / mnemo / firecrawl)** | 800+ 合计 | ❌ | 多为 `[{"type":"text","text":"…"}]`;部分自定义如 blender `{"result":"…"}` |
| StructuredOutput | 54 | ❌ | 纯字符串 `"Structured output provided successfully"` |

MCP 输出被当裸 JSON 截断时,`text` 字段被 `[{"type":"text","text":"...` 的外壳和转义吃掉大半预算,信号密度很低。

## 设计原则

**通用优先于枚举。** MCP 工具是开放集合(用户随时新增 server),逐个加白名单追不过来。优先用「按形状提取」覆盖整族。

**obs 是补充,不堆料。** turn mini-turn 还带 prompt + response + file 树 + tool_call_count;obs 只是补充信号。改动以「去噪、对齐预算」为主,不追求 obs 自给自足。

**不变式先于预算。** 「单条 obs < 任何 floored final budget」必须**按构造成立**——这是 `peelMiniTurnObs` 排空缓冲、`renderMiniTurn <= maxMiniTurnChars` 的前提。放宽 `out:` 可以,但每条 obs 的最坏值必须有**硬上限**(故截断开放的 tool name),且地板要相应抬高把余量留出(见 D3)。

## D1:通用输出提取(核心)

`cleanOutput` 钉死成一条**单向链**,通用提取放在**白名单分支之后、裸 dump 之前**——只接管非白名单工具,现有白名单行为零改动:

1. `safeJsonParse` 失败 → 原样返回(纯字符串输出,如 NotebookEdit/StructuredOutput,走这条)。
2. `Read` / `Bash` 特例 → 维持现有逻辑。
3. `toolName in OUTPUT_ALLOW` → 按 allow-keys 过滤返回(**白名单工具到此为止,行为不变**)。
4. **非白名单** → 依次试下面两类通用形状,命中即返回。
5. 都不命中 → 退回 `rawJson` 裸 dump(现状兜底)。

第 4 步识别两类形状:

- **MCP 内容数组** `[{type:"text", text:"…"}, …]` → join **所有非空 `text` 字段**(`\n` 连接)。**至少一个非空 text 才 unwrap**;若数组只含 image / resource / error block(无可用 text),不 unwrap,落到第 5 步裸 dump——避免把整条 obs 清空丢信号。覆盖 playwright、claude-mnemo recall/timeline、firecrawl,及任何 spec-compliant MCP server。
- **单键文本对象** `{result|output|content|text|message: "…"}` → 该值为**非空字符串**才 unwrap;否则落到第 5 步。覆盖 blender `{result}` 等自定义形状(复用 `unwrapSingleStringValue` 思路,限定到这组文本键)。

这样**一次性清掉整条 MCP 长尾**与未来新增 server,无需逐个加白名单。

> 不引入「按 server 配置」的复杂度:MCP 标准内容数组是协议级约定,按形状提取比按工具名枚举更稳、更省维护。
> **顺序要害**:当前代码在 `if (!(toolName in OUTPUT_ALLOW)) return rawJson` 处无条件裸 dump;通用提取就插在这一句**内部**(替换那个无条件 `return rawJson`),所以只影响非白名单工具,白名单工具压根到不了这里。

## D2:补充白名单(有限、稳定的原生工具)

MCP 交给 D1。原生工具里只补两个有**真实 JSON 输出**、且实测高频的(`processors.ts:29`):

| 工具 | allow-keys | 理由 |
|---|---|---|
| `TaskUpdate` | `success, taskId, statusChange` | 394 次;键由活体数据确认 |
| `TaskCreate` | `task` | 200 次;键由活体数据确认 |

**不补,且各有定论**(避免猜键名):

- `MultiEdit` —— 当前 CC 源码 `src/tools/` **无此工具**(Edit 的 `replace_all` 已覆盖其场景),加它纯属猜测。
- `NotebookEdit` —— CC `NotebookEditTool.ts:133` 的 tool_result `content` 是**纯字符串**(`Updated cell X with …` / `Inserted …` / `Deleted …`),`safeJsonParse` 失败即原样返回,已干净,无 JSON 键可白名单。
- `TaskList`(5)、`AskUserQuestion`(4)、`Workflow`(3) 低频;`StructuredOutput` 同 NotebookEdit,纯字符串,无需动。

`INPUT_STRIP`(`:25`)顺带审视:`Bash` 已 strip `description`/`timeout`;`Task`/`Agent` 类的 `description`(长 prompt)可考虑 strip(避免 `in:` 被任务描述占满),但 `Agent` 的 description 正是 keyParam 来源,需谨慎——**留作 D2 内的小决策**,默认不动。

## D3:放宽 obs 预算到 ~1k(抬地板 + 硬约束 tool name)

把 obs 预算放宽到目标 ~1k,偏向输出:

- `in:` 300 → **200**
- `out:` 300 → **800**

「单条 obs < 任何 floored final budget」这条**按构造成立**的不变式(`peelMiniTurnObs`,`processors.ts:621`)有两个之前漏算的项,必须一并钉死,否则放宽预算会顶破地板:

1. **每行 +4 空格缩进**:`blockSize = block.length + 行数×4`(`processors.ts:620`)。in/out 被 `truncateMiddle` 截断后各塞 2 个换行,**最坏一条 obs 共 9 行 → ×4 = 36 字符缩进**(非未截断时的 5 行/20),上一版漏算了它。
2. **开放的 MCP tool name 无上限**:`mcp__<server>__<tool>` 可任意长,blockSize 随之无界。codex 实测:tool name 超 ~74 字符就顶破旧地板 980。

**两个硬约束 + 抬地板**:

- **截断 tool name**:`buildObsBlock` 里 `toolName` 超 `TOOL_NAME_CAP`(64;现存最长 MCP 名 ~55,不受影响)即 `slice(0, 63) + "…"`,给 blockSize 一个硬上限(直接消除 codex 的「无界」顾虑)。
- **抬 `MIN_MINI_TURN_CHARS`** 8192 → **9216**:floored final budget = 9216 − `FINAL_SLICE_OVERHEAD`(7212) = **2004**。
- 单条 obs 最坏 blockSize:`block.length`(id 10 位 + name 64 + in:200 截断含 2 换行 ~212 + out:800 截断含 2 换行 ~812 + 标签外壳 ~40 ≈ 1138)+ **缩进(截断后 9 行 ×4 = 36)** ≈ **1178 < 2004**,留 ~826 余量。

> 为何 A 不是 B:B(不抬地板)在长 MCP tool name 下余量 < 20,codex 判定不安全;既然 `maxMiniTurnChars` 可放宽,走 A——给到字面 ~1k,且把不变式余量留宽。
> `in` 仍压到 200:`out` 才是发现密度所在,`in`(路径/命令/pattern)很少逼近 200。
> 更新 `config.ts` floor 注释(`~720`→`~1178`,`8192`→`9216`)与 `peelMiniTurnObs` 注释。

## D4:vestigial `O<n>` id —— 保留

obs block 的 `id="O<n>"` 在 streaming 下 agent 从不引用(O 提取路由已休眠,D6)。**决策:保留**。理由:`recall(id="O<n>")` 与 mnemo-replay 仍按 O id 寻址(人类/调试面),删了会破坏读侧寻址;留着仅 ~12 字符/条的无害数据。

> 否决「删除」:省的 token 微乎其微,却要动 recall 的 observation 路由与 SKILL 文档,风险/收益不划算。D6 已从**系统提示**移除 obs 提取指引,agent 不会被 block 里的 id 误导。

## 实现顺序

1. **D1 通用提取**——改 `cleanOutput`:在「非白名单 → `return rawJson`」处插入 MCP 内容数组 + 单键文本 unwrap(含无 text / 空值退回裸 dump),白名单分支零改动
2. **D2 白名单补充**——`OUTPUT_ALLOW` 加 `TaskUpdate` / `TaskCreate`
3. **D3 预算放宽**——`buildObsBlock` 的 `in:200`/`out:800` + tool name 截到 `TOOL_NAME_CAP`(64);`MIN_MINI_TURN_CHARS` 8192→9216;更新 `peelMiniTurnObs` 与 `config.ts` floor 注释的 ~720 → ~1178

D4 无改动。

## 测试 / 验收

- `cleanOutput` 单测:MCP 内容数组 `[{type:text,text}]` → 提取 text(去外壳);多 text block → `\n` join;**只含 image/resource/error block(无 text)→ 退回裸 JSON**;blender `{result}` → 提取 result;单键值为空串 / 非字符串 → 退回裸 JSON;白名单内工具(Bash/Read/Edit)行为逐字不变;`TaskUpdate`/`TaskCreate` 按新键提取。
- `buildObsBlock` 单测:`out:` 用满 800、`in:` 用满 200 的截断点;截断标记 `[...N chars truncated...]` 仍出现;**超 64 字符的 tool name 被截到 `…`**。
- 回归(硬约束):构造最坏 obs(64 字符 MCP tool name + in/out 填满 + 大 id),断言 `peelMiniTurnObs` 算出的 `blockSize <= MIN_MINI_TURN_CHARS − FINAL_SLICE_OVERHEAD`(= 2004,**从常量算出而非硬编码**),且至少取 1 条、缓冲排空。
- 验收:对一条真实 MCP-重 turn(如 playwright/blender)渲染 mini-turn,`out:` 显示可读文本而非 `[{"type":"text",...` 外壳。

## 开放问题

- `TOOL_NAME_CAP=64` 取自现存最长 MCP 名(~55)+ 余量;若日后出现更长的命名空间,只影响显示(被截 `…`),不破坏 blockSize 硬上限。
- `out:800` 是否够?tool-output-heavy 调试 turn 可能仍嫌紧;地板已留 ~840 余量,后续真要再放宽,代价只是 floor 再抬一点,不破不变式。
- MCP 单键文本键集合(`result/output/content/text/message`)是否够覆盖在野 server?按 D1 上线后观察裸-dump 退回率决定是否扩充。
