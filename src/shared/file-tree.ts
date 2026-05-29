import path from "node:path";

interface FileTreeNode {
  files: string[];
  dirs: Map<string, FileTreeNode>;
}

function createFileTreeNode(): FileTreeNode {
  return { files: [], dirs: new Map() };
}

export function commonPathPrefix(paths: string[]): string {
  if (paths.length === 0) {
    return "";
  }
  if (paths.length === 1) {
    return paths[0] ?? "";
  }

  const allAbsolute = paths.every((value) => value.startsWith("/"));
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
    return allAbsolute ? "/" : ".";
  }

  const joined = common.join("/");
  return allAbsolute ? `/${joined}` : joined;
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

// A content (file) line never ends with "/"; structural (directory) lines and
// the root prefix line do. The root prefix is line 0, which is not a file.
function isFileLine(line: string, index: number): boolean {
  return index > 0 && !line.endsWith("/");
}

// Truncate the rendered tree to <= maxChars, appending "...(+N more files)"
// where N is the number of files dropped. Kept lines plus the worst-case
// suffix always fit, so the cap holds by construction (D2).
function capRenderedTree(
  lines: string[],
  totalFiles: number,
  maxChars: number,
): string {
  const suffixBudget = `\n  ...(+${totalFiles} more files)`.length;
  const lineBudget = Math.max(0, maxChars - suffixBudget);

  const kept: string[] = [];
  let keptFiles = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const candidate = kept.length === 0 ? line : `${kept.join("\n")}\n${line}`;
    if (candidate.length > lineBudget) {
      break;
    }
    kept.push(line);
    if (isFileLine(line, index)) {
      keptFiles += 1;
    }
  }

  const omitted = totalFiles - keptFiles;
  if (omitted <= 0) {
    return lines.join("\n");
  }
  return `${kept.join("\n")}\n  ...(+${omitted} more files)`;
}

export function renderFileTree(
  paths: string[],
  opts?: { maxChars?: number },
): string {
  const uniquePaths = [...new Set(paths.filter((value) => value.trim() !== ""))].sort(
    (left, right) => left.localeCompare(right),
  );
  if (uniquePaths.length === 0) {
    return "(none)";
  }

  if (uniquePaths.length === 1) {
    const only = uniquePaths[0] ?? "(none)";
    // Honor the maxChars contract even for a single (pathologically long) path.
    if (opts?.maxChars !== undefined && only.length > opts.maxChars) {
      const marker = "...";
      return `${only.slice(0, Math.max(0, opts.maxChars - marker.length))}${marker}`;
    }
    return only;
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

  const rendered = lines.join("\n");
  if (opts?.maxChars !== undefined && rendered.length > opts.maxChars) {
    return capRenderedTree(lines, uniquePaths.length, opts.maxChars);
  }
  return rendered;
}

