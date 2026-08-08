/** Plain-text tables for the P1 metrics CLI. */

export type Cell = string | number | null;

export interface TableSpec {
  headers: string[];
  rows: Cell[][];
  /** Column indexes rendered right-aligned; defaults to every numeric column. */
  rightAlign?: number[];
}

function displayWidth(text: string): number {
  // Labels are ASCII by construction; count code points so an accidental
  // non-ASCII label degrades to slight misalignment rather than a crash.
  return Array.from(text).length;
}

function toText(cell: Cell): string {
  if (cell === null) {
    return "—";
  }
  return typeof cell === "number" ? String(cell) : cell;
}

export function renderTable(spec: TableSpec): string {
  const body = spec.rows.map((row) => row.map(toText));
  const widths = spec.headers.map((header, column) =>
    Math.max(
      displayWidth(header),
      ...body.map((row) => displayWidth(row[column] ?? "")),
    ),
  );

  const rightAlign = new Set(
    spec.rightAlign ??
      spec.headers.map((_, column) => column).filter((column) =>
        spec.rows.every((row) => {
          const cell = row[column];
          return cell === null || typeof cell === "number";
        }),
      ),
  );

  const pad = (text: string, column: number): string => {
    const padding = " ".repeat(Math.max(0, widths[column]! - displayWidth(text)));
    return rightAlign.has(column) ? padding + text : text + padding;
  };

  const lines = [
    spec.headers.map((header, column) => pad(header, column)).join("  "),
    widths.map((width) => "-".repeat(width)).join("  "),
    ...body.map((row) =>
      row.map((cell, column) => pad(cell, column)).join("  "),
    ),
  ];

  return lines.map((line) => line.trimEnd()).join("\n");
}
