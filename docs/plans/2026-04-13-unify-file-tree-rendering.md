# 统一 files_read / files_modified 渲染

**Goal**: 将 `renderFileTree` 提取为共享函数，使 recall 工具与记忆 agent batch prompt 使用同一树形格式渲染文件路径列表。

**动机**:

obs-compression (D9) 在 `processors.ts` 中引入了 `renderFileTree`，用树形格式替代逗号分隔的绝对路径。但 recall 工具（`format.ts`）仍然用 `turn.filesRead.join(", ")`，主 agent 通过 recall 看到的文件列表与记忆 agent 看到的不一致。

当前三路径状态：

| 渲染路径 | 位置 | 格式 |
|---------|------|------|
| 记忆 agent batch prompt | `processors.ts:203-248` | `renderFileTree()` 树形 |
| recall expanded | `format.ts:661-682` | `join(", ")` + `truncateText` |
| timeline hook | `timeline.ts:958-962` | 仅计数 `📖N ✏️N` |

timeline 只显示计数，不需要改动。需要统一的是 recall 的 expanded 渲染。

**前置**: obs-compression D9 已实现 `renderFileTree`。

---

## Locked Decisions

**D1**: **将 `renderFileTree` 及其依赖（`commonPathPrefix`、`createFileTreeNode`、`renderTreeNode`）从 `processors.ts` 移到 `src/shared/file-tree.ts`**。

当前 `renderFileTree` 定义在 `processors.ts:411-460`，辅助函数在 `processors.ts:338-409`。`format.ts` 没有任何 import，直接 import `worker/processors` 会引入反向依赖（`mcp` → `worker`）且拖入 `bun:sqlite` 等重量级依赖。提取到 `shared/` 是正确的依赖方向：`worker` 和 `mcp` 都可以依赖 `shared`。

移动后 `processors.ts` 改为 `import { renderFileTree } from "../shared/file-tree"`，`format.ts` 同样 import。

**D2**: **recall 的 `formatTurnExpandedWithMode` 改用 `renderFileTree`，用 line-aware 截断替代 `truncateText` 字符截断**。

当前代码（`format.ts:661-668`）：
```ts
lines.push(
  `${detailIndent}- files_read: ${truncateText(turn.filesRead.join(", "), {
    limit, mode, hintId,
  })}`,
);
```

改为：
```ts
const tree = renderFileTree(turn.filesRead);
const treeLines = tree.split("\n");
lines.push(`${detailIndent}- files_read:`);
if (tree.length <= limit) {
  for (const treeLine of treeLines) {
    lines.push(`${detailIndent}    ${treeLine}`);
  }
} else {
  // line-aware truncation: keep whole lines until budget exhausted
  let consumed = 0;
  let kept = 0;
  for (const treeLine of treeLines) {
    if (consumed + treeLine.length > limit && kept > 0) break;
    lines.push(`${detailIndent}    ${treeLine}`);
    consumed += treeLine.length + 1;
    kept++;
  }
  const omitted = treeLines.length - kept;
  if (omitted > 0) {
    const suffix = mode === "unified" && hintId
      ? ` [use mnemo-replay skill → read ${hintId} for full list]`
      : "";
    lines.push(`${detailIndent}    ... +${omitted} lines${suffix}`);
  }
}
```

设计要点：

- **尊重全局 truncate 契约**。recall 的 expanded turn 中 prompt/response/insight/files_read/files_modified 全部受同一个 `truncate` 预算控制（`tests/mcp/format.test.ts:308` 锁定了这个行为）。树形输出也必须参与，否则是 API 行为变更。
- **不做字符级截断**（`truncateText` 会在任意位置截断，破坏缩进结构），改为 **line-aware**：按整行累加字符数，超出 `limit` 时停止，末尾追加 `... +N lines`。
- **hint 行为与 `truncateText` 对齐**，复用调用方已有的 `mode` + `hintId` 参数：
  - **unified 且 hintId 存在**：`... +N lines [use mnemo-replay skill → read S38/T318 for full list]`
  - **legacy，或 hintId 为空**：`... +N lines`（无 hint）
  - **未实际省略任何行**（`omitted === 0`）：不追加后缀
  - 这与 `truncateText`（`format.ts:232-255`）的 hint 触发条件完全一致：unified + hintId + 实际发生了截断。不引入第二套截断语义。
- 第一行（根路径）始终保留（`kept > 0` 条件确保至少输出 1 行）。
- 小树（`tree.length <= limit`）完整输出，不追加后缀。
- `files_modified` 同理。

**D3**: **timeline 不改动**。timeline 只展示 `📖N ✏️N` 计数，这是正确的——timeline 的职责是概览，不是展示详情。需要看具体文件时用 recall expanded。

---

## 不做的事

- 不改 timeline hook 的渲染格式
- 不改 `renderFileTree` 的核心逻辑（已在 obs-compression 中实现和测试）
- 不改 collapsed depth 的渲染（collapsed 只显示 `📖N` 计数）

---

## 实现任务

### Task 1: 提取 `renderFileTree` 到 `src/shared/file-tree.ts`

**文件**:
- 新建: `src/shared/file-tree.ts`
- 修改: `src/worker/processors.ts`

从 `processors.ts` 移出以下函数到新文件：
- `commonPathPrefix` (~20 行)
- `FileTreeNode` 类型 + `createFileTreeNode` (~10 行)
- `renderTreeNode` (~20 行)
- `renderFileTree` (~50 行)

`processors.ts` 改为 `import { renderFileTree } from "../shared/file-tree"`，删除原始定义。保留 `import path from "node:path"` 如果 processors 其他地方仍在用，否则也删除。

### Task 2: recall 渲染改用 `renderFileTree`

**文件**: `src/mcp/format.ts`

1. 添加 `import { renderFileTree } from "../shared/file-tree"`
2. 替换 `formatTurnExpandedWithMode` 中 lines 661-682 的 `files_read` / `files_modified` 渲染逻辑，使用 D2 描述的 line-aware 截断

### Task 3: 测试

**文件**:
- 修改: `tests/mcp/format.test.ts` — 渲染契约的主测试面，必须覆盖
- 修改: `tests/worker/processors.test.ts` — 验证 import 路径变更后 batch prompt 不变
- 可选新增: `tests/shared/file-tree.test.ts` — 如果从 processors.test.ts 中拆出独立的 renderFileTree 测试

`tests/mcp/format.test.ts` 是直接锁住 recall 渲染行为的单元测试（line 308 "uses the global truncate option at all depths"、line 159-212 的 expanded turn 结构断言）。实现时必须：

1. 更新 expanded turn 的断言：有 filesRead 的 turn 输出从 `files_read: path1, path2` 变为树形多行格式
2. 新增 truncate 与树形输出的交互测试：验证大文件树受 truncate 限制后产生 `... +N lines` 后缀
3. 确认 collapsed depth 不受影响（仍只显示 `📖N` 计数）

---

## Test Cases

1. `renderFileTree` 从 `shared/file-tree` import 后功能不变（现有 processors 测试通过）
2. `processors.ts` 通过 `shared/file-tree` 调用 `renderFileTree` 后 batch prompt 输出不变
3. recall expanded turn 的 `files_read` 渲染为树形格式而非逗号分隔
4. recall expanded turn 的 `files_modified` 渲染为树形格式
5. recall collapsed turn 仍只显示 `📖N ✏️N` 计数
6. recall expanded 单文件 turn 的 `files_read` 渲染为单行路径（不展开树）
7. recall expanded 空 `filesRead` 时不渲染 `files_read` 行（保持现有行为）
8. 树形输出超过 truncate 预算时，按整行截断并追加 `... +N lines` 后缀
9. 树形输出超过 truncate 预算且在 unified mode 时，截断后缀包含 mnemo-replay hint
10. 树形输出在 truncate 预算内时完整输出，无截断后缀
11. `tests/mcp/format.test.ts:308` 的全局 truncate 契约测试继续通过
