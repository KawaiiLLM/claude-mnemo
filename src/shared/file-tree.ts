import path from "node:path";

interface FileTreeNode {
  files: string[];
  dirs: Map<string, FileTreeNode>;
}

function createFileTreeNode(): FileTreeNode {
  return { files: [], dirs: new Map() };
}

function commonPathPrefix(paths: string[]): string {
  if (paths.length === 0) {
    return "";
  }
  if (paths.length === 1) {
    return paths[0] ?? "";
  }

  const splitPaths = paths.map((value) => value.split("/").filter(Boolean));
  const common: string[] = [];
  const limit = Math.min(...splitPaths.map((segments) => segments.length));

  for (let index = 0; index < limit; index += 1) {
    const segment = splitPaths[0]?.[index];
    if (!segment || splitPaths.some((segments) => segments[index] !== segment)) {
      break;
    }
    common.push(segment);
  }

  if (common.length === 0) {
    return "/";
  }

  return `/${common.join("/")}`;
}

function renderTreeNode(
  name: string,
  node: FileTreeNode,
  indent: string,
): string[] {
  if (node.files.length === 1 && node.dirs.size === 0) {
    return [`${indent}${name}/${node.files[0]}`];
  }

  if (node.files.length === 0 && node.dirs.size > 0) {
    const childEntries = [...node.dirs.entries()].sort(([left], [right]) =>
      left.localeCompare(right),
    );
    return childEntries.flatMap(([childName, childNode]) =>
      renderTreeNode(`${name}/${childName}`, childNode, indent),
    );
  }

  const lines = [`${indent}${name}/`];
  for (const file of [...node.files].sort((left, right) => left.localeCompare(right))) {
    lines.push(`${indent}  ${file}`);
  }
  for (const [childName, childNode] of [...node.dirs.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    lines.push(...renderTreeNode(childName, childNode, `${indent}  `));
  }
  return lines;
}

export function renderFileTree(paths: string[]): string {
  const uniquePaths = [...new Set(paths.filter((value) => value.trim() !== ""))].sort(
    (left, right) => left.localeCompare(right),
  );
  if (uniquePaths.length === 0) {
    return "(none)";
  }

  if (uniquePaths.length === 1) {
    return uniquePaths[0] ?? "(none)";
  }

  const root = commonPathPrefix(uniquePaths);
  const tree = createFileTreeNode();

  for (const value of uniquePaths) {
    const relative = path.posix.relative(root, value);
    if (!relative || relative === "") {
      continue;
    }

    const segments = relative.split("/").filter(Boolean);
    if (segments.length === 0) {
      continue;
    }

    let node = tree;
    for (let index = 0; index < segments.length - 1; index += 1) {
      const segment = segments[index]!;
      let next = node.dirs.get(segment);
      if (!next) {
        next = createFileTreeNode();
        node.dirs.set(segment, next);
      }
      node = next;
    }
    node.files.push(segments[segments.length - 1]!);
  }

  const lines = [root];
  for (const file of [...tree.files].sort((left, right) => left.localeCompare(right))) {
    lines.push(file);
  }
  for (const [childName, childNode] of [...tree.dirs.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    lines.push(...renderTreeNode(childName, childNode, ""));
  }
  return lines.join("\n");
}

