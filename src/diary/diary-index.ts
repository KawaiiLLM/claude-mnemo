interface OpenFence {
  marker: "`" | "~";
  length: number;
}

const openingFence = (line: string): OpenFence | null => {
  const run = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
  return run
    ? { marker: run[0] as OpenFence["marker"], length: run.length }
    : null;
};

const closesFence = (line: string, fence: OpenFence): boolean => {
  const run = /^ {0,3}(`+|~+)[ \t]*$/.exec(line)?.[1];
  return Boolean(
    run && run[0] === fence.marker && run.length >= fence.length,
  );
};

function datedDiaryIndexLines(
  lines: readonly string[],
): Array<{ line: string; date: string; order: number; lineIndex: number }> {
  const entries: Array<{
    line: string;
    date: string;
    order: number;
    lineIndex: number;
  }> = [];
  let fence: OpenFence | null = null;
  let inDiaryIndex = false;

  lines.forEach((line, lineIndex) => {
    if (fence) {
      if (closesFence(line, fence)) fence = null;
      return;
    }
    const nextFence = openingFence(line);
    if (nextFence) {
      fence = nextFence;
      return;
    }
    const heading = /^ {0,3}(#{1,6})[ \t]+(.*)$/.exec(line);
    if (heading) {
      if (heading[1] === "#") inDiaryIndex = heading[2]!.trim() === "Diary Index";
      return;
    }
    if (!inDiaryIndex) return;
    const date = /^-\s+(\d{4}-\d{2}-\d{2})(?:：|:)/.exec(line)?.[1];
    if (date) entries.push({ line, date, order: entries.length, lineIndex });
  });

  return entries;
}

export function sortDiaryIndexRecentFirst(document: string): string {
  const hasTrailingNewline = document.endsWith("\n");
  const lines = document.replaceAll("\r\n", "\n").split("\n");
  if (hasTrailingNewline) lines.pop();
  const entries = datedDiaryIndexLines(lines);
  const entryLineIndexes = new Set(entries.map((entry) => entry.lineIndex));
  const blocks = entries.map((entry) => {
    let endLineIndex = entry.lineIndex + 1;
    while (
      endLineIndex < lines.length &&
      !entryLineIndexes.has(endLineIndex) &&
      (lines[endLineIndex]!.trim() === "" || /^[ \t]+/.test(lines[endLineIndex]!))
    ) {
      endLineIndex += 1;
    }
    return {
      ...entry,
      lines: lines.slice(entry.lineIndex, endLineIndex),
      endLineIndex,
    };
  });
  const sortedBlocks = blocks
    .slice()
    .sort((left, right) =>
      right.date.localeCompare(left.date) || left.order - right.order
    );
  const blocksByStart = new Map(
    blocks.map((block) => [block.lineIndex, block]),
  );
  const sorted: string[] = [];
  let sortedIndex = 0;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const originalBlock = blocksByStart.get(lineIndex);
    if (!originalBlock) {
      sorted.push(lines[lineIndex]!);
      continue;
    }
    sorted.push(...sortedBlocks[sortedIndex++]!.lines);
    lineIndex = originalBlock.endLineIndex - 1;
  }
  return `${sorted.join("\n")}${hasTrailingNewline ? "\n" : ""}`;
}
